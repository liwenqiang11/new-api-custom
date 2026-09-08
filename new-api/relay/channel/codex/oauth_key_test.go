package codex

import (
	"encoding/json"
	"testing"
)

func TestParseOAuthKeyRequiresNestedCredential(t *testing.T) {
	raw := `{
		"tokens": {
			"id_token": "id-token",
			"access_token": "access-token",
			"refresh_token": "refresh-token",
			"account_id": "account-id"
		}
	}`

	key, err := ParseOAuthKey(raw)
	if err != nil {
		t.Fatalf("ParseOAuthKey() error = %v", err)
	}
	if key.Tokens.AccessToken != "access-token" || key.Tokens.AccountID != "account-id" {
		t.Fatalf("ParseOAuthKey() parsed unexpected tokens: %+v", key.Tokens)
	}
}

func TestParseOAuthKeyRejectsLegacyFlatCredential(t *testing.T) {
	raw := `{"id_token":"id-token","access_token":"access-token","refresh_token":"refresh-token","account_id":"account-id"}`

	if _, err := ParseOAuthKey(raw); err == nil {
		t.Fatal("ParseOAuthKey() accepted the legacy flat credential")
	}
}

func TestOAuthKeyMarshalMatchesNestedCredentialShape(t *testing.T) {
	key := OAuthKey{
		Tokens: OAuthTokens{
			IDToken:      "id-token",
			AccessToken:  "access-token",
			RefreshToken: "refresh-token",
			AccountID:    "account-id",
		},
		Expired: "internal-expiry",
		Email:   "internal@example.com",
		Type:    "codex",
	}

	encoded, err := json.Marshal(key)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("marshaled credential has unexpected top-level fields: %s", encoded)
	}
	if _, ok := got["tokens"].(map[string]any); !ok {
		t.Fatalf("marshaled credential is missing tokens object: %s", encoded)
	}
	if _, ok := got["last_refresh"]; ok {
		t.Fatalf("marshaled credential must not include last_refresh: %s", encoded)
	}
}
