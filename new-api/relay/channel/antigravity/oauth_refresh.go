package antigravity

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/service"
)

var (
	antigravityOAuthClientID     = ""
	antigravityOAuthClientSecret = ""
	antigravityOAuthTokenURL     = "https://oauth2.googleapis.com/token"
	antigravityRefreshThreshold  = 5 * time.Minute
	antigravityRefreshTimeout    = 20 * time.Second
)

func init() {
	antigravityOAuthClientID = os.Getenv("ANTIGRAVITY_OAUTH_CLIENT_ID")
	antigravityOAuthClientSecret = os.Getenv("ANTIGRAVITY_OAUTH_CLIENT_SECRET")
}

type antigravityOAuthTokenResult struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	TokenType    string `json:"token_type"`
	IDToken      string `json:"id_token"`
}

func maybeRefreshAntigravityOAuthKey(ctx context.Context, key *OAuthKey, info *relaycommon.RelayInfo) (*OAuthKey, error) {
	if key == nil {
		return nil, errors.New("antigravity channel: nil oauth key")
	}
	if !antigravityOAuthKeyNeedsRefresh(key) {
		return key, nil
	}
	if strings.TrimSpace(key.RefreshToken) == "" {
		return nil, errors.New("antigravity channel: refresh_token is required to refresh expired credential")
	}

	refreshCtx, cancel := context.WithTimeout(ctx, antigravityRefreshTimeout)
	defer cancel()

	res, err := refreshAntigravityOAuthToken(refreshCtx, key.RefreshToken, info.ChannelSetting.Proxy)
	if err != nil {
		return nil, err
	}

	updated := *key
	updated.AccessToken = strings.TrimSpace(res.AccessToken)
	if strings.TrimSpace(res.RefreshToken) != "" {
		updated.RefreshToken = strings.TrimSpace(res.RefreshToken)
	}
	if strings.TrimSpace(res.TokenType) != "" {
		updated.TokenType = strings.TrimSpace(res.TokenType)
	} else if strings.TrimSpace(updated.TokenType) == "" {
		updated.TokenType = "Bearer"
	}
	if strings.TrimSpace(res.IDToken) != "" {
		updated.IDToken = strings.TrimSpace(res.IDToken)
	}
	if res.ExpiresIn > 0 {
		expiresAt := time.Now().Add(time.Duration(res.ExpiresIn) * time.Second)
		updated.ExpiresIn = res.ExpiresIn
		updated.ExpiryTimestamp = expiresAt.UnixMilli()
		updated.Expired = expiresAt.Format(time.RFC3339)
	}
	if strings.TrimSpace(updated.OAuthClientKey) == "" {
		updated.OAuthClientKey = "antigravity_enterprise"
	}
	if strings.TrimSpace(updated.Type) == "" {
		updated.Type = "antigravity"
	}

	encoded, err := common.Marshal(&updated)
	if err != nil {
		return nil, err
	}
	if err := persistRefreshedAntigravityOAuthKey(info, string(encoded)); err != nil {
		return nil, err
	}
	return &updated, nil
}

func antigravityOAuthKeyNeedsRefresh(key *OAuthKey) bool {
	expiresAt, ok := antigravityOAuthKeyExpiresAt(key)
	if !ok {
		return strings.TrimSpace(key.RefreshToken) != ""
	}
	return time.Until(expiresAt) <= antigravityRefreshThreshold
}

func antigravityOAuthKeyExpiresAt(key *OAuthKey) (time.Time, bool) {
	if key == nil {
		return time.Time{}, false
	}
	if key.ExpiryTimestamp > 0 {
		ts := key.ExpiryTimestamp
		if ts > 1_000_000_000_000 {
			return time.UnixMilli(ts), true
		}
		return time.Unix(ts, 0), true
	}
	if strings.TrimSpace(key.Expired) != "" {
		if t, err := time.Parse(time.RFC3339, strings.TrimSpace(key.Expired)); err == nil {
			return t, true
		}
		if t, err := time.Parse("2006-01-02 15:04:05", strings.TrimSpace(key.Expired)); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func refreshAntigravityOAuthToken(ctx context.Context, refreshToken string, proxyURL string) (*antigravityOAuthTokenResult, error) {
	rt := strings.TrimSpace(refreshToken)
	if rt == "" {
		return nil, errors.New("empty refresh_token")
	}

	client, err := service.GetHttpClientWithProxy(strings.TrimSpace(proxyURL))
	if err != nil {
		return nil, err
	}
	if client == nil {
		client = &http.Client{Timeout: antigravityRefreshTimeout}
	} else {
		clientCopy := *client
		clientCopy.Timeout = antigravityRefreshTimeout
		client = &clientCopy
	}

	form := url.Values{}
	form.Set("client_id", antigravityOAuthClientID)
	form.Set("client_secret", antigravityOAuthClientSecret)
	form.Set("refresh_token", rt)
	form.Set("grant_type", "refresh_token")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, antigravityOAuthTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer service.CloseResponseBodyGracefully(resp)

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("antigravity oauth refresh failed: status=%d body=%s", resp.StatusCode, string(body))
	}

	var payload antigravityOAuthTokenResult
	if err := common.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	if strings.TrimSpace(payload.AccessToken) == "" || payload.ExpiresIn <= 0 {
		return nil, errors.New("antigravity oauth refresh response missing fields")
	}
	return &payload, nil
}

func persistRefreshedAntigravityOAuthKey(info *relaycommon.RelayInfo, encodedKey string) error {
	if info == nil || info.ChannelId <= 0 {
		return nil
	}

	lock := model.GetChannelPollingLock(info.ChannelId)
	lock.Lock()
	defer lock.Unlock()

	ch, err := model.GetChannelById(info.ChannelId, true)
	if err != nil {
		return err
	}
	if ch == nil {
		return fmt.Errorf("channel not found")
	}

	keyToStore := encodedKey
	if ch.ChannelInfo.IsMultiKey {
		keys := ch.GetKeys()
		idx := info.ChannelMultiKeyIndex
		if idx < 0 || idx >= len(keys) {
			return fmt.Errorf("antigravity channel: multi-key index %d out of range", idx)
		}
		keys[idx] = encodedKey
		keyToStore = strings.Join(keys, "\n")
	}

	if err := model.DB.Model(&model.Channel{}).Where("id = ?", ch.Id).Update("key", keyToStore).Error; err != nil {
		return err
	}
	model.InitChannelCache()
	service.ResetProxyClientCache()
	return nil
}
