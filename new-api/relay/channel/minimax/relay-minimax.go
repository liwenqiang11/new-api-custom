package minimax

import (
	"fmt"

	channelconstant "github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/types"
)

func GetRequestURL(info *relaycommon.RelayInfo) (string, error) {
	baseUrl := info.ChannelBaseUrl
	if baseUrl == "" {
		baseUrl = channelconstant.ChannelBaseURLs[channelconstant.ChannelTypeMiniMax]
	}
	// Routing has two layers:
	//   outer RelayFormat picks the protocol family (Claude / OpenAI Responses / default)
	//   inner RelayMode picks the business action (chat / image / tts)
	// Claude and OpenAIResponses are split into explicit branches so a fix
	// to one cannot leak into the other.
	switch info.RelayFormat {
	case types.RelayFormatClaude:
		// Claude Code -> MiniMax Anthropic-compatible endpoint
		return fmt.Sprintf("%s/anthropic/v1/messages", baseUrl), nil
	case types.RelayFormatOpenAIResponses:
		// Codex -> MiniMax-M3 etc. speak the OpenAI Responses shape natively;
		// route to the standard /v1/responses path on the same base.
		return fmt.Sprintf("%s/v1/responses", baseUrl), nil
	default:
		switch info.RelayMode {
		case constant.RelayModeChatCompletions:
			return fmt.Sprintf("%s/v1/text/chatcompletion_v2", baseUrl), nil
		case constant.RelayModeImagesGenerations:
			return fmt.Sprintf("%s/v1/image_generation", baseUrl), nil
		case constant.RelayModeAudioSpeech:
			return fmt.Sprintf("%s/v1/t2a_v2", baseUrl), nil
		default:
			return "", fmt.Errorf("unsupported relay mode: %d", info.RelayMode)
		}
	}
}