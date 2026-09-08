package relay

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/relay/channel"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/types"

	"github.com/gin-gonic/gin"
)

func responsesViaChatCompletions(c *gin.Context, info *relaycommon.RelayInfo, adaptor channel.Adaptor, request *dto.OpenAIResponsesRequest) (*dto.Usage, *types.NewAPIError) {
	if request == nil {
		return nil, types.NewError(fmt.Errorf("request is nil"), types.ErrorCodeInvalidRequest, types.ErrOptionWithSkipRetry())
	}

	chatReq, err := service.ResponsesRequestToChatCompletionsRequest(*request)
	if err != nil {
		return nil, types.NewErrorWithStatusCode(err, types.ErrorCodeInvalidRequest, http.StatusBadRequest, types.ErrOptionWithSkipRetry())
	}
	info.AppendRequestConversion(types.RelayFormatOpenAI)

	savedRelayMode := info.RelayMode
	savedRequestURLPath := info.RequestURLPath
	defer func() {
		info.RelayMode = savedRelayMode
		info.RequestURLPath = savedRequestURLPath
	}()

	info.RelayMode = relayconstant.RelayModeChatCompletions
	info.RequestURLPath = "/v1/chat/completions"

	convertedRequest, err := adaptor.ConvertOpenAIRequest(c, info, chatReq)
	if err != nil {
		return nil, types.NewError(err, types.ErrorCodeConvertRequestFailed, types.ErrOptionWithSkipRetry())
	}
	relaycommon.AppendRequestConversionFromRequest(info, convertedRequest)

	jsonData, err := common.Marshal(convertedRequest)
	if err != nil {
		return nil, types.NewError(err, types.ErrorCodeConvertRequestFailed, types.ErrOptionWithSkipRetry())
	}

	jsonData, err = relaycommon.RemoveDisabledFields(jsonData, info.ChannelOtherSettings, info.ChannelSetting.PassThroughBodyEnabled)
	if err != nil {
		return nil, types.NewError(err, types.ErrorCodeConvertRequestFailed, types.ErrOptionWithSkipRetry())
	}

	if len(info.ParamOverride) > 0 {
		jsonData, err = relaycommon.ApplyParamOverrideWithRelayInfo(jsonData, info)
		if err != nil {
			return nil, newAPIErrorFromParamOverride(err)
		}
	}
	captureResponsesChatPayload(c, "request", jsonData)

	body, size, closer, err := relaycommon.NewOutboundJSONBody(jsonData)
	if err != nil {
		return nil, types.NewError(err, types.ErrorCodeConvertRequestFailed, types.ErrOptionWithSkipRetry())
	}
	defer closer.Close()
	info.UpstreamRequestBodySize = size

	resp, err := adaptor.DoRequest(c, info, body)
	if err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeDoRequestFailed, http.StatusInternalServerError)
	}
	if resp == nil {
		return nil, types.NewOpenAIError(nil, types.ErrorCodeBadResponse, http.StatusInternalServerError)
	}

	httpResp := resp.(*http.Response)
	statusCodeMappingStr := c.GetString("status_code_mapping")
	if httpResp.StatusCode != http.StatusOK {
		newApiErr := service.RelayErrorHandler(c.Request.Context(), httpResp, false)
		service.ResetStatusCode(newApiErr, statusCodeMappingStr)
		return nil, newApiErr
	}

	upstreamIsStream := chatRequestWantsStream(convertedRequest) || strings.HasPrefix(httpResp.Header.Get("Content-Type"), "text/event-stream")
	if upstreamIsStream {
		usage, newApiErr := chatCompletionsStreamToResponsesHandler(c, info, httpResp)
		if newApiErr != nil {
			service.ResetStatusCode(newApiErr, statusCodeMappingStr)
			return nil, newApiErr
		}
		return usage, nil
	}

	usage, newApiErr := chatCompletionsToResponsesHandler(c, info, httpResp)
	if newApiErr != nil {
		service.ResetStatusCode(newApiErr, statusCodeMappingStr)
		return nil, newApiErr
	}
	return usage, nil
}

func chatRequestWantsStream(request any) bool {
	switch req := request.(type) {
	case dto.GeneralOpenAIRequest:
		return req.Stream != nil && *req.Stream
	case *dto.GeneralOpenAIRequest:
		return req != nil && req.Stream != nil && *req.Stream
	default:
		return false
	}
}

func chatCompletionsToResponsesHandler(c *gin.Context, info *relaycommon.RelayInfo, resp *http.Response) (*dto.Usage, *types.NewAPIError) {
	defer service.CloseResponseBodyGracefully(resp)

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeReadResponseBodyFailed, http.StatusInternalServerError)
	}

	var chatResp dto.OpenAITextResponse
	if err := common.Unmarshal(body, &chatResp); err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
	}
	if oaiErr := chatResp.GetOpenAIError(); oaiErr != nil && oaiErr.Type != "" {
		return nil, types.WithOpenAIError(*oaiErr, resp.StatusCode)
	}

	usage := chatResp.Usage
	if usage.PromptTokens == 0 && usage.InputTokens != 0 {
		usage.PromptTokens = usage.InputTokens
	}
	if usage.CompletionTokens == 0 && usage.OutputTokens != 0 {
		usage.CompletionTokens = usage.OutputTokens
	}
	if usage.TotalTokens == 0 {
		usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
	}
	if usage.InputTokens == 0 {
		usage.InputTokens = usage.PromptTokens
	}
	if usage.OutputTokens == 0 {
		usage.OutputTokens = usage.CompletionTokens
	}

	text := chatResponseText(&chatResp)
	if usage.TotalTokens == 0 {
		localUsage := service.ResponseText2Usage(c, text, info.UpstreamModelName, info.GetEstimatePromptTokens())
		usage = *localUsage
		usage.InputTokens = usage.PromptTokens
		usage.OutputTokens = usage.CompletionTokens
	}

	toolCalls := extractToolCallsFromChat(&chatResp)
	responsesResp := buildResponsesFromChat(c, info, text, toolCalls, &usage)
	responseBody, err := common.Marshal(responsesResp)
	if err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeJsonMarshalFailed, http.StatusInternalServerError)
	}

	jsonResp := *resp
	jsonResp.Header = resp.Header.Clone()
	jsonResp.Header.Set("Content-Type", "application/json")
	service.IOCopyBytesGracefully(c, &jsonResp, responseBody)
	return &usage, nil
}

func chatCompletionsStreamToResponsesHandler(c *gin.Context, info *relaycommon.RelayInfo, resp *http.Response) (*dto.Usage, *types.NewAPIError) {
	if resp == nil || resp.Body == nil {
		return nil, types.NewOpenAIError(nil, types.ErrorCodeBadResponse, http.StatusInternalServerError)
	}
	defer service.CloseResponseBodyGracefully(resp)

	helper.SetEventStreamHeaders(c)

	responseID := strings.Replace(helper.GetResponseID(c), "chatcmpl-", "resp_", 1)
	messageID := strings.Replace(helper.GetResponseID(c), "chatcmpl-", "msg_", 1)
	now := int(time.Now().Unix())
	model := info.UpstreamModelName
	if model == "" {
		model = info.OriginModelName
	}

	usage := &dto.Usage{}
	var outputText strings.Builder
	sentCreated := false
	sentOutputItem := false
	// emittedOrder records the order in which output items first appeared in
	// the upstream stream. The final response.Output array and the done-event
	// sequence are both rebuilt from this slice so that they stay consistent
	// with the SSE output_index values, regardless of which item type came
	// first.
	type emittedKind int
	const (
		emittedMessage emittedKind = iota
		emittedToolCall
	)
	type emittedEntry struct {
		kind  emittedKind
		tcIdx int // valid only when kind == emittedToolCall
	}
	emittedOrder := make([]emittedEntry, 0)
	// nextOutputIndex is the running counter that assigns each emitted output
	// item its `output_index`. It is shared by the message item and the
	// function_call items so that the SSE output_index matches the position
	// in the final Output list, regardless of which item type appeared first.
	nextOutputIndex := 0
	messageOutputIndex := 0
	sendCreated := func() {
		if sentCreated {
			return
		}
		writeResponsesEvent(c, "response.created", gin.H{
			"type": "response.created",
			"response": dto.OpenAIResponsesResponse{
				ID:                responseID,
				Object:            "response",
				CreatedAt:         now,
				Status:            json.RawMessage(`"in_progress"`),
				Model:             model,
				ParallelToolCalls: true,
				Store:             false,
				Output:            []dto.ResponsesOutput{},
				Usage:             nil,
			},
		})
		sentCreated = true
	}
	buildOutputItem := func(status string, text string) dto.ResponsesOutput {
		return dto.ResponsesOutput{
			Type:   "message",
			ID:     messageID,
			Status: status,
			Role:   "assistant",
			Content: []dto.ResponsesOutputContent{
				{Type: "output_text", Text: text},
			},
		}
	}
	sendOutputItemStart := func() {
		if sentOutputItem {
			return
		}
		sendCreated()
		messageOutputIndex = nextOutputIndex
		nextOutputIndex++
		emittedOrder = append(emittedOrder, emittedEntry{kind: emittedMessage})
		writeResponsesEvent(c, "response.output_item.added", gin.H{
			"type":         "response.output_item.added",
			"output_index": messageOutputIndex,
			"item":         buildOutputItem("in_progress", ""),
		})
		writeResponsesEvent(c, "response.content_part.added", gin.H{
			"type":          "response.content_part.added",
			"item_id":       messageID,
			"output_index":  messageOutputIndex,
			"content_index": 0,
			"part": gin.H{
				"type":        "output_text",
				"text":        "",
				"annotations": []any{},
			},
		})
		sentOutputItem = true
	}

	// Stream-time state for tool_calls. Chat completions sends tool_calls as
	// multiple incremental chunks per call (id/name first, arguments split into
	// pieces). We accumulate per-index and emit Responses API
	// function_call SSE events.
	type streamToolCallState struct {
		accumulated dto.ToolCallResponse
		itemID      string
		itemStarted bool
		outputIndex int
	}
	toolCallStates := make(map[int]*streamToolCallState)
	emitToolCallAdded := func(state *streamToolCallState) {
		sendCreated()
		writeResponsesEvent(c, "response.output_item.added", gin.H{
			"type":         "response.output_item.added",
			"output_index": state.outputIndex,
			"item": dto.ResponsesOutput{
				Type:   "function_call",
				ID:     state.itemID,
				Status: "in_progress",
				CallId: state.accumulated.ID,
				Name:   state.accumulated.Function.Name,
			},
		})
		state.itemStarted = true
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, helper.InitialScannerBufferSize), helper.DefaultMaxScannerBufferSize)
	for scanner.Scan() {
		data, ok := helper.NormalizeSSEDataLine(scanner.Text())
		if !ok {
			continue
		}
		if strings.HasPrefix(data, "[DONE]") {
			break
		}
		captureResponsesChatText(c, "stream", data)

		var chunk dto.ChatCompletionsStreamResponse
		if err := common.UnmarshalJsonStr(data, &chunk); err != nil {
			return nil, types.NewOpenAIError(err, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
		}
		if chunk.Model != "" {
			model = chunk.Model
		}
		if chunk.Usage != nil && chunk.Usage.TotalTokens != 0 {
			usage = chunk.Usage
		}
		for _, choice := range chunk.Choices {
			if delta := choice.Delta.GetContentString(); delta != "" {
				sendOutputItemStart()
				outputText.WriteString(delta)
				writeResponsesEvent(c, "response.output_text.delta", gin.H{
					"type":          "response.output_text.delta",
					"item_id":       messageID,
					"output_index":  messageOutputIndex,
					"content_index": 0,
					"delta":         delta,
				})
			}
			for _, tc := range choice.Delta.ToolCalls {
				if tc.Index == nil {
					continue
				}
				idx := *tc.Index
				state, exists := toolCallStates[idx]
				if !exists {
					state = &streamToolCallState{
						itemID:      fmt.Sprintf("fc_%s_%d", messageID, idx),
						outputIndex: nextOutputIndex,
					}
					nextOutputIndex++
					toolCallStates[idx] = state
					emittedOrder = append(emittedOrder, emittedEntry{kind: emittedToolCall, tcIdx: idx})
				}
				if tc.ID != "" {
					state.accumulated.ID = tc.ID
				}
				if tc.Function.Name != "" {
					state.accumulated.Function.Name = tc.Function.Name
				}
				if tc.Function.Arguments != "" {
					state.accumulated.Function.Arguments += tc.Function.Arguments
				}
				if !state.itemStarted {
					emitToolCallAdded(state)
				}
				if tc.Function.Arguments != "" {
					writeResponsesEvent(c, "response.function_call_arguments.delta", gin.H{
						"type":         "response.function_call_arguments.delta",
						"item_id":      state.itemID,
						"output_index": state.outputIndex,
						"delta":        tc.Function.Arguments,
					})
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeReadResponseBodyFailed, http.StatusInternalServerError)
	}

	sendCreated()
	text := outputText.String()
	if usage == nil || usage.TotalTokens == 0 {
		usage = service.ResponseText2Usage(c, text, info.UpstreamModelName, info.GetEstimatePromptTokens())
	}
	if usage.InputTokens == 0 {
		usage.InputTokens = usage.PromptTokens
	}
	if usage.OutputTokens == 0 {
		usage.OutputTokens = usage.CompletionTokens
	}

	// Build the final Output list and emit done events in the same order
	// the items were first seen in the stream, so the SSE indices stay
	// consistent with the final array positions.
	outputItems := make([]dto.ResponsesOutput, 0, len(emittedOrder))
	for _, e := range emittedOrder {
		switch e.kind {
		case emittedMessage:
			if !sentOutputItem {
				continue
			}
			msgItem := buildOutputItem("completed", text)
			outputItems = append(outputItems, msgItem)
			writeResponsesEvent(c, "response.output_text.done", gin.H{
				"type":          "response.output_text.done",
				"item_id":       messageID,
				"output_index":  messageOutputIndex,
				"content_index": 0,
				"text":          text,
			})
			writeResponsesEvent(c, "response.content_part.done", gin.H{
				"type":          "response.content_part.done",
				"item_id":       messageID,
				"output_index":  messageOutputIndex,
				"content_index": 0,
				"part": gin.H{
					"type":        "output_text",
					"text":        text,
					"annotations": []any{},
				},
			})
			writeResponsesEvent(c, "response.output_item.done", gin.H{
				"type":         "response.output_item.done",
				"output_index": messageOutputIndex,
				"item":         msgItem,
			})
		case emittedToolCall:
			state := toolCallStates[e.tcIdx]
			if state == nil {
				continue
			}
			item := dto.ResponsesOutput{
				Type:      "function_call",
				ID:        state.itemID,
				Status:    "completed",
				CallId:    state.accumulated.ID,
				Name:      state.accumulated.Function.Name,
				Arguments: responsesFunctionCallArguments(state.accumulated.Function.Arguments),
			}
			outputItems = append(outputItems, item)
			writeResponsesEvent(c, "response.function_call_arguments.done", gin.H{
				"type":         "response.function_call_arguments.done",
				"item_id":      state.itemID,
				"output_index": state.outputIndex,
				"arguments":    state.accumulated.Function.Arguments,
			})
			writeResponsesEvent(c, "response.output_item.done", gin.H{
				"type":         "response.output_item.done",
				"output_index": state.outputIndex,
				"item":         item,
			})
		}
	}

	completed := dto.OpenAIResponsesResponse{
		ID:                responseID,
		Object:            "response",
		CreatedAt:         now,
		Status:            json.RawMessage(`"completed"`),
		Model:             model,
		ParallelToolCalls: true,
		Store:             false,
		Output:            outputItems,
		Usage:             usage,
	}
	writeResponsesEvent(c, "response.completed", gin.H{
		"type":     "response.completed",
		"response": completed,
	})
	helper.Done(c)
	return usage, nil
}

func chatResponseText(resp *dto.OpenAITextResponse) string {
	if resp == nil || len(resp.Choices) == 0 {
		return ""
	}
	var sb strings.Builder
	for _, choice := range resp.Choices {
		sb.WriteString(choice.Message.StringContent())
	}
	return sb.String()
}

func buildResponsesFromChat(c *gin.Context, info *relaycommon.RelayInfo, text string, toolCalls []dto.ResponsesOutput, usage *dto.Usage) dto.OpenAIResponsesResponse {
	model := info.UpstreamModelName
	if model == "" {
		model = info.OriginModelName
	}
	output := []dto.ResponsesOutput{
		{
			Type:   "message",
			ID:     strings.Replace(helper.GetResponseID(c), "chatcmpl-", "msg_", 1),
			Status: "completed",
			Role:   "assistant",
			Content: []dto.ResponsesOutputContent{
				{Type: "output_text", Text: text},
			},
		},
	}
	if len(toolCalls) > 0 {
		output = append(output, toolCalls...)
	}
	return dto.OpenAIResponsesResponse{
		ID:                strings.Replace(helper.GetResponseID(c), "chatcmpl-", "resp_", 1),
		Object:            "response",
		CreatedAt:         int(time.Now().Unix()),
		Status:            json.RawMessage(`"completed"`),
		Model:             model,
		ParallelToolCalls: true,
		Store:             false,
		Output:            output,
		Usage:             usage,
	}
}

// extractToolCallsFromChat parses the Message-level ToolCalls (a json.RawMessage)
// on each chat completion choice and converts them into Responses API
// function_call output items. If a choice has no ToolCalls or they fail to
// parse, an empty slice is returned for that choice.
func extractToolCallsFromChat(resp *dto.OpenAITextResponse) []dto.ResponsesOutput {
	if resp == nil || len(resp.Choices) == 0 {
		return nil
	}
	var out []dto.ResponsesOutput
	for _, choice := range resp.Choices {
		if len(choice.Message.ToolCalls) == 0 {
			continue
		}
		var calls []dto.ToolCallResponse
		if err := common.Unmarshal(choice.Message.ToolCalls, &calls); err != nil {
			continue
		}
		for _, tc := range calls {
			args := tc.Function.Arguments
			item := dto.ResponsesOutput{
				Type:      "function_call",
				ID:        tc.ID,
				Status:    "completed",
				CallId:    tc.ID,
				Name:      tc.Function.Name,
				Arguments: responsesFunctionCallArguments(args),
			}
			out = append(out, item)
		}
	}
	return out
}

func responsesFunctionCallArguments(arguments string) json.RawMessage {
	raw, err := common.Marshal(arguments)
	if err != nil {
		return json.RawMessage(`""`)
	}
	return raw
}

func captureResponsesChatPayload(c *gin.Context, suffix string, payload []byte) {
	if os.Getenv("RESPONSES_CHAT_CAPTURE") != "true" {
		return
	}
	_ = os.MkdirAll("/data/captures", 0755)
	requestID := c.GetString(common.RequestIdKey)
	if requestID == "" {
		requestID = fmt.Sprintf("%d", time.Now().UnixNano())
	}
	path := filepath.Join("/data/captures", fmt.Sprintf("responses-chat-%s-%s.json", requestID, suffix))
	_ = os.WriteFile(path, payload, 0600)
}

func captureResponsesChatText(c *gin.Context, suffix string, text string) {
	if os.Getenv("RESPONSES_CHAT_CAPTURE") != "true" {
		return
	}
	_ = os.MkdirAll("/data/captures", 0755)
	requestID := c.GetString(common.RequestIdKey)
	if requestID == "" {
		requestID = fmt.Sprintf("%d", time.Now().UnixNano())
	}
	path := filepath.Join("/data/captures", fmt.Sprintf("responses-chat-%s-%s.ndjson", requestID, suffix))
	_ = appendFile(path, []byte(text+"\n"))
}

func appendFile(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(data)
	return err
}

func writeResponsesEvent(c *gin.Context, event string, payload any) {
	data, err := common.Marshal(payload)
	if err != nil {
		return
	}
	c.Render(-1, common.CustomEvent{Data: fmt.Sprintf("event: %s\n", event)})
	c.Render(-1, common.CustomEvent{Data: "data: " + string(data)})
	_ = helper.FlushWriter(c)
}
