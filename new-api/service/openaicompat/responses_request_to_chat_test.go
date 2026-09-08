package openaicompat

import (
	"encoding/json"
	"testing"

	"github.com/QuantumNous/new-api/dto"
)

func TestResponsesRequestToChatCompletionsRequestPreservesCodexToolTurn(t *testing.T) {
	req := dto.OpenAIResponsesRequest{
		Model:  "MiniMax-M3",
		Stream: boolPtr(true),
		Input: json.RawMessage(`[
			{"role":"user","content":"list files"},
			{"role":"assistant","content":[{"type":"output_text","text":"I will inspect files."}]},
			{"type":"function_call","call_id":"call_abc","name":"shell","arguments":"{\"cmd\":\"ls\"}"},
			{"type":"function_call","call_id":"call_def","name":"shell","arguments":"{\"cmd\":\"pwd\"}"},
			{"type":"function_call_output","call_id":"call_abc","output":"app.py\nmain.py"},
			{"type":"function_call_output","call_id":"call_def","output":"/tmp/project"}
		]`),
	}

	chatReq, err := ResponsesRequestToChatCompletionsRequest(req)
	if err != nil {
		t.Fatalf("convert request: %v", err)
	}
	if chatReq.Stream == nil || !*chatReq.Stream {
		t.Fatalf("expected stream to be preserved")
	}
	if len(chatReq.Messages) != 4 {
		t.Fatalf("expected 4 messages, got %d: %#v", len(chatReq.Messages), chatReq.Messages)
	}

	assistant := chatReq.Messages[1]
	if assistant.Role != "assistant" {
		t.Fatalf("expected assistant function call message, got %q", assistant.Role)
	}
	toolCalls := assistant.ParseToolCalls()
	if len(toolCalls) != 2 {
		t.Fatalf("expected 2 tool calls on one assistant message, got %d", len(toolCalls))
	}
	if toolCalls[0].ID != "call_abc" || toolCalls[0].Function.Name != "shell" || toolCalls[0].Function.Arguments != `{"cmd":"ls"}` {
		t.Fatalf("unexpected tool call: %#v", toolCalls[0])
	}
	if toolCalls[1].ID != "call_def" || toolCalls[1].Function.Name != "shell" || toolCalls[1].Function.Arguments != `{"cmd":"pwd"}` {
		t.Fatalf("unexpected second tool call: %#v", toolCalls[1])
	}

	tool := chatReq.Messages[2]
	if tool.Role != "tool" {
		t.Fatalf("expected tool message, got %q", tool.Role)
	}
	if tool.ToolCallId != "call_abc" {
		t.Fatalf("expected tool_call_id to be preserved, got %q", tool.ToolCallId)
	}
	if tool.StringContent() != "app.py\nmain.py" {
		t.Fatalf("unexpected tool output content: %q", tool.StringContent())
	}
	secondTool := chatReq.Messages[3]
	if secondTool.ToolCallId != "call_def" || secondTool.StringContent() != "/tmp/project" {
		t.Fatalf("unexpected second tool output: %#v", secondTool)
	}
}

func boolPtr(v bool) *bool {
	return &v
}
