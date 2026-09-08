package antigravity

import (
	"errors"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
)

type OAuthKey struct {
	AccessToken  string `json:"access_token,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
	IDToken      string `json:"id_token,omitempty"`

	Email           string `json:"email,omitempty"`
	TokenType       string `json:"token_type,omitempty"`
	ExpiresIn       int    `json:"expires_in,omitempty"`
	ExpiryTimestamp int64  `json:"expiry_timestamp,omitempty"`
	Expired         string `json:"expired,omitempty"`
	OAuthClientKey  string `json:"oauth_client_key,omitempty"`
	ProjectID       string `json:"project_id,omitempty"`
	SessionID       string `json:"session_id,omitempty"`
	Type            string `json:"type,omitempty"`
}

type credentialStoreOAuthKey struct {
	Token OAuthKey `json:"token"`
}

func ParseOAuthKey(raw string) (*OAuthKey, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, errors.New("antigravity channel: empty oauth key")
	}
	var key OAuthKey
	if err := common.Unmarshal([]byte(raw), &key); err != nil {
		return nil, errors.New("antigravity channel: invalid oauth key json")
	}
	if strings.TrimSpace(key.AccessToken) == "" {
		var wrapped credentialStoreOAuthKey
		if err := common.Unmarshal([]byte(raw), &wrapped); err == nil {
			key = wrapped.Token
		}
	}
	if strings.TrimSpace(key.Expired) == "" {
		var payload struct {
			Expiry string `json:"expiry"`
			Token  struct {
				Expiry string `json:"expiry"`
			} `json:"token"`
		}
		if err := common.Unmarshal([]byte(raw), &payload); err == nil {
			key.Expired = strings.TrimSpace(payload.Expiry)
			if key.Expired == "" {
				key.Expired = strings.TrimSpace(payload.Token.Expiry)
			}
		}
	}
	if key.ExpiryTimestamp == 0 && strings.TrimSpace(key.Expired) != "" {
		if expiry, ok := parseOAuthExpiry(key.Expired); ok {
			key.ExpiryTimestamp = expiry.UnixMilli()
		}
	}
	if strings.TrimSpace(key.AccessToken) == "" {
		return nil, errors.New("antigravity channel: access_token is required")
	}
	return &key, nil
}

func parseOAuthExpiry(value string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, strings.TrimSpace(value)); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
