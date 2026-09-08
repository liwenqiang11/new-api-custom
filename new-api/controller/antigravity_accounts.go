package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relay/channel/antigravity"
	"github.com/gin-gonic/gin"
)

type antigravityAccountInspectRequest struct {
	Credentials any `json:"credentials"`
}

func GetAntigravityChannelAccounts(c *gin.Context) {
	channelID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		common.ApiError(c, fmt.Errorf("invalid channel id: %w", err))
		return
	}

	ch, err := model.GetChannelById(channelID, true)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if ch == nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "channel not found"})
		return
	}
	if ch.Type != constant.ChannelTypeAntigravity {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "channel type is not Antigravity"})
		return
	}

	managerBaseURL := strings.TrimRight(strings.TrimSpace(antigravityManagerBaseURLForController()), "/")
	if managerBaseURL == "" {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "antigravity manager is not enabled"})
		return
	}

	credentials, err := antigravity.BuildManagerCredentialPayload(strings.TrimSpace(ch.Key))
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": err.Error()})
		return
	}
	if len(credentials) == 0 {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "no Antigravity credentials found"})
		return
	}

	requestBody, err := common.Marshal(antigravityAccountInspectRequest{
		Credentials: credentials,
	})
	if err != nil {
		common.ApiError(c, err)
		return
	}

	reqCtx, cancel := context.WithTimeout(c.Request.Context(), 45*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(
		reqCtx,
		http.MethodPost,
		managerBaseURL+"/v1/internal/accounts/inspect",
		bytes.NewReader(requestBody),
	)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey := antigravityManagerAPIKeyForController(); apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	client := &http.Client{Timeout: 50 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		common.SysError("failed to inspect antigravity accounts: " + err.Error())
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "failed to query antigravity account info"})
		return
	}
	defer resp.Body.Close()

	body, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		common.SysError("failed to read antigravity account inspect response: " + readErr.Error())
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "failed to read antigravity account info"})
		return
	}

	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		payload = string(body)
	}

	ok := resp.StatusCode >= 200 && resp.StatusCode < 300
	response := gin.H{
		"success":         ok,
		"message":         "",
		"upstream_status": resp.StatusCode,
		"data":            payload,
	}
	if !ok {
		response["message"] = fmt.Sprintf("upstream status: %d", resp.StatusCode)
	}
	c.JSON(http.StatusOK, response)
}

func antigravityManagerBaseURLForController() string {
	return strings.TrimRight(strings.TrimSpace(common.GetEnvOrDefaultString("ANTIGRAVITY_MANAGER_BASE_URL", "")), "/")
}

func antigravityManagerAPIKeyForController() string {
	return strings.TrimSpace(common.GetEnvOrDefaultString("ANTIGRAVITY_MANAGER_API_KEY", ""))
}
