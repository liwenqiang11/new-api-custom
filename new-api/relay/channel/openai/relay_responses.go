package openai

import (
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
	"github.com/QuantumNous/new-api/logger"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/types"

	"github.com/gin-gonic/gin"
)

func OaiResponsesHandler(c *gin.Context, info *relaycommon.RelayInfo, resp *http.Response) (*dto.Usage, *types.NewAPIError) {
	defer service.CloseResponseBodyGracefully(resp)

	// read response body
	var responsesResponse dto.OpenAIResponsesResponse
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeReadResponseBodyFailed, http.StatusInternalServerError)
	}
	err = common.Unmarshal(responseBody, &responsesResponse)
	if err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
	}
	if oaiError := responsesResponse.GetOpenAIError(); oaiError != nil && oaiError.Type != "" {
		return nil, types.WithOpenAIError(*oaiError, resp.StatusCode)
	}

	if responsesResponse.HasImageGenerationCall() {
		c.Set("image_generation_call", true)
		c.Set("image_generation_call_quality", responsesResponse.GetQuality())
		c.Set("image_generation_call_size", responsesResponse.GetSize())
	}

	// 写入新的 response body
	service.IOCopyBytesGracefully(c, resp, responseBody)

	// compute usage
	usage := dto.Usage{}
	if responsesResponse.Usage != nil {
		usage.PromptTokens = responsesResponse.Usage.InputTokens
		usage.CompletionTokens = responsesResponse.Usage.OutputTokens
		usage.TotalTokens = responsesResponse.Usage.TotalTokens
		if responsesResponse.Usage.InputTokensDetails != nil {
			usage.PromptTokensDetails.CachedTokens = responsesResponse.Usage.InputTokensDetails.CachedTokens
		}
	}
	if info == nil || info.ResponsesUsageInfo == nil || info.ResponsesUsageInfo.BuiltInTools == nil {
		return &usage, nil
	}
	// 解析 Tools 用量
	for _, tool := range responsesResponse.Tools {
		buildToolinfo, ok := info.ResponsesUsageInfo.BuiltInTools[common.Interface2String(tool["type"])]
		if !ok || buildToolinfo == nil {
			logger.LogError(c, fmt.Sprintf("BuiltInTools not found for tool type: %v", tool["type"]))
			continue
		}
		buildToolinfo.CallCount++
	}
	return &usage, nil
}

func OaiResponsesStreamHandler(c *gin.Context, info *relaycommon.RelayInfo, resp *http.Response) (*dto.Usage, *types.NewAPIError) {
	if resp == nil || resp.Body == nil {
		logger.LogError(c, "invalid response or response body")
		return nil, types.NewError(fmt.Errorf("invalid response"), types.ErrorCodeBadResponse)
	}

	defer service.CloseResponseBodyGracefully(resp)

	var usage = &dto.Usage{}
	var responseTextBuilder strings.Builder
	terminalSeen := false
	incompleteSeen := false
	responseID := ""
	createdAt := 0
	model := ""
	var outputItems []dto.ResponsesOutput

	helper.StreamScannerHandler(c, resp, info, func(data string, sr *helper.StreamResult) {

		// 检查当前数据是否包含 completed 状态和 usage 信息
		var streamResponse dto.ResponsesStreamResponse
		if err := common.UnmarshalJsonStr(data, &streamResponse); err != nil {
			logger.LogError(c, "failed to unmarshal stream response: "+err.Error())
			sr.Error(err)
			return
		}
		if streamResponse.Type == "response.completed" && streamResponse.Response != nil && len(streamResponse.Response.Output) == 0 && len(outputItems) > 0 {
			streamResponse.Response.Output = append([]dto.ResponsesOutput(nil), outputItems...)
			if rewritten, ok := rewriteResponsesCompletedOutput(c, data, outputItems); ok {
				data = rewritten
			}
		}
		captureForwardedResponsesStreamData(c, info, streamResponse, data)
		sendResponsesStreamData(c, streamResponse, data)
		if streamResponse.Response != nil {
			if streamResponse.Response.ID != "" {
				responseID = streamResponse.Response.ID
			}
			if streamResponse.Response.CreatedAt != 0 {
				createdAt = streamResponse.Response.CreatedAt
			}
			if streamResponse.Response.Model != "" {
				model = streamResponse.Response.Model
			}
			if isResponsesStatusIncomplete(streamResponse.Response.Status) {
				incompleteSeen = true
			}
			if len(streamResponse.Response.Output) > 0 {
				outputItems = append([]dto.ResponsesOutput(nil), streamResponse.Response.Output...)
				if responsesOutputHasStatus(outputItems, "incomplete") {
					incompleteSeen = true
				}
			}
		}
		switch streamResponse.Type {
		case "response.completed":
			terminalSeen = true
			if streamResponse.Response != nil {
				applyResponsesUsage(usage, streamResponse.Response.Usage)
				if streamResponse.Response.HasImageGenerationCall() {
					c.Set("image_generation_call", true)
					c.Set("image_generation_call_quality", streamResponse.Response.GetQuality())
					c.Set("image_generation_call_size", streamResponse.Response.GetSize())
				}
			}
		case "response.incomplete", "response.failed", "response.cancelled":
			// These are terminal Responses API events too. Do not synthesize a
			// response.completed after them; clients such as Codex rely on the
			// incomplete status to continue after max_output_tokens truncation.
			terminalSeen = true
			if streamResponse.Type == "response.incomplete" {
				incompleteSeen = true
			}
			if streamResponse.Response != nil {
				applyResponsesUsage(usage, streamResponse.Response.Usage)
			}
		case "response.output_text.delta":
			// 处理输出文本
			responseTextBuilder.WriteString(streamResponse.Delta)
		case dto.ResponsesOutputTypeItemDone:
			// 函数调用处理
			if streamResponse.Item != nil {
				outputItems = append(outputItems, *streamResponse.Item)
				if strings.EqualFold(streamResponse.Item.Status, "incomplete") {
					incompleteSeen = true
				}
				switch streamResponse.Item.Type {
				case dto.BuildInCallWebSearchCall:
					if info != nil && info.ResponsesUsageInfo != nil && info.ResponsesUsageInfo.BuiltInTools != nil {
						if webSearchTool, exists := info.ResponsesUsageInfo.BuiltInTools[dto.BuildInToolWebSearchPreview]; exists && webSearchTool != nil {
							webSearchTool.CallCount++
						}
					}
				}
			}
		}
	})

	if usage.CompletionTokens == 0 {
		// 计算输出文本的 token 数量
		tempStr := responseTextBuilder.String()
		if len(tempStr) > 0 {
			// 非正常结束，使用输出文本的 token 数量
			completionTokens := service.CountTextToken(tempStr, info.UpstreamModelName)
			usage.CompletionTokens = completionTokens
		}
	}

	if usage.PromptTokens == 0 && usage.CompletionTokens != 0 {
		usage.PromptTokens = info.GetEstimatePromptTokens()
	}

	usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
	if usage.InputTokens == 0 {
		usage.InputTokens = usage.PromptTokens
	}
	if usage.OutputTokens == 0 {
		usage.OutputTokens = usage.CompletionTokens
	}

	if info.StreamStatus.IsNormalEnd() && !info.StreamStatus.HasErrors() {
		if !terminalSeen {
			if incompleteSeen || shouldSynthesizeIncompleteOnEOF(info, model) {
				emitSyntheticResponsesIncomplete(c, info, usage, responseID, createdAt, model, responseTextBuilder.String(), outputItems)
			} else {
				emitSyntheticResponsesCompleted(c, info, usage, responseID, createdAt, model, responseTextBuilder.String(), outputItems)
			}
		}
		helper.Done(c)
	}

	return usage, nil
}


func captureForwardedResponsesStreamData(c *gin.Context, info *relaycommon.RelayInfo, streamResponse dto.ResponsesStreamResponse, data string) {
	if os.Getenv("RESPONSES_SENT_CAPTURE") != "true" {
		return
	}
	model := ""
	requestID := ""
	if info != nil {
		model = info.UpstreamModelName
		if model == "" {
			model = info.OriginModelName
		}
		requestID = info.RequestId
	}
	filter := strings.TrimSpace(os.Getenv("RESPONSES_SENT_CAPTURE_MODEL"))
	if filter != "" && !strings.Contains(strings.ToLower(model), strings.ToLower(filter)) {
		return
	}
	if requestID == "" {
		requestID = helper.GetResponseID(c)
	}
	if requestID == "" {
		requestID = "unknown"
	}
	_ = os.MkdirAll("/data/captures", 0755)
	payload := map[string]any{
		"ts":         time.Now().Format(time.RFC3339Nano),
		"request_id": requestID,
		"model":      model,
		"type":       streamResponse.Type,
		"data":       data,
	}
	if streamResponse.Response != nil {
		payload["response_status"] = string(streamResponse.Response.Status)
		payload["response_output_len"] = len(streamResponse.Response.Output)
	}
	if streamResponse.Item != nil {
		payload["item_type"] = streamResponse.Item.Type
		payload["item_status"] = streamResponse.Item.Status
		payload["item_id"] = streamResponse.Item.ID
	}
	raw, err := common.Marshal(payload)
	if err != nil {
		return
	}
	path := filepath.Join("/data/captures", fmt.Sprintf("sent-responses-%s-stream.ndjson", requestID))
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(raw, '\n'))
}

func applyResponsesUsage(usage *dto.Usage, responsesUsage *dto.Usage) {
	if usage == nil || responsesUsage == nil {
		return
	}
	if responsesUsage.InputTokens != 0 {
		usage.PromptTokens = responsesUsage.InputTokens
	}
	if responsesUsage.OutputTokens != 0 {
		usage.CompletionTokens = responsesUsage.OutputTokens
	}
	if responsesUsage.TotalTokens != 0 {
		usage.TotalTokens = responsesUsage.TotalTokens
	}
	if responsesUsage.InputTokensDetails != nil {
		usage.PromptTokensDetails.CachedTokens = responsesUsage.InputTokensDetails.CachedTokens
	}
}

func rewriteResponsesCompletedOutput(c *gin.Context, data string, outputItems []dto.ResponsesOutput) (string, bool) {
	var payload map[string]any
	if err := common.UnmarshalJsonStr(data, &payload); err != nil {
		logger.LogError(c, "failed to unmarshal completed response for output backfill: "+err.Error())
		return "", false
	}
	response, ok := payload["response"].(map[string]any)
	if !ok || response == nil {
		return "", false
	}
	response["output"] = outputItems
	rewritten, err := common.Marshal(payload)
	if err != nil {
		logger.LogError(c, "failed to marshal completed response after output backfill: "+err.Error())
		return "", false
	}
	return string(rewritten), true
}


func isResponsesStatusIncomplete(status json.RawMessage) bool {
	if len(status) == 0 {
		return false
	}
	var value string
	if err := json.Unmarshal(status, &value); err == nil {
		return strings.EqualFold(value, "incomplete")
	}
	return strings.Contains(strings.ToLower(string(status)), "incomplete")
}

func responsesOutputHasStatus(outputItems []dto.ResponsesOutput, status string) bool {
	for _, item := range outputItems {
		if strings.EqualFold(item.Status, status) {
			return true
		}
	}
	return false
}

func shouldSynthesizeIncompleteOnEOF(info *relaycommon.RelayInfo, model string) bool {
	candidates := []string{model}
	if info != nil {
		candidates = append(candidates, info.UpstreamModelName, info.OriginModelName)
	}
	for _, candidate := range candidates {
		m := strings.ToLower(strings.TrimSpace(candidate))
		if m == "gpt-5.6-sol" {
			return true
		}
	}
	return false
}

func emitSyntheticResponsesIncomplete(c *gin.Context, info *relaycommon.RelayInfo, usage *dto.Usage, responseID string, createdAt int, model string, text string, outputItems []dto.ResponsesOutput) {
	if responseID == "" {
		responseID = strings.Replace(helper.GetResponseID(c), "chatcmpl-", "resp_", 1)
	}
	if createdAt == 0 {
		createdAt = int(time.Now().Unix())
	}
	if model == "" && info != nil {
		model = info.UpstreamModelName
		if model == "" {
			model = info.OriginModelName
		}
	}
	if len(outputItems) == 0 && text != "" {
		outputItems = []dto.ResponsesOutput{
			{
				Type:   "message",
				ID:     strings.Replace(helper.GetResponseID(c), "chatcmpl-", "msg_", 1),
				Status: "incomplete",
				Role:   "assistant",
				Content: []dto.ResponsesOutputContent{
					{Type: "output_text", Text: text},
				},
			},
		}
	}
	if outputItems == nil {
		outputItems = []dto.ResponsesOutput{}
	}
	for i := range outputItems {
		if outputItems[i].Status == "" || strings.EqualFold(outputItems[i].Status, "completed") {
			outputItems[i].Status = "incomplete"
		}
	}

	incomplete := dto.OpenAIResponsesResponse{
		ID:                responseID,
		Object:            "response",
		CreatedAt:         createdAt,
		Status:            json.RawMessage(`"incomplete"`),
		IncompleteDetails: &dto.IncompleteDetails{Reason: "max_output_tokens"},
		Model:             model,
		ParallelToolCalls: true,
		Store:             false,
		Output:            outputItems,
		Usage:             usage,
	}
	payload := gin.H{
		"type":     "response.incomplete",
		"response": incomplete,
	}
	data, err := common.Marshal(payload)
	if err != nil {
		logger.LogError(c, "failed to marshal synthetic response.incomplete: "+err.Error())
		return
	}
	helper.ResponseChunkData(c, dto.ResponsesStreamResponse{Type: "response.incomplete"}, string(data))
}

func emitSyntheticResponsesCompleted(c *gin.Context, info *relaycommon.RelayInfo, usage *dto.Usage, responseID string, createdAt int, model string, text string, outputItems []dto.ResponsesOutput) {
	if responseID == "" {
		responseID = strings.Replace(helper.GetResponseID(c), "chatcmpl-", "resp_", 1)
	}
	if createdAt == 0 {
		createdAt = int(time.Now().Unix())
	}
	if model == "" && info != nil {
		model = info.UpstreamModelName
		if model == "" {
			model = info.OriginModelName
		}
	}
	if len(outputItems) == 0 && text != "" {
		outputItems = []dto.ResponsesOutput{
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
	}
	if outputItems == nil {
		outputItems = []dto.ResponsesOutput{}
	}

	completed := dto.OpenAIResponsesResponse{
		ID:                responseID,
		Object:            "response",
		CreatedAt:         createdAt,
		Status:            json.RawMessage(`"completed"`),
		Model:             model,
		ParallelToolCalls: true,
		Store:             false,
		Output:            outputItems,
		Usage:             usage,
	}
	payload := gin.H{
		"type":     "response.completed",
		"response": completed,
	}
	data, err := common.Marshal(payload)
	if err != nil {
		logger.LogError(c, "failed to marshal synthetic response.completed: "+err.Error())
		return
	}
	helper.ResponseChunkData(c, dto.ResponsesStreamResponse{Type: "response.completed"}, string(data))
}
