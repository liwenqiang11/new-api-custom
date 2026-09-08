package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
)

type CodexCredentialRefreshOptions struct {
	ResetCaches bool
}

type CodexOAuthTokens struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	AccountID    string `json:"account_id"`
}

type CodexOAuthKey struct {
	Tokens  CodexOAuthTokens `json:"tokens"`
	Expired string           `json:"-"`
	Email   string           `json:"-"`
	Type    string           `json:"-"`
}

func parseCodexOAuthKey(raw string) (*CodexOAuthKey, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, errors.New("codex channel: empty oauth key")
	}
	var key CodexOAuthKey
	if err := common.Unmarshal([]byte(raw), &key); err != nil {
		return nil, errors.New("codex channel: invalid oauth key json")
	}
	if strings.TrimSpace(key.Tokens.IDToken) == "" ||
		strings.TrimSpace(key.Tokens.AccessToken) == "" ||
		strings.TrimSpace(key.Tokens.RefreshToken) == "" ||
		strings.TrimSpace(key.Tokens.AccountID) == "" {
		return nil, errors.New("codex channel: credential must include tokens.id_token, tokens.access_token, tokens.refresh_token, and tokens.account_id")
	}
	return &key, nil
}

func RefreshCodexChannelCredential(ctx context.Context, channelID int, opts CodexCredentialRefreshOptions) (*CodexOAuthKey, *model.Channel, error) {
	ch, err := model.GetChannelById(channelID, true)
	if err != nil {
		return nil, nil, err
	}
	if ch == nil {
		return nil, nil, fmt.Errorf("channel not found")
	}
	if ch.Type != constant.ChannelTypeCodex {
		return nil, nil, fmt.Errorf("channel type is not Codex")
	}

	oauthKey, err := parseCodexOAuthKey(strings.TrimSpace(ch.Key))
	if err != nil {
		return nil, nil, err
	}
	if strings.TrimSpace(oauthKey.Tokens.RefreshToken) == "" {
		return nil, nil, fmt.Errorf("codex channel: refresh_token is required to refresh credential")
	}

	refreshCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	res, err := RefreshCodexOAuthTokenWithProxy(refreshCtx, oauthKey.Tokens.RefreshToken, ch.GetSetting().Proxy)
	if err != nil {
		return nil, nil, err
	}

	if strings.TrimSpace(res.IDToken) != "" {
		oauthKey.Tokens.IDToken = res.IDToken
	}
	oauthKey.Tokens.AccessToken = res.AccessToken
	oauthKey.Tokens.RefreshToken = res.RefreshToken
	oauthKey.Expired = res.ExpiresAt.Format(time.RFC3339)
	if strings.TrimSpace(oauthKey.Type) == "" {
		oauthKey.Type = "codex"
	}

	if strings.TrimSpace(oauthKey.Tokens.AccountID) == "" {
		if accountID, ok := ExtractCodexAccountIDFromJWT(oauthKey.Tokens.AccessToken); ok {
			oauthKey.Tokens.AccountID = accountID
		}
	}
	if strings.TrimSpace(oauthKey.Email) == "" {
		if email, ok := ExtractEmailFromJWT(oauthKey.Tokens.AccessToken); ok {
			oauthKey.Email = email
		}
	}

	encoded, err := common.Marshal(oauthKey)
	if err != nil {
		return nil, nil, err
	}

	if err := model.DB.Model(&model.Channel{}).Where("id = ?", ch.Id).Update("key", string(encoded)).Error; err != nil {
		return nil, nil, err
	}

	if opts.ResetCaches {
		model.InitChannelCache()
		ResetProxyClientCache()
	}

	return oauthKey, ch, nil
}
