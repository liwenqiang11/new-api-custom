package relay

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/dto"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
)

func TestExtractToolCallsFromChatConvertsArgumentsAsResponsesString(t *testing.T) {
	resp := &dto.OpenAITextResponse{
		Choices: []dto.OpenAITextResponseChoice{
			{
				Message: dto.Message{
					ToolCalls: json.RawMessage(`[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"weather\"}"}}]`),
				},
			},
		},
	}

	output := extractToolCallsFromChat(resp)
	if len(output) != 1 {
		t.Fatalf("expected 1 tool call output, got %d", len(output))
	}
	if output[0].Type != "function_call" {
		t.Fatalf("expected function_call output, got %q", output[0].Type)
	}
	if output[0].CallId != "call_1" || output[0].Name != "lookup" {
		t.Fatalf("unexpected call metadata: call_id=%q name=%q", output[0].CallId, output[0].Name)
	}

	var marshalled map[string]any
	data, err := json.Marshal(output[0])
	if err != nil {
		t.Fatalf("marshal output: %v", err)
	}
	if err := json.Unmarshal(data, &marshalled); err != nil {
		t.Fatalf("unmarshal output: %v", err)
	}
	args, ok := marshalled["arguments"].(string)
	if !ok {
		t.Fatalf("expected Responses function_call arguments to be a string, got %T in %s", marshalled["arguments"], string(data))
	}
	if args != `{"q":"weather"}` {
		t.Fatalf("unexpected arguments string: %q", args)
	}
}

func TestResponsesViaChatCompletionsStreamEmitsFunctionCallEvents(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)

	body := strings.Join([]string{
		`data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"MiniMax-M3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\"q\""}}]},"finish_reason":null}],"usage":null}`,
		`data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"MiniMax-M3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"weather\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}`,
		`data: [DONE]`,
		"",
	}, "\n")

	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
	info := &relaycommon.RelayInfo{
		OriginModelName: "MiniMax-M3",
		ChannelMeta: &relaycommon.ChannelMeta{
			UpstreamModelName: "MiniMax-M3",
		},
	}

	usage, err := chatCompletionsStreamToResponsesHandler(c, info, resp)
	if err != nil {
		t.Fatalf("stream handler returned error: %v", err)
	}
	if usage == nil || usage.TotalTokens != 7 {
		t.Fatalf("unexpected usage: %#v", usage)
	}

	got := w.Body.String()
	for _, want := range []string{
		"event: response.output_item.added",
		`"type":"function_call"`,
		`"name":"lookup"`,
		"event: response.function_call_arguments.delta",
		`"delta":"{\"q\""`,
		`"delta":":\"weather\"}"`,
		"event: response.function_call_arguments.done",
		`"arguments":"{\"q\":\"weather\"}"`,
		"event: response.output_item.done",
		"event: response.completed",
		`"output":[{"type":"function_call"`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("stream output missing %q\n%s", want, got)
		}
	}
}
