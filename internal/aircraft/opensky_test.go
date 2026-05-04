package aircraft

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// TestFetchToken_FormEncodesSecrets vérifie que les credentials sont
// correctement url-encodés dans le POST OAuth2. Sans encodage, un secret
// contenant '+', '=' ou '/' (caractères courants dans les secrets base64)
// arrive corrompu côté serveur d'auth → 401 silencieux.
func TestFetchToken_FormEncodesSecrets(t *testing.T) {
	cases := []struct {
		name         string
		clientID     string
		clientSecret string
	}{
		{"alphanum", "id123", "secretABC"},
		{"plus_equals", "id+with+plus", "abc+def=="},
		{"slash_percent", "id/path", "se%cret/value"},
		{"ampersand_space", "id with space", "a&b=c"},
		{"unicode", "ïd", "sëcret"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotForm url.Values
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				vals, err := url.ParseQuery(string(body))
				if err != nil {
					t.Fatalf("body not valid form-urlencoded: %v (body=%q)", err, body)
				}
				gotForm = vals
				_ = json.NewEncoder(w).Encode(map[string]any{
					"access_token": "tok",
					"expires_in":   3600,
					"token_type":   "Bearer",
				})
			}))
			defer ts.Close()

			c := New("", "", tc.clientID, tc.clientSecret)
			c.authURL = ts.URL

			tok, err := c.fetchToken(context.Background())
			if err != nil {
				t.Fatalf("fetchToken: %v", err)
			}
			if tok != "tok" {
				t.Errorf("want token 'tok', got %q", tok)
			}
			if got := gotForm.Get("grant_type"); got != "client_credentials" {
				t.Errorf("grant_type=%q, want client_credentials", got)
			}
			if got := gotForm.Get("client_id"); got != tc.clientID {
				t.Errorf("client_id=%q, want %q", got, tc.clientID)
			}
			if got := gotForm.Get("client_secret"); got != tc.clientSecret {
				t.Errorf("client_secret=%q, want %q", got, tc.clientSecret)
			}
		})
	}
}

// TestFetchToken_CachesToken vérifie qu'un second appel rapproché ne
// re-tape pas l'authURL.
func TestFetchToken_CachesToken(t *testing.T) {
	var hits int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "tok",
			"expires_in":   3600,
		})
	}))
	defer ts.Close()

	c := New("", "", "id", "secret")
	c.authURL = ts.URL
	for i := 0; i < 3; i++ {
		if _, err := c.fetchToken(context.Background()); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if hits != 1 {
		t.Errorf("hits=%d, want 1 (token should be cached)", hits)
	}
}

// TestFetchToken_PropagatesAuthError vérifie qu'une réponse non-200 du serveur
// d'auth est remontée avec un message lisible.
func TestFetchToken_PropagatesAuthError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid_client"}`))
	}))
	defer ts.Close()

	c := New("", "", "id", "wrong")
	c.authURL = ts.URL
	_, err := c.fetchToken(context.Background())
	if err == nil {
		t.Fatal("want error on 401, got nil")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("error %q should mention status 401", err)
	}
}
