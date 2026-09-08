package codex

import (
	"errors"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

type OAuthTokens struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	AccountID    string `json:"account_id"`
}

type OAuthKey struct {
	Tokens OAuthTokens `json:"tokens"`

	// Internal metadata used by channel refresh and account display.
	Expired string `json:"-"`
	Email   string `json:"-"`
	Type    string `json:"-"`
}

func ParseOAuthKey(raw string) (*OAuthKey, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, errors.New("codex channel: empty oauth key")
	}
	var key OAuthKey
	if err := common.Unmarshal([]byte(raw), &key); err != nil {
		return nil, errors.New("codex channel: invalid oauth key json")
	}
	if strings.TrimSpace(key.Tokens.IDToken) == "" {
		return nil, errors.New("codex channel: tokens.id_token is required")
	}
	if strings.TrimSpace(key.Tokens.AccessToken) == "" {
		return nil, errors.New("codex channel: tokens.access_token is required")
	}
	if strings.TrimSpace(key.Tokens.RefreshToken) == "" {
		return nil, errors.New("codex channel: tokens.refresh_token is required")
	}
	if strings.TrimSpace(key.Tokens.AccountID) == "" {
		return nil, errors.New("codex channel: tokens.account_id is required")
	}
	return &key, nil
}
