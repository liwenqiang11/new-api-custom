package minimax

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	channelconstant "github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/types"

	"github.com/gin-gonic/gin"
)

func TestGetRequestURLForImageGeneration(t *testing.T) {
	t.Parallel()

	info := &relaycommon.RelayInfo{
		RelayMode: relayconstant.RelayModeImagesGenerations,
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelBaseUrl: "https://api.minimax.chat",
		},
	}

	got, err := GetRequestURL(info)
	if err != nil {
		t.Fatalf("GetRequestURL returned error: %v", err)
	}

	want := "https://api.minimax.chat/v1/image_generation"
	if got != want {
		t.Fatalf("GetRequestURL() = %q, want %q", got, want)
	}
}

func TestConvertImageRequest(t *testing.T) {
	t.Parallel()

	adaptor := &Adaptor{}
	info := &relaycommon.RelayInfo{
		RelayMode:       relayconstant.RelayModeImagesGenerations,
		OriginModelName: "image-01",
	}
	request := dto.ImageRequest{
		Model:          "image-01",
		Prompt:         "a red fox in snowfall",
		Size:           "1536x1024",
		ResponseFormat: "url",
		N:              uintPtr(2),
	}

	got, err := adaptor.ConvertImageRequest(gin.CreateTestContextOnly(httptest.NewRecorder(), gin.New()), info, request)
	if err != nil {
		t.Fatalf("ConvertImageRequest returned error: %v", err)
	}

	body, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("json.Unmarshal returned error: %v", err)
	}

	if payload["model"] != "image-01" {
		t.Fatalf("model = %#v, want %q", payload["model"], "image-01")
	}
	if payload["prompt"] != request.Prompt {
		t.Fatalf("prompt = %#v, want %q", payload["prompt"], request.Prompt)
	}
	if payload["n"] != float64(2) {
		t.Fatalf("n = %#v, want 2", payload["n"])
	}
	if payload["aspect_ratio"] != "3:2" {
		t.Fatalf("aspect_ratio = %#v, want %q", payload["aspect_ratio"], "3:2")
	}
	if payload["response_format"] != "url" {
		t.Fatalf("response_format = %#v, want %q", payload["response_format"], "url")
	}
}

func TestDoResponseForImageGeneration(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)

	info := &relaycommon.RelayInfo{
		RelayMode: relayconstant.RelayModeImagesGenerations,
		StartTime: time.Unix(1700000000, 0),
	}
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       httptest.NewRecorder().Result().Body,
	}
	resp.Body = ioNopCloser(`{"data":{"image_urls":["https://example.com/minimax.png"]}}`)

	adaptor := &Adaptor{}
	usage, err := adaptor.DoResponse(c, resp, info)
	if err != nil {
		t.Fatalf("DoResponse returned error: %v", err)
	}
	if usage == nil {
		t.Fatalf("DoResponse returned nil usage")
	}

	body := recorder.Body.String()
	if !strings.Contains(body, `"url":"https://example.com/minimax.png"`) {
		t.Fatalf("response body = %s, want OpenAI image response with image URL", body)
	}
	if strings.Contains(body, `"image_urls"`) {
		t.Fatalf("response body = %s, should not expose raw MiniMax image_urls payload", body)
	}
}

type nopReadCloser struct {
	*strings.Reader
}

func (n nopReadCloser) Close() error {
	return nil
}

func ioNopCloser(body string) nopReadCloser {
	return nopReadCloser{Reader: strings.NewReader(body)}
}

func uintPtr(v uint) *uint {
	return &v
}

// TestGetRequestURL_ClaudeFormatIsolated locks in the Claude Code routing so
// that any future fix to the Codex / OpenAI Responses path cannot accidentally
// leak into the Anthropic-format endpoint. Claude Code (RelayFormatClaude)
// must keep going to /anthropic/v1/messages and never be rewritten as
// /v1/text/chatcompletion_v2, regardless of RelayMode.
func TestGetRequestURL_ClaudeFormatIsolated(t *testing.T) {
	t.Parallel()

	base := "https://api.minimax.chat"
	info := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{ChannelBaseUrl: base, ChannelType: channelconstant.ChannelTypeMiniMax},
	}

	// Claude Code: RelayFormatClaude, even with a Responses-ish RelayMode,
	// MUST still go to the Anthropic-compatible endpoint.
	for _, mode := range []int{
		relayconstant.RelayModeChatCompletions,
		relayconstant.RelayModeResponses,
		relayconstant.RelayModeResponsesCompact,
	} {
		info2 := *info
		info2.RelayFormat = types.RelayFormatClaude
		info2.RelayMode = mode
		got, err := GetRequestURL(&info2)
		if err != nil {
			t.Fatalf("RelayMode=%d: GetRequestURL returned error: %v", mode, err)
		}
		want := base + "/anthropic/v1/messages"
		if got != want {
			t.Fatalf("RelayMode=%d: Claude route = %q, want %q (must not leak Codex Responses routing)", mode, got, want)
		}
	}
}

// TestGetRequestURL_OpenAIResponsesRoute covers the new Codex / MiniMax-M3 path.
func TestGetRequestURL_OpenAIResponsesRoute(t *testing.T) {
	t.Parallel()

	base := "https://api.minimax.chat"
	info := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{ChannelBaseUrl: base, ChannelType: channelconstant.ChannelTypeMiniMax},

		RelayFormat: types.RelayFormatOpenAIResponses,
	}

	for _, mode := range []int{
		relayconstant.RelayModeResponses,
		relayconstant.RelayModeResponsesCompact,
	} {
		info2 := *info
		info2.RelayMode = mode
		got, err := GetRequestURL(&info2)
		if err != nil {
			t.Fatalf("RelayMode=%d: GetRequestURL returned error: %v", mode, err)
		}
		want := base + "/v1/responses"
		if got != want {
			t.Fatalf("RelayMode=%d: Responses route = %q, want %q", mode, got, want)
		}
	}
}
