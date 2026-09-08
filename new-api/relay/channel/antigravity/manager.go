package antigravity

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
)

const defaultAntigravityManagerCredentialsFile = "/data/antigravity-manager-credentials.json"
const managerCredentialsHeader = "X-Antigravity-Newapi-Credentials"
const managerChannelScopeHeader = "X-Antigravity-Newapi-Scope"
const managerRequestedModelHeader = "X-Antigravity-Newapi-Model"

type managerCredential struct {
	AccessToken     string `json:"access_token"`
	RefreshToken    string `json:"refresh_token"`
	IDToken         string `json:"id_token,omitempty"`
	Email           string `json:"email,omitempty"`
	TokenType       string `json:"token_type"`
	ExpiresIn       int    `json:"expires_in"`
	ExpiryTimestamp int64  `json:"expiry_timestamp"`
	OAuthClientKey  string `json:"oauth_client_key,omitempty"`
	ProjectID       string `json:"project_id,omitempty"`
	SessionID       string `json:"session_id,omitempty"`
}

func BuildManagerCredentialPayload(rawKey string) ([]managerCredential, error) {
	return parseManagerCredentials(rawKey)
}

func BuildManagerCredentialHeader(rawKey string) (string, error) {
	credentials, err := parseManagerCredentials(rawKey)
	if err != nil {
		return "", err
	}
	if len(credentials) == 0 {
		return "", errors.New("antigravity manager: no oauth credentials to forward")
	}
	body, err := json.Marshal(credentials)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(body), nil
}

func antigravityManagerBaseURL() string {
	baseURL := strings.TrimRight(strings.TrimSpace(os.Getenv("ANTIGRAVITY_MANAGER_BASE_URL")), "/")
	if baseURL == "" || baseURL == "0" || strings.EqualFold(baseURL, "false") {
		return ""
	}
	return baseURL
}

func antigravityManagerAPIKey() string {
	return strings.TrimSpace(os.Getenv("ANTIGRAVITY_MANAGER_API_KEY"))
}

func antigravityManagerCredentialsFile() string {
	path := strings.TrimSpace(os.Getenv("ANTIGRAVITY_MANAGER_CREDENTIALS_FILE"))
	if path == "" {
		path = defaultAntigravityManagerCredentialsFile
	}
	return path
}

func syncAntigravityManagerCredentials(rawKey string) error {
	credentials, err := parseManagerCredentials(rawKey)
	if err != nil {
		return err
	}
	if len(credentials) == 0 {
		return errors.New("antigravity manager: no oauth credentials to sync")
	}

	path := antigravityManagerCredentialsFile()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(credentials, "", "  ")
	if err != nil {
		return err
	}
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(bytes.TrimSpace(existing), bytes.TrimSpace(body)) {
		return nil
	}
	tmp := fmt.Sprintf("%s.%d.tmp", path, time.Now().UnixNano())
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func parseManagerCredentials(rawKey string) ([]managerCredential, error) {
	rawKey = strings.TrimSpace(rawKey)
	if rawKey == "" {
		return nil, errors.New("antigravity manager: empty oauth key")
	}

	var rawItems []json.RawMessage
	if err := common.Unmarshal([]byte(rawKey), &rawItems); err == nil && len(rawItems) > 0 {
		return parseManagerCredentialItems(rawItems)
	}

	lines := strings.Split(rawKey, "\n")
	if len(lines) > 1 {
		rawItems = rawItems[:0]
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			rawItems = append(rawItems, json.RawMessage(line))
		}
		if len(rawItems) > 0 {
			return parseManagerCredentialItems(rawItems)
		}
	}

	key, err := ParseOAuthKey(rawKey)
	if err != nil {
		return nil, err
	}
	return []managerCredential{managerCredentialFromOAuthKey(key)}, nil
}

func parseManagerCredentialItems(items []json.RawMessage) ([]managerCredential, error) {
	credentials := make([]managerCredential, 0, len(items))
	for index, item := range items {
		key, err := ParseOAuthKey(string(item))
		if err != nil {
			return nil, fmt.Errorf("antigravity manager: invalid oauth key at index %d: %w", index, err)
		}
		credentials = append(credentials, managerCredentialFromOAuthKey(key))
	}
	return credentials, nil
}

func managerCredentialFromOAuthKey(key *OAuthKey) managerCredential {
	tokenType := strings.TrimSpace(key.TokenType)
	if tokenType == "" {
		tokenType = "Bearer"
	}
	expiresIn := key.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = 3600
	}
	expiryTimestamp := key.ExpiryTimestamp
	if expiryTimestamp > 1_000_000_000_000 {
		expiryTimestamp = expiryTimestamp / 1000
	}
	if expiryTimestamp <= 0 {
		expiryTimestamp = time.Now().Add(time.Duration(expiresIn) * time.Second).Unix()
	}
	return managerCredential{
		AccessToken:     strings.TrimSpace(key.AccessToken),
		RefreshToken:    strings.TrimSpace(key.RefreshToken),
		IDToken:         strings.TrimSpace(key.IDToken),
		Email:           strings.TrimSpace(key.Email),
		TokenType:       tokenType,
		ExpiresIn:       expiresIn,
		ExpiryTimestamp: expiryTimestamp,
		OAuthClientKey:  strings.TrimSpace(key.OAuthClientKey),
		ProjectID:       strings.TrimSpace(key.ProjectID),
		SessionID:       strings.TrimSpace(key.SessionID),
	}
}
