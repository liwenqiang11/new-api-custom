package antigravity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"
)

var ModelList = []string{
	"gemini-3.6-flash-high",
	"gemini-3.6-flash-low",
	"gemini-3.6-flash-high-thinking",
	"gemini-3-flash",
	"gemini-3-flash-agent",
	"gemini-3.5-flash-low",
	"gemini-3.5-flash-extra-low",
	"gemini-3.1-pro-low",
	"gemini-3.1-pro-high",
	"gemini-pro-agent",
	"gemini-3.1-flash-lite",
	"gemini-3.1-flash-image",
	"gemini-2.5-pro",
	"gemini-2.5-flash",
	"gemini-2.5-flash-lite",
	"gemini-2.5-flash-thinking",
	"claude-sonnet-4-6",
	"claude-opus-4-6-thinking",
	"gpt-oss-120b-medium",
}

const (
	antigravityModelFetchTimeout = 30 * time.Second
	antigravityUserAgent         = "antigravity/1.99.9"
)

var antigravityProjectEndpoints = []string{
	"https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
	"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
}

var antigravityModelEndpoints = []string{
	"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
	"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
	"https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
}

type antigravityProjectResponse struct {
	ProjectID string `json:"cloudaicompanionProject"`
}

type antigravityModelInfo struct {
	DisplayName string `json:"displayName"`
}

type antigravityModelsResponse struct {
	Models map[string]antigravityModelInfo `json:"models"`
}

func FetchAntigravityModels(_ string, rawKey string, proxyURL string) ([]string, error) {
	key, err := ParseOAuthKey(rawKey)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), antigravityModelFetchTimeout)
	defer cancel()

	if antigravityOAuthKeyNeedsRefresh(key) {
		if strings.TrimSpace(key.RefreshToken) == "" {
			return nil, errors.New("antigravity channel: refresh_token is required to fetch models with expired credential")
		}
		refreshed, err := refreshAntigravityOAuthToken(ctx, key.RefreshToken, proxyURL)
		if err != nil {
			return nil, err
		}
		key.AccessToken = strings.TrimSpace(refreshed.AccessToken)
	}

	client, err := service.GetHttpClientWithProxy(strings.TrimSpace(proxyURL))
	if err != nil {
		return nil, err
	}
	if client == nil {
		client = &http.Client{Timeout: antigravityModelFetchTimeout}
	} else {
		clientCopy := *client
		clientCopy.Timeout = antigravityModelFetchTimeout
		client = &clientCopy
	}

	projectID := fetchAntigravityProjectID(ctx, client, key.AccessToken)
	models, err := fetchAntigravityModelsFromEndpoints(ctx, client, key.AccessToken, projectID)
	if err != nil {
		return nil, err
	}
	return normalizeAntigravityModelIDs(models), nil
}

func fetchAntigravityProjectID(ctx context.Context, client *http.Client, accessToken string) string {
	payload := map[string]any{
		"metadata": map[string]any{
			"ideType": "ANTIGRAVITY",
		},
	}
	for _, endpoint := range antigravityProjectEndpoints {
		body, status, err := postAntigravityJSON(ctx, client, endpoint, accessToken, payload)
		if err != nil || status < 200 || status >= 300 {
			continue
		}
		var result antigravityProjectResponse
		if err := common.Unmarshal(body, &result); err == nil && strings.TrimSpace(result.ProjectID) != "" {
			return strings.TrimSpace(result.ProjectID)
		}
	}
	return ""
}

func fetchAntigravityModelsFromEndpoints(ctx context.Context, client *http.Client, accessToken string, projectID string) ([]string, error) {
	var lastErr error
	for _, endpoint := range antigravityModelEndpoints {
		models, err := fetchAntigravityModelsFromEndpoint(ctx, client, endpoint, accessToken, projectID)
		if err == nil {
			return models, nil
		}
		lastErr = err
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, errors.New("antigravity channel: no model endpoint configured")
}

func fetchAntigravityModelsFromEndpoint(ctx context.Context, client *http.Client, endpoint string, accessToken string, projectID string) ([]string, error) {
	payload := map[string]any{}
	if strings.TrimSpace(projectID) != "" {
		payload["project"] = strings.TrimSpace(projectID)
	}

	body, status, err := postAntigravityJSON(ctx, client, endpoint, accessToken, payload)
	if err != nil {
		return nil, err
	}
	if status == http.StatusForbidden && len(payload) > 0 {
		body, status, err = postAntigravityJSON(ctx, client, endpoint, accessToken, map[string]any{})
		if err != nil {
			return nil, err
		}
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("antigravity channel: fetch models failed status=%d body=%s", status, string(body))
	}

	var result antigravityModelsResponse
	if err := common.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	models := make([]string, 0, len(result.Models))
	for id := range result.Models {
		models = append(models, id)
	}
	return models, nil
}

func postAntigravityJSON(ctx context.Context, client *http.Client, endpoint string, accessToken string, payload any) ([]byte, int, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", antigravityUserAgent)

	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer service.CloseResponseBodyGracefully(resp)

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return respBody, resp.StatusCode, nil
}

func normalizeAntigravityModelIDs(models []string) []string {
	seen := make(map[string]bool, len(models))
	out := make([]string, 0, len(models))
	for _, model := range models {
		model = strings.TrimPrefix(strings.TrimSpace(model), "models/")
		if model == "" || !isAntigravityGenerativeModel(model) || seen[model] {
			continue
		}
		seen[model] = true
		out = append(out, model)
	}
	sort.Strings(out)
	return out
}

func isAntigravityGenerativeModel(model string) bool {
	lower := strings.ToLower(strings.TrimSpace(model))
	return strings.HasPrefix(lower, "gemini") ||
		strings.HasPrefix(lower, "claude") ||
		strings.HasPrefix(lower, "gpt") ||
		strings.HasPrefix(lower, "image") ||
		strings.HasPrefix(lower, "imagen")
}
