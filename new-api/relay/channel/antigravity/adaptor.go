package antigravity

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/relay/channel"
	"github.com/QuantumNous/new-api/relay/channel/claude"
	"github.com/QuantumNous/new-api/relay/channel/gemini"
	"github.com/QuantumNous/new-api/relay/channel/openai"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/types"

	"github.com/gin-gonic/gin"
)

type Adaptor struct {
	gemini.Adaptor
}

func (a *Adaptor) Init(info *relaycommon.RelayInfo) {
	a.Adaptor.Init(info)
}

func (a *Adaptor) GetRequestURL(info *relaycommon.RelayInfo) (string, error) {
	if shouldUseManagerPassthrough(info) {
		if info.RelayFormat == types.RelayFormatGemini && info.IsStream && info.RelayMode == relayconstant.RelayModeGemini {
			info.DisablePing = true
		}
		// Manager handles image generation via chat-completions ChatRedirection,
		// not via /v1/images/generations. Rewrite the path so the manager can
		// intercept the model name and route to its image pipeline.
		requestPath := info.RequestURLPath
		if info.RelayMode == relayconstant.RelayModeImagesGenerations || info.RelayMode == relayconstant.RelayModeImagesEdits {
			requestPath = "/v1/chat/completions"
		}
		return relaycommon.GetFullRequestURL(antigravityManagerBaseURL(), requestPath, info.ChannelType), nil
	}

	action := ":generateContent"
	if info.IsStream {
		action = ":streamGenerateContent?alt=sse"
		if info.RelayMode == relayconstant.RelayModeGemini {
			info.DisablePing = true
		}
	}
	return antigravityInternalBaseURL(info.ChannelBaseUrl) + action, nil
}

func (a *Adaptor) ConvertOpenAIResponsesRequest(c *gin.Context, info *relaycommon.RelayInfo, request dto.OpenAIResponsesRequest) (any, error) {
	if shouldUseManagerPassthrough(info) {
		return request, nil
	}
	chatReq, err := responsesRequestToChatCompletions(request)
	if err != nil {
		return nil, err
	}
	return a.ConvertOpenAIRequest(c, info, chatReq)
}

func (a *Adaptor) ConvertGeminiRequest(c *gin.Context, info *relaycommon.RelayInfo, request *dto.GeminiChatRequest) (any, error) {
	if shouldUseManagerPassthrough(info) {
		return request, nil
	}
	return a.Adaptor.ConvertGeminiRequest(c, info, request)
}

func (a *Adaptor) ConvertOpenAIRequest(c *gin.Context, info *relaycommon.RelayInfo, request *dto.GeneralOpenAIRequest) (any, error) {
	if shouldUseManagerPassthrough(info) {
		return request, nil
	}
	return a.Adaptor.ConvertOpenAIRequest(c, info, request)
}

func (a *Adaptor) ConvertClaudeRequest(c *gin.Context, info *relaycommon.RelayInfo, request *dto.ClaudeRequest) (any, error) {
	if shouldUseManagerPassthrough(info) {
		return request, nil
	}
	return a.Adaptor.ConvertClaudeRequest(c, info, request)
}

func (a *Adaptor) ConvertImageRequest(c *gin.Context, info *relaycommon.RelayInfo, request dto.ImageRequest) (any, error) {
	if shouldUseManagerPassthrough(info) {
		// In manager passthrough mode, convert image request to OpenAI chat completions
		// format so the manager can intercept the model name via ChatRedirection.
		chatReq := &dto.GeneralOpenAIRequest{
			Model: info.UpstreamModelName,
			Messages: []dto.Message{
				{
					Role:    "user",
					Content: request.Prompt,
				},
			},
		}
		return chatReq, nil
	}
	return a.Adaptor.ConvertImageRequest(c, info, request)
}

func (a *Adaptor) SetupRequestHeader(c *gin.Context, req *http.Header, info *relaycommon.RelayInfo) error {
	channel.SetupApiRequestHeader(info, c, req)

	if shouldUseManagerPassthrough(info) {
		req.Del("x-goog-api-key")
		req.Del("Authorization")
		key, err := ParseOAuthKey(strings.TrimSpace(info.ApiKey))
		if err != nil {
			return err
		}
		key, err = maybeRefreshAntigravityOAuthKey(c.Request.Context(), key, info)
		if err != nil {
			return err
		}
		encodedKey, err := common.Marshal(key)
		if err != nil {
			return err
		}
		info.ApiKey = string(encodedKey)

		credentialHeader, err := BuildManagerCredentialHeader(info.ApiKey)
		if err != nil {
			return err
		}
		req.Set(managerCredentialsHeader, credentialHeader)
		req.Set(managerChannelScopeHeader, fmt.Sprintf("channel:%d:%s", info.ChannelId, info.UsingGroup))
		if strings.TrimSpace(info.OriginModelName) != "" {
			req.Set(managerRequestedModelHeader, strings.TrimSpace(info.OriginModelName))
		}
		if apiKey := antigravityManagerAPIKey(); apiKey != "" {
			req.Set("Authorization", "Bearer "+apiKey)
		}
		if req.Get("Content-Type") == "" {
			req.Set("Content-Type", "application/json")
		}
		if info.IsStream {
			req.Set("Accept", "text/event-stream")
		} else if req.Get("Accept") == "" {
			req.Set("Accept", "application/json")
		}
		return nil
	}

	key, err := ParseOAuthKey(strings.TrimSpace(info.ApiKey))
	if err != nil {
		return err
	}
	key, err = maybeRefreshAntigravityOAuthKey(c.Request.Context(), key, info)
	if err != nil {
		return err
	}

	req.Del("x-goog-api-key")
	req.Set("Authorization", "Bearer "+strings.TrimSpace(key.AccessToken))
	req.Set("User-Agent", "Antigravity/4.1.32 (X11; Linux x86_64) Chrome/132.0.6834.160 Electron/39.2.3")
	req.Set("x-client-name", "antigravity")
	req.Set("x-client-version", "4.1.32")
	if req.Get("Content-Type") == "" {
		req.Set("Content-Type", "application/json")
	}
	if info.IsStream {
		req.Set("Accept", "text/event-stream")
	} else if req.Get("Accept") == "" {
		req.Set("Accept", "application/json")
	}
	return nil
}

func (a *Adaptor) DoRequest(c *gin.Context, info *relaycommon.RelayInfo, requestBody io.Reader) (any, error) {
	if shouldUseManagerPassthrough(info) {
		return channel.DoApiRequest(a, c, info, requestBody)
	}

	wrappedBody, err := a.wrapInternalRequestBody(c, info, requestBody)
	if err != nil {
		return nil, err
	}
	body, err := io.ReadAll(wrappedBody)
	if err != nil {
		return nil, err
	}

	originalBaseURL := info.ChannelBaseUrl
	defer func() {
		info.ChannelBaseUrl = originalBaseURL
	}()

	var lastErr error
	bases := antigravityInternalBaseURLs(originalBaseURL)
	for index, baseURL := range bases {
		info.ChannelBaseUrl = baseURL
		resp, err := channel.DoApiRequest(a, c, info, bytes.NewReader(body))
		if err != nil {
			lastErr = err
			if index < len(bases)-1 {
				continue
			}
			return nil, err
		}
		retry, logErr := logAndPrepareAntigravityRetry(resp, baseURL, index < len(bases)-1)
		if logErr != nil {
			lastErr = logErr
			if index < len(bases)-1 {
				continue
			}
			return nil, logErr
		}
		if retry {
			continue
		}
		return resp, nil
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, errors.New("antigravity channel: no internal endpoint configured")
}

func (a *Adaptor) DoResponse(c *gin.Context, resp *http.Response, info *relaycommon.RelayInfo) (usage any, err *types.NewAPIError) {
	if shouldUseManagerPassthrough(info) {
		applyAntigravityManagerRoutingHeaders(c, resp, info)
		return doManagerPassthroughResponse(c, resp, info)
	}
	if !info.IsStream {
		if unwrapErr := unwrapAntigravityInternalResponse(resp); unwrapErr != nil {
			return nil, types.NewOpenAIError(unwrapErr, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
		}
	}
	if info.RelayFormat == types.RelayFormatOpenAIResponses || info.RelayFormat == types.RelayFormatOpenAIResponsesCompaction {
		if info.IsStream && info.RelayFormat != types.RelayFormatOpenAIResponsesCompaction {
			return antigravityResponsesStreamHandler(c, resp, info)
		}
		return antigravityResponsesHandler(c, resp, info)
	}
	return a.Adaptor.DoResponse(c, resp, info)
}

type antigravityInternalRequest struct {
	Project            string          `json:"project,omitempty"`
	RequestID          string          `json:"requestId"`
	Request            json.RawMessage `json:"request"`
	Model              string          `json:"model"`
	UserAgent          string          `json:"userAgent"`
	RequestType        string          `json:"requestType"`
	SessionID          string          `json:"sessionId,omitempty"`
	EnabledCreditTypes []string        `json:"enabledCreditTypes,omitempty"`
}

type antigravityInternalResponse struct {
	Response json.RawMessage `json:"response"`
}

func antigravityInternalBaseURL(baseURL string) string {
	bases := antigravityInternalBaseURLs(baseURL)
	if len(bases) == 0 {
		return "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal"
	}
	return bases[0]
}

func antigravityInternalBaseURLs(baseURL string) []string {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" ||
		strings.HasPrefix(baseURL, "{") ||
		strings.Contains(baseURL, "generativelanguage.googleapis.com") ||
		strings.Contains(baseURL, "cloudcode-pa.googleapis.com") {
		return []string{
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal",
			"https://daily-cloudcode-pa.googleapis.com/v1internal",
		}
	}
	if !strings.Contains(baseURL, "/v1internal") {
		baseURL += "/v1internal"
	}
	return []string{baseURL}
}

func logAndPrepareAntigravityRetry(resp *http.Response, baseURL string, canRetry bool) (bool, error) {
	if resp == nil || resp.StatusCode < http.StatusBadRequest || resp.Body == nil {
		return false, nil
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, err
	}
	logBody := string(body)
	if len(logBody) > 1200 {
		logBody = logBody[:1200]
	}
	common.SysError(fmt.Sprintf("antigravity upstream error: endpoint=%s status=%d body=%s", baseURL, resp.StatusCode, logBody))
	if canRetry && antigravityShouldRetryStatus(resp.StatusCode) {
		_ = resp.Body.Close()
		return true, nil
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.ContentLength = int64(len(body))
	return false, nil
}

func antigravityShouldRetryStatus(status int) bool {
	return status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status >= http.StatusInternalServerError
}

func normalizeAntigravityGeminiBody(body []byte, model string) []byte {
	var request dto.GeminiChatRequest
	if err := common.Unmarshal(body, &request); err != nil {
		return body
	}
	applyAntigravityGenerationConstraints(&request, model)
	encoded, err := common.Marshal(request)
	if err != nil {
		return body
	}
	return encoded
}

func applyAntigravityGenerationConstraints(request *dto.GeminiChatRequest, model string) {
	if request == nil || request.GenerationConfig.ThinkingConfig == nil {
		return
	}
	thinkingConfig := request.GenerationConfig.ThinkingConfig
	if thinkingConfig.ThinkingLevel != "" {
		if budget, ok := antigravityThinkingLevelBudget(thinkingConfig.ThinkingLevel); ok {
			thinkingConfig.ThinkingBudget = &budget
		}
		thinkingConfig.ThinkingLevel = ""
	}
	if thinkingConfig.ThinkingBudget == nil {
		return
	}
	budget := *thinkingConfig.ThinkingBudget
	if budget < 0 {
		budget = antigravityThinkingBudgetCap(model)
	}
	cap := antigravityThinkingBudgetCap(model)
	if budget > cap {
		budget = cap
	}
	outputCap := antigravityOutputTokenCap(model)
	if budget >= outputCap {
		budget = outputCap - 1
	}
	if budget < 0 {
		budget = 0
	}
	thinkingConfig.ThinkingBudget = &budget
	if budget > 0 && request.GenerationConfig.MaxOutputTokens != nil && int(*request.GenerationConfig.MaxOutputTokens) <= budget {
		maxOutput := uint(budget + 8192)
		if int(maxOutput) > outputCap {
			maxOutput = uint(outputCap)
		}
		request.GenerationConfig.MaxOutputTokens = &maxOutput
	}
}

func antigravityThinkingLevelBudget(level string) (int, bool) {
	switch strings.ToUpper(strings.TrimSpace(level)) {
	case "NONE":
		return 0, true
	case "LOW":
		return 4096, true
	case "MEDIUM":
		return 8192, true
	case "HIGH":
		return 24576, true
	default:
		return 0, false
	}
}

func antigravityThinkingBudgetCap(model string) int {
	lower := strings.ToLower(strings.TrimSpace(model))
	switch {
	case strings.Contains(lower, "extra-low"):
		return 1024
	case strings.Contains(lower, "low"):
		return 4096
	case strings.Contains(lower, "high"), strings.Contains(lower, "thinking"), strings.Contains(lower, "pro"):
		return 24576
	default:
		return 8192
	}
}

func antigravityOutputTokenCap(model string) int {
	lower := strings.ToLower(strings.TrimSpace(model))
	if strings.Contains(lower, "claude") {
		return 65536
	}
	return 65535
}

func (a *Adaptor) wrapInternalRequestBody(c *gin.Context, info *relaycommon.RelayInfo, requestBody io.Reader) (io.Reader, error) {
	if requestBody == nil {
		return nil, nil
	}
	body, err := io.ReadAll(requestBody)
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return bytes.NewReader(body), nil
	}
	body = normalizeAntigravityGeminiBody(body, info.UpstreamModelName)

	key, err := ParseOAuthKey(strings.TrimSpace(info.ApiKey))
	if err != nil {
		return nil, err
	}
	key, err = maybeRefreshAntigravityOAuthKey(c.Request.Context(), key, info)
	if err != nil {
		return nil, err
	}
	if encoded, err := common.Marshal(key); err == nil {
		info.ApiKey = string(encoded)
	}

	projectID := strings.TrimSpace(key.ProjectID)
	if projectID == "" {
		client, err := service.GetHttpClientWithProxy(strings.TrimSpace(info.ChannelSetting.Proxy))
		if err != nil {
			return nil, err
		}
		if client == nil {
			client = &http.Client{Timeout: antigravityModelFetchTimeout}
		}
		projectID = fetchAntigravityProjectID(c.Request.Context(), client, key.AccessToken)
	}

	requestID := fmt.Sprintf("agent/%d/%s", time.Now().UnixMilli(), strings.TrimPrefix(helper.GetResponseID(c), "chatcmpl-"))
	internal := antigravityInternalRequest{
		Project:            projectID,
		RequestID:          requestID,
		Request:            json.RawMessage(body),
		Model:              info.UpstreamModelName,
		UserAgent:          antigravityUserAgent,
		RequestType:        "generate-content",
		EnabledCreditTypes: []string{"GOOGLE_ONE_AI"},
	}
	if strings.TrimSpace(key.SessionID) != "" {
		internal.SessionID = strings.TrimSpace(key.SessionID)
	}
	encoded, err := common.Marshal(internal)
	if err != nil {
		return nil, err
	}
	info.UpstreamRequestBodySize = int64(len(encoded))
	return bytes.NewReader(encoded), nil
}

func unwrapAntigravityInternalResponse(resp *http.Response) error {
	if resp == nil || resp.Body == nil {
		return nil
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	var wrapped antigravityInternalResponse
	if err := common.Unmarshal(body, &wrapped); err == nil && len(wrapped.Response) > 0 {
		body = wrapped.Response
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.ContentLength = int64(len(body))
	resp.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	return nil
}

func unwrapAntigravityInternalResponseData(data []byte) []byte {
	var wrapped antigravityInternalResponse
	if err := common.Unmarshal(data, &wrapped); err == nil && len(wrapped.Response) > 0 {
		return wrapped.Response
	}
	return data
}

func responsesRequestToChatCompletions(request dto.OpenAIResponsesRequest) (*dto.GeneralOpenAIRequest, error) {
	chatReq := &dto.GeneralOpenAIRequest{
		Model:         request.Model,
		Stream:        request.Stream,
		StreamOptions: request.StreamOptions,
		Temperature:   request.Temperature,
		TopP:          request.TopP,
		Tools:         responsesToolsToChatTools(request.GetToolsMap()),
		ToolChoice:    rawMessageToAny(request.ToolChoice),
		Store:         request.Store,
		Metadata:      request.Metadata,
	}
	if request.MaxOutputTokens != nil {
		chatReq.MaxTokens = request.MaxOutputTokens
	}
	if request.Reasoning != nil {
		chatReq.ReasoningEffort = request.Reasoning.Effort
	}

	if len(request.Instructions) > 0 {
		chatReq.Messages = append(chatReq.Messages, dto.Message{
			Role:    "system",
			Content: normalizeRawContent(request.Instructions),
		})
	}

	inputMessages, err := responsesInputToMessages(request.Input)
	if err != nil {
		return nil, err
	}
	chatReq.Messages = append(chatReq.Messages, inputMessages...)
	if len(chatReq.Messages) == 0 {
		chatReq.Messages = append(chatReq.Messages, dto.Message{
			Role:    "user",
			Content: json.RawMessage(`""`),
		})
	}
	return chatReq, nil
}

func responsesInputToMessages(input json.RawMessage) ([]dto.Message, error) {
	if len(input) == 0 {
		return nil, nil
	}
	switch common.GetJsonType(input) {
	case "string":
		return []dto.Message{{Role: "user", Content: normalizeRawContent(input)}}, nil
	case "array":
		var items []dto.Input
		if err := common.Unmarshal(input, &items); err != nil {
			return nil, err
		}
		messages := make([]dto.Message, 0, len(items))
		for _, item := range items {
			role := strings.TrimSpace(item.Role)
			if role == "" {
				role = "user"
			}
			if role == "developer" {
				role = "system"
			}
			messages = append(messages, dto.Message{
				Role:    role,
				Content: responsesContentToChatContent(item.Content),
			})
		}
		return messages, nil
	default:
		return nil, fmt.Errorf("antigravity channel: unsupported responses input type %s", common.GetJsonType(input))
	}
}

func responsesContentToChatContent(content json.RawMessage) json.RawMessage {
	if len(content) == 0 {
		return json.RawMessage(`""`)
	}
	if common.GetJsonType(content) == "array" {
		var parts []map[string]any
		if err := common.Unmarshal(content, &parts); err == nil {
			for i := range parts {
				switch parts[i]["type"] {
				case "input_text":
					parts[i]["type"] = "text"
				case "input_image":
					parts[i]["type"] = "image_url"
				}
			}
			if b, err := common.Marshal(parts); err == nil {
				return b
			}
		}
	}
	return normalizeRawContent(content)
}

func normalizeRawContent(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`""`)
	}
	return raw
}

func rawMessageToAny(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var v any
	if err := common.Unmarshal(raw, &v); err != nil {
		return nil
	}
	return v
}

func responsesToolsToChatTools(tools []map[string]any) []dto.ToolCallRequest {
	if len(tools) == 0 {
		return nil
	}
	chatTools := make([]dto.ToolCallRequest, 0, len(tools))
	for _, tool := range tools {
		if toolType, _ := tool["type"].(string); toolType != "function" {
			continue
		}
		function := tool
		if nested, ok := tool["function"].(map[string]any); ok {
			function = nested
		}
		name, _ := function["name"].(string)
		if strings.TrimSpace(name) == "" {
			continue
		}
		description, _ := function["description"].(string)
		parameters := json.RawMessage(`{}`)
		if params, ok := function["parameters"]; ok {
			if b, err := common.Marshal(params); err == nil {
				parameters = b
			}
		}
		chatTools = append(chatTools, dto.ToolCallRequest{
			Type: "function",
			Function: dto.FunctionRequest{
				Name:        name,
				Description: description,
				Parameters:  parameters,
			},
		})
	}
	return chatTools
}

func antigravityUsageFromGemini(metadata dto.GeminiUsageMetadata, fallbackPromptTokens int) dto.Usage {
	promptTokens := metadata.PromptTokenCount + metadata.ToolUsePromptTokenCount
	if promptTokens <= 0 && fallbackPromptTokens > 0 {
		promptTokens = fallbackPromptTokens
	}
	usage := dto.Usage{
		PromptTokens:     promptTokens,
		CompletionTokens: metadata.CandidatesTokenCount + metadata.ThoughtsTokenCount,
		TotalTokens:      metadata.TotalTokenCount,
	}
	usage.CompletionTokenDetails.ReasoningTokens = metadata.ThoughtsTokenCount
	usage.PromptTokensDetails.CachedTokens = metadata.CachedContentTokenCount
	if usage.TotalTokens > 0 && usage.CompletionTokens <= 0 {
		usage.CompletionTokens = usage.TotalTokens - usage.PromptTokens
	}
	if usage.TotalTokens == 0 {
		usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
	}
	return usage
}

func extractTextFromGeminiResponse(resp *dto.GeminiChatResponse) string {
	if resp == nil || len(resp.Candidates) == 0 {
		return ""
	}
	var b strings.Builder
	for _, part := range resp.Candidates[0].Content.Parts {
		if part.Text == "" || part.Thought {
			continue
		}
		b.WriteString(part.Text)
	}
	return b.String()
}

func buildResponsesResponse(c *gin.Context, info *relaycommon.RelayInfo, text string, usage *dto.Usage) dto.OpenAIResponsesResponse {
	now := int(common.GetTimestamp())
	responseID := strings.Replace(helper.GetResponseID(c), "chatcmpl-", "resp_", 1)
	itemID := strings.Replace(helper.GetResponseID(c), "chatcmpl-", "msg_", 1)
	return dto.OpenAIResponsesResponse{
		ID:                responseID,
		Object:            "response",
		CreatedAt:         now,
		Status:            json.RawMessage(`"completed"`),
		Model:             info.UpstreamModelName,
		ParallelToolCalls: true,
		Store:             false,
		Output: []dto.ResponsesOutput{
			{
				Type:   "message",
				ID:     itemID,
				Status: "completed",
				Role:   "assistant",
				Content: []dto.ResponsesOutputContent{
					{Type: "output_text", Text: text},
				},
			},
		},
		Usage: usage,
	}
}

func antigravityResponsesHandler(c *gin.Context, resp *http.Response, info *relaycommon.RelayInfo) (*dto.Usage, *types.NewAPIError) {
	defer service.CloseResponseBodyGracefully(resp)
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeReadResponseBodyFailed, http.StatusInternalServerError)
	}
	var geminiResp dto.GeminiChatResponse
	if err := common.Unmarshal(body, &geminiResp); err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
	}
	if len(geminiResp.Candidates) == 0 {
		return nil, types.NewOpenAIError(errors.New("empty response from Gemini API"), types.ErrorCodeEmptyResponse, http.StatusInternalServerError)
	}
	usage := antigravityUsageFromGemini(geminiResp.UsageMetadata, info.GetEstimatePromptTokens())
	responsesResp := buildResponsesResponse(c, info, extractTextFromGeminiResponse(&geminiResp), &usage)
	responseBody, err := common.Marshal(responsesResp)
	if err != nil {
		return nil, types.NewError(err, types.ErrorCodeBadResponseBody)
	}
	service.IOCopyBytesGracefully(c, resp, responseBody)
	return &usage, nil
}

func antigravityResponsesStreamHandler(c *gin.Context, resp *http.Response, info *relaycommon.RelayInfo) (*dto.Usage, *types.NewAPIError) {
	defer service.CloseResponseBodyGracefully(resp)
	helper.SetEventStreamHeaders(c)

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeReadResponseBodyFailed, http.StatusInternalServerError)
	}
	text, usage, parseErr := parseGeminiStreamBody(body, info)
	if parseErr != nil {
		return nil, parseErr
	}

	responsesResp := buildResponsesResponse(c, info, text, usage)
	writeResponsesEvent(c, "response.created", gin.H{
		"type":     "response.created",
		"response": responsesResp,
	})
	if text != "" {
		writeResponsesEvent(c, "response.output_text.delta", gin.H{
			"type":          "response.output_text.delta",
			"output_index":  0,
			"content_index": 0,
			"delta":         text,
		})
		writeResponsesEvent(c, "response.output_text.done", gin.H{
			"type":          "response.output_text.done",
			"output_index":  0,
			"content_index": 0,
			"text":          text,
		})
	}
	writeResponsesEvent(c, "response.completed", gin.H{
		"type":     "response.completed",
		"response": responsesResp,
	})
	helper.Done(c)
	return usage, nil
}

func parseGeminiStreamBody(body []byte, info *relaycommon.RelayInfo) (string, *dto.Usage, *types.NewAPIError) {
	var text strings.Builder
	usage := &dto.Usage{}
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var geminiResp dto.GeminiChatResponse
		if err := common.Unmarshal(unwrapAntigravityInternalResponseData([]byte(data)), &geminiResp); err != nil {
			continue
		}
		text.WriteString(extractTextFromGeminiResponse(&geminiResp))
		if geminiResp.UsageMetadata.TotalTokenCount != 0 {
			mapped := antigravityUsageFromGemini(geminiResp.UsageMetadata, info.GetEstimatePromptTokens())
			usage = &mapped
		}
	}
	return text.String(), usage, nil
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

func (a *Adaptor) GetChannelName() string {
	return ChannelName
}

func (a *Adaptor) GetModelList() []string {
	return ModelList
}

const ChannelName = "Antigravity"

var _ channel.Adaptor = (*Adaptor)(nil)

func shouldUseManagerPassthrough(info *relaycommon.RelayInfo) bool {
	if antigravityManagerBaseURL() == "" {
		return false
	}
	return true
}

func ShouldUseManagerPassthrough() bool {
	return shouldUseManagerPassthrough(nil)
}

func doManagerPassthroughResponse(c *gin.Context, resp *http.Response, info *relaycommon.RelayInfo) (usage any, err *types.NewAPIError) {
	switch info.RelayFormat {
	case types.RelayFormatClaude:
		var adaptor claude.Adaptor
		adaptor.Init(info)
		return adaptor.DoResponse(c, resp, info)
	case types.RelayFormatGemini:
		var adaptor gemini.Adaptor
		adaptor.Init(info)
		return adaptor.DoResponse(c, resp, info)
	default:
		var adaptor openai.Adaptor
		adaptor.Init(info)
		return adaptor.DoResponse(c, resp, info)
	}
}

func applyAntigravityManagerRoutingHeaders(c *gin.Context, resp *http.Response, info *relaycommon.RelayInfo) {
	if resp == nil || info == nil || info.ChannelMeta == nil {
		return
	}
	requestedModel := strings.TrimSpace(resp.Header.Get("X-Antigravity-Requested-Model"))
	mappedModel := strings.TrimSpace(resp.Header.Get("X-Antigravity-Mapped-Model"))
	upstreamModel := strings.TrimSpace(resp.Header.Get("X-Antigravity-Upstream-Model"))
	redirectReason := strings.TrimSpace(resp.Header.Get("X-Antigravity-Model-Redirect-Reason"))
	if upstreamModel == "" {
		return
	}
	if requestedModel == "" {
		requestedModel = info.OriginModelName
	}
	if requestedModel == "" {
		requestedModel = info.UpstreamModelName
	}
	if c != nil {
		if requestedModel != "" {
			c.Set("antigravity_model_requested", requestedModel)
		}
		if mappedModel != "" {
			c.Set("antigravity_model_mapped", mappedModel)
		}
		c.Set("antigravity_model_upstream", upstreamModel)
		if redirectReason != "" {
			c.Set("antigravity_model_redirect_reason", redirectReason)
		}
	}
	if requestedModel != "" && !strings.EqualFold(upstreamModel, requestedModel) {
		info.IsModelMapped = true
		info.UpstreamModelName = upstreamModel
	}
}
