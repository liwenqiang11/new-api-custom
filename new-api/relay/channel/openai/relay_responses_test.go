package openai

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
)

func TestOaiResponsesStreamHandlerDoesNotCompleteIncompleteResponse(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)

	body := strings.Join([]string{
		`data: {"type":"response.created","response":{"id":"resp_test","object":"response","created_at":1,"model":"gpt-5.6","status":"in_progress","output":[],"usage":null}}`,
		`data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"partial text"}`,
		`data: {"type":"response.incomplete","response":{"id":"resp_test","object":"response","created_at":1,"model":"gpt-5.6","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","id":"msg_test","status":"incomplete","role":"assistant","content":[{"type":"output_text","text":"partial text"}]}],"usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30}}}`,
		`data: [DONE]`,
		"",
	}, "\n")

	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
	info := &relaycommon.RelayInfo{
		OriginModelName: "gpt-5.6",
		DisablePing:     true,
		ChannelMeta: &relaycommon.ChannelMeta{
			UpstreamModelName: "gpt-5.6",
		},
	}

	usage, err := OaiResponsesStreamHandler(c, info, resp)
	if err != nil {
		t.Fatalf("stream handler returned error: %v", err)
	}
	if usage == nil || usage.PromptTokens != 10 || usage.CompletionTokens != 20 || usage.TotalTokens != 30 {
		t.Fatalf("unexpected usage: %#v", usage)
	}

	got := w.Body.String()
	if !strings.Contains(got, "event: response.incomplete") {
		t.Fatalf("stream output missing incomplete event:\n%s", got)
	}
	if !strings.Contains(got, `"reason":"max_output_tokens"`) {
		t.Fatalf("stream output missing incomplete reason:\n%s", got)
	}
	if strings.Contains(got, "event: response.completed") {
		t.Fatalf("incomplete stream should not synthesize completed event:\n%s", got)
	}
}

func TestOaiResponsesStreamHandlerBackfillsCompletedOutput(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)

	body := strings.Join([]string{
		`event: response.output_item.done`,
		`data: {"type":"response.output_item.done","sequence_number":1,"item":{"type":"function_call","id":"fc_test","status":"completed","call_id":"call_test","name":"Agent","arguments":"{\"description\":\"x\"}"}}`,
		`event: response.completed`,
		`data: {"type":"response.completed","sequence_number":2,"response":{"id":"resp_test","object":"response","created_at":1,"model":"gpt-5.6-sol","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}`,
		`data: [DONE]`,
		"",
	}, "\n")

	resp := &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
	info := &relaycommon.RelayInfo{OriginModelName: "gpt-5.6-sol", DisablePing: true, ChannelMeta: &relaycommon.ChannelMeta{UpstreamModelName: "gpt-5.6-sol"}}

	_, err := OaiResponsesStreamHandler(c, info, resp)
	if err != nil {
		t.Fatalf("stream handler returned error: %v", err)
	}
	got := w.Body.String()
	if !strings.Contains(got, `"sequence_number":2`) {
		t.Fatalf("rewritten completed response should preserve sequence_number:\n%s", got)
	}
	if !strings.Contains(got, `"output":[{"arguments":"{\"description\":\"x\"}"`) || !strings.Contains(got, `"id":"fc_test"`) {
		t.Fatalf("completed response did not include backfilled output item:\n%s", got)
	}
}
