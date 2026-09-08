package service

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	"github.com/gin-gonic/gin"
)

//func GetPromptTokens(textRequest dto.GeneralOpenAIRequest, relayMode int) (int, error) {
//	switch relayMode {
//	case constant.RelayModeChatCompletions:
//		return CountTokenMessages(textRequest.Messages, textRequest.Model)
//	case constant.RelayModeCompletions:
//		return CountTokenInput(textRequest.Prompt, textRequest.Model), nil
//	case constant.RelayModeModerations:
//		return CountTokenInput(textRequest.Input, textRequest.Model), nil
//	}
//	return 0, errors.New("unknown relay mode")
//}

func ResponseText2Usage(c *gin.Context, responseText string, modeName string, promptTokens int) *dto.Usage {
	common.SetContextKey(c, constant.ContextKeyLocalCountTokens, true)
	usage := &dto.Usage{}
	usage.PromptTokens = promptTokens
	usage.CompletionTokens = EstimateTokenByModel(modeName, responseText)
	usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
	return usage
}

func ValidUsage(usage *dto.Usage) bool {
	return usage != nil && (usage.PromptTokens != 0 || usage.CompletionTokens != 0)
}

func DashboardTokenUsed(usage *dto.Usage) int {
	if usage == nil {
		return 0
	}

	total := usage.PromptTokens + usage.CompletionTokens
	cacheRead := usage.PromptTokensDetails.CachedTokens
	cacheWrite := usage.PromptTokensDetails.CachedCreationTokens
	if usage.InputTokensDetails != nil {
		if cacheRead == 0 {
			cacheRead = usage.InputTokensDetails.CachedTokens
		}
		if cacheWrite == 0 {
			cacheWrite = usage.InputTokensDetails.CachedCreationTokens
		}
	}

	total += cacheRead + cacheWrite

	if usage.TotalTokens > total {
		total = usage.TotalTokens
	}
	if usage.InputTokens+usage.OutputTokens > total {
		total = usage.InputTokens + usage.OutputTokens
	}
	if total == 0 {
		total = usage.PromptTokensDetails.TextTokens +
			usage.PromptTokensDetails.AudioTokens +
			usage.PromptTokensDetails.ImageTokens +
			usage.CompletionTokenDetails.TextTokens +
			usage.CompletionTokenDetails.AudioTokens +
			usage.CompletionTokenDetails.ImageTokens +
			usage.CompletionTokenDetails.ReasoningTokens +
			cacheRead +
			cacheWrite
	}

	return total
}
