package openaicompat

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
)

func ResponsesRequestToChatCompletionsRequest(request dto.OpenAIResponsesRequest) (*dto.GeneralOpenAIRequest, error) {
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
		User:          request.User,
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
			switch item.Type {
			case "function_call_output":
				messages = append(messages, dto.Message{
					Role:       "tool",
					Content:    responsesFunctionOutputToChatContent(item),
					ToolCallId: strings.TrimSpace(item.CallId),
				})
			case "function_call":
				callID := strings.TrimSpace(item.CallId)
				name := strings.TrimSpace(item.Name)
				if callID != "" && name != "" {
					toolCall := dto.ToolCallRequest{
						ID:   callID,
						Type: "function",
						Function: dto.FunctionRequest{
							Name:      name,
							Arguments: item.Arguments,
						},
					}
					messages = appendResponsesFunctionCall(messages, toolCall)
				}
			default:
				messages = append(messages, dto.Message{
					Role:    role,
					Content: responsesContentToChatContent(item.Content),
				})
			}
		}
		return messages, nil
	default:
		return nil, fmt.Errorf("unsupported responses input type %s", common.GetJsonType(input))
	}
}

func appendResponsesFunctionCall(messages []dto.Message, toolCall dto.ToolCallRequest) []dto.Message {
	if len(messages) == 0 || messages[len(messages)-1].Role != "assistant" || messages[len(messages)-1].ToolCallId != "" {
		msg := dto.Message{
			Role:    "assistant",
			Content: "",
		}
		msg.SetToolCalls([]dto.ToolCallRequest{toolCall})
		return append(messages, msg)
	}
	last := &messages[len(messages)-1]
	toolCalls := last.ParseToolCalls()
	toolCalls = append(toolCalls, toolCall)
	last.SetToolCalls(toolCalls)
	if last.Content == nil {
		last.Content = ""
	}
	return messages
}

func responsesFunctionOutputToChatContent(item dto.Input) any {
	if len(item.Output) > 0 {
		if common.GetJsonType(item.Output) == "string" {
			var output string
			if err := common.Unmarshal(item.Output, &output); err == nil {
				return output
			}
		}
		return common.JsonRawMessageToString(item.Output)
	}
	if len(item.Content) == 0 {
		return ""
	}
	if common.GetJsonType(item.Content) == "string" {
		var content string
		if err := common.Unmarshal(item.Content, &content); err == nil {
			return content
		}
	}
	return common.JsonRawMessageToString(responsesContentToChatContent(item.Content))
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
				case "input_text", "output_text":
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
