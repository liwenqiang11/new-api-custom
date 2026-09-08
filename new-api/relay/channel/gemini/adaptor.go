package gemini

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/relay/channel"
	"github.com/QuantumNous/new-api/relay/channel/openai"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/setting/model_setting"
	"github.com/QuantumNous/new-api/setting/reasoning"
	"github.com/QuantumNous/new-api/types"

	"github.com/gin-gonic/gin"
	"github.com/samber/lo"
)

type Adaptor struct {
}

func (a *Adaptor) ConvertGeminiRequest(c *gin.Context, info *relaycommon.RelayInfo, request *dto.GeminiChatRequest) (any, error) {
	if len(request.Contents) > 0 {
		for i, content := range request.Contents {
			if i == 0 {
				if request.Contents[0].Role == "" {
					request.Contents[0].Role = "user"
				}
			}
			for _, part := range content.Parts {
				if part.FileData != nil {
					if part.FileData.MimeType == "" && strings.Contains(part.FileData.FileUri, "www.youtube.com") {
						part.FileData.MimeType = "video/webm"
					}
				}
			}
		}
	}
	return request, nil
}

func (a *Adaptor) ConvertClaudeRequest(c *gin.Context, info *relaycommon.RelayInfo, req *dto.ClaudeRequest) (any, error) {
	adaptor := openai.Adaptor{}
	oaiReq, err := adaptor.ConvertClaudeRequest(c, info, req)
	if err != nil {
		return nil, err
	}
	return a.ConvertOpenAIRequest(c, info, oaiReq.(*dto.GeneralOpenAIRequest))
}

func (a *Adaptor) ConvertAudioRequest(c *gin.Context, info *relaycommon.RelayInfo, request dto.AudioRequest) (io.Reader, error) {
	//TODO implement me
	return nil, errors.New("not implemented")
}

// imageSizeToAspectRatio converts an OpenAI-style WIDTHxHEIGHT size string to a Gemini aspect ratio.
func imageSizeToAspectRatio(size string) string {
	if strings.Contains(size, ":") {
		return size
	}
	switch size {
	case "256x256", "512x512", "1024x1024":
		return "1:1"
	case "1536x1024", "1792x1024", "1920x1080":
		return "16:9"
	case "1024x1536", "1024x1792", "1080x1920":
		return "9:16"
	default:
		// Try to derive ratio from arbitrary WxH
		parts := strings.SplitN(size, "x", 2)
		if len(parts) == 2 {
			w, h := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
			if w != "" && h != "" {
				return w + ":" + h
			}
		}
		return "1:1"
	}
}

func (a *Adaptor) ConvertImageRequest(c *gin.Context, info *relaycommon.RelayInfo, request dto.ImageRequest) (any, error) {
	// Flash/Pro image models use generateContent with responseModalities:["IMAGE"]
	if model_setting.IsGeminiModelSupportImagine(info.UpstreamModelName) && !strings.HasPrefix(info.UpstreamModelName, "imagen") {
		return convertFlashImageRequest(request)
	}

	if !strings.HasPrefix(info.UpstreamModelName, "imagen") {
		return nil, errors.New("not supported model for image generation, only imagen models are supported")
	}

	// convert size to aspect ratio but allow user to specify aspect ratio
	aspectRatio := imageSizeToAspectRatio(strings.TrimSpace(request.Size))
	if aspectRatio == "" {
		aspectRatio = "1:1"
	}

	// build gemini imagen request
	geminiRequest := dto.GeminiImageRequest{
		Instances: []dto.GeminiImageInstance{
			{
				Prompt: request.Prompt,
			},
		},
		Parameters: dto.GeminiImageParameters{
			SampleCount:      int(lo.FromPtrOr(request.N, uint(1))),
			AspectRatio:      aspectRatio,
			PersonGeneration: "allow_adult", // default allow adult
		},
	}

	// Set imageSize when quality parameter is specified
	// Map quality parameter to imageSize (only supported by Standard and Ultra models)
	// quality values: auto, high, medium, low (for gpt-image-1), hd, standard (for dall-e-3)
	// imageSize values: 1K (default), 2K
	// https://ai.google.dev/gemini-api/docs/imagen
	// https://platform.openai.com/docs/api-reference/images/create
	if request.Quality != "" {
		imageSize := "1K" // default
		switch request.Quality {
		case "hd", "high":
			imageSize = "2K"
		case "2K":
			imageSize = "2K"
		case "standard", "medium", "low", "auto", "1K":
			imageSize = "1K"
		default:
			// unknown quality value, default to 1K
			imageSize = "1K"
		}
		geminiRequest.Parameters.ImageSize = imageSize
	}

	return geminiRequest, nil
}

// convertFlashImageRequest converts an OpenAI image request to a GeminiChatRequest
// suitable for flash/pro image models that use the generateContent endpoint.
func convertFlashImageRequest(request dto.ImageRequest) (*dto.GeminiChatRequest, error) {
	prompt := strings.TrimSpace(request.Prompt)
	if prompt == "" {
		return nil, errors.New("prompt is required for image generation")
	}

	geminiReq := &dto.GeminiChatRequest{
		Contents: []dto.GeminiChatContent{
			{
				Role:  "user",
				Parts: []dto.GeminiPart{{Text: prompt}},
			},
		},
		GenerationConfig: dto.GeminiChatGenerationConfig{
			ResponseModalities: []string{"TEXT", "IMAGE"},
		},
	}

	// Map size to aspectRatio via imageConfig
	size := strings.TrimSpace(request.Size)
	if size != "" {
		aspectRatio := imageSizeToAspectRatio(size)
		if aspectRatio != "" {
			imageConfigBytes, err := json.Marshal(map[string]string{"aspectRatio": aspectRatio})
			if err == nil {
				geminiReq.GenerationConfig.ImageConfig = imageConfigBytes
			}
		}
	}

	return geminiReq, nil
}

func (a *Adaptor) Init(info *relaycommon.RelayInfo) {

}

func (a *Adaptor) GetRequestURL(info *relaycommon.RelayInfo) (string, error) {

	if model_setting.GetGeminiSettings().ThinkingAdapterEnabled &&
		!model_setting.ShouldPreserveThinkingSuffix(info.OriginModelName) {
		// 新增逻辑：处理 -thinking-<budget> 格式
		if strings.Contains(info.UpstreamModelName, "-thinking-") {
			parts := strings.Split(info.UpstreamModelName, "-thinking-")
			info.UpstreamModelName = parts[0]
		} else if strings.HasSuffix(info.UpstreamModelName, "-thinking") { // 旧的适配
			info.UpstreamModelName = strings.TrimSuffix(info.UpstreamModelName, "-thinking")
		} else if strings.HasSuffix(info.UpstreamModelName, "-nothinking") {
			info.UpstreamModelName = strings.TrimSuffix(info.UpstreamModelName, "-nothinking")
		} else if baseModel, level, ok := reasoning.TrimEffortSuffix(info.UpstreamModelName); ok && level != "" {
			info.UpstreamModelName = baseModel
		}
	}

	version := model_setting.GetGeminiVersionSetting(info.UpstreamModelName)

	if strings.HasPrefix(info.UpstreamModelName, "imagen") {
		return fmt.Sprintf("%s/%s/models/%s:predict", info.ChannelBaseUrl, version, info.UpstreamModelName), nil
	}

	if strings.HasPrefix(info.UpstreamModelName, "text-embedding") ||
		strings.HasPrefix(info.UpstreamModelName, "embedding") ||
		strings.HasPrefix(info.UpstreamModelName, "gemini-embedding") {
		action := "embedContent"
		if info.IsGeminiBatchEmbedding {
			action = "batchEmbedContents"
		}
		return fmt.Sprintf("%s/%s/models/%s:%s", info.ChannelBaseUrl, version, info.UpstreamModelName, action), nil
	}

	action := "generateContent"
	if info.IsStream {
		action = "streamGenerateContent?alt=sse"
		if info.RelayMode == constant.RelayModeGemini {
			info.DisablePing = true
		}
	}
	return fmt.Sprintf("%s/%s/models/%s:%s", info.ChannelBaseUrl, version, info.UpstreamModelName, action), nil
}

func (a *Adaptor) SetupRequestHeader(c *gin.Context, req *http.Header, info *relaycommon.RelayInfo) error {
	channel.SetupApiRequestHeader(info, c, req)
	req.Set("x-goog-api-key", info.ApiKey)
	return nil
}

func (a *Adaptor) ConvertOpenAIRequest(c *gin.Context, info *relaycommon.RelayInfo, request *dto.GeneralOpenAIRequest) (any, error) {
	if request == nil {
		return nil, errors.New("request is nil")
	}

	geminiRequest, err := CovertOpenAI2Gemini(c, *request, info)
	if err != nil {
		return nil, err
	}

	return geminiRequest, nil
}

func (a *Adaptor) ConvertRerankRequest(c *gin.Context, relayMode int, request dto.RerankRequest) (any, error) {
	return nil, nil
}

func (a *Adaptor) ConvertEmbeddingRequest(c *gin.Context, info *relaycommon.RelayInfo, request dto.EmbeddingRequest) (any, error) {
	if request.Input == nil {
		return nil, errors.New("input is required")
	}

	inputs := request.ParseInput()
	if len(inputs) == 0 {
		return nil, errors.New("input is empty")
	}
	// We always build a batch-style payload with `requests`, so ensure we call the
	// batch endpoint upstream to avoid payload/endpoint mismatches.
	info.IsGeminiBatchEmbedding = true
	// process all inputs
	geminiRequests := make([]map[string]interface{}, 0, len(inputs))
	for _, input := range inputs {
		geminiRequest := map[string]interface{}{
			"model": fmt.Sprintf("models/%s", info.UpstreamModelName),
			"content": dto.GeminiChatContent{
				Parts: []dto.GeminiPart{
					{
						Text: input,
					},
				},
			},
		}

		// set specific parameters for different models
		// https://ai.google.dev/api/embeddings?hl=zh-cn#method:-models.embedcontent
		switch info.UpstreamModelName {
		case "text-embedding-004", "gemini-embedding-exp-03-07", "gemini-embedding-001":
			// Only newer models introduced after 2024 support OutputDimensionality
			dimensions := lo.FromPtrOr(request.Dimensions, 0)
			if dimensions > 0 {
				geminiRequest["outputDimensionality"] = dimensions
			}
		}
		geminiRequests = append(geminiRequests, geminiRequest)
	}

	return map[string]interface{}{
		"requests": geminiRequests,
	}, nil
}

func (a *Adaptor) ConvertOpenAIResponsesRequest(c *gin.Context, info *relaycommon.RelayInfo, request dto.OpenAIResponsesRequest) (any, error) {
	// TODO implement me
	return nil, errors.New("not implemented")
}

func (a *Adaptor) DoRequest(c *gin.Context, info *relaycommon.RelayInfo, requestBody io.Reader) (any, error) {
	return channel.DoApiRequest(a, c, info, requestBody)
}

func (a *Adaptor) DoResponse(c *gin.Context, resp *http.Response, info *relaycommon.RelayInfo) (usage any, err *types.NewAPIError) {
	if info.RelayMode == constant.RelayModeGemini {
		if strings.Contains(info.RequestURLPath, ":embedContent") ||
			strings.Contains(info.RequestURLPath, ":batchEmbedContents") {
			return NativeGeminiEmbeddingHandler(c, resp, info)
		}
		if info.IsStream {
			return GeminiTextGenerationStreamHandler(c, info, resp)
		} else {
			return GeminiTextGenerationHandler(c, info, resp)
		}
	}

	if strings.HasPrefix(info.UpstreamModelName, "imagen") {
		return GeminiImageHandler(c, info, resp)
	}

	// Flash/Pro image models use generateContent and return InlineData parts
	if model_setting.IsGeminiModelSupportImagine(info.UpstreamModelName) {
		return GeminiFlashImageHandler(c, info, resp)
	}

	// check if the model is an embedding model
	if strings.HasPrefix(info.UpstreamModelName, "text-embedding") ||
		strings.HasPrefix(info.UpstreamModelName, "embedding") ||
		strings.HasPrefix(info.UpstreamModelName, "gemini-embedding") {
		return GeminiEmbeddingHandler(c, info, resp)
	}

	if info.IsStream {
		return GeminiChatStreamHandler(c, info, resp)
	} else {
		return GeminiChatHandler(c, info, resp)
	}

}

func (a *Adaptor) GetModelList() []string {
	return ModelList
}

func (a *Adaptor) GetChannelName() string {
	return ChannelName
}
