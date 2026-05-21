// Package eumetsat fournit un client OAuth2 minimal pour l'API
// api.eumetsat.int : token client_credentials, recherche du dernier produit
// d'une collection, téléchargement.
//
// Utilisé par les services foudre (LI-LFL) et cloud top (FCI-CTTH).
// Source à titre situationnel ; non OPMET.
package eumetsat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	tokenURL     = "https://api.eumetsat.int/token"
	searchURL    = "https://api.eumetsat.int/data/search-products/os"
	downloadBase = "https://api.eumetsat.int/data/download/1.0.0/collections"
)

type Client struct {
	consumerKey    string
	consumerSecret string
	httpClient     *http.Client

	mu       sync.Mutex
	token    string
	tokenExp time.Time
}

func New(consumerKey, consumerSecret string) *Client {
	return &Client{
		consumerKey:    consumerKey,
		consumerSecret: consumerSecret,
		httpClient:     &http.Client{Timeout: 5 * time.Minute},
	}
}

func (c *Client) Authenticated() bool {
	return c.consumerKey != "" && c.consumerSecret != ""
}

func (c *Client) Token(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Now().Before(c.tokenExp.Add(-30*time.Second)) {
		return c.token, nil
	}
	req, err := http.NewRequestWithContext(ctx, "POST", tokenURL,
		strings.NewReader("grant_type=client_credentials"))
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(c.consumerKey, c.consumerSecret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close() //nolint:errcheck
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("eumetsat token: status %d (%s)", resp.StatusCode, truncate(body, 200))
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return "", err
	}
	c.token = tok.AccessToken
	c.tokenExp = time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
	return c.token, nil
}

// LatestProduct retourne (id, dlURL) du produit le plus récent de la
// collection donnée (ex: "EO:EUM:DAT:0691" pour LI-LFL, "EO:EUM:DAT:0681"
// pour FCI-CTTH).
func (c *Client) LatestProduct(ctx context.Context, collection string) (id, dlURL string, err error) {
	tok, err := c.Token(ctx)
	if err != nil {
		return "", "", err
	}
	q := url.Values{}
	q.Set("format", "json")
	q.Set("pi", collection)
	q.Set("si", "0")
	q.Set("c", "1")
	req, err := http.NewRequestWithContext(ctx, "GET", searchURL+"?"+q.Encode(), nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close() //nolint:errcheck
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", "", fmt.Errorf("eumetsat search %s: status %d (%s)", collection, resp.StatusCode, truncate(body, 200))
	}
	var sr struct {
		Features []struct {
			ID         string `json:"id"`
			Properties struct {
				Links map[string]json.RawMessage `json:"links"`
			} `json:"properties"`
		} `json:"features"`
	}
	if err := json.Unmarshal(body, &sr); err != nil {
		return "", "", err
	}
	if len(sr.Features) == 0 {
		return "", "", fmt.Errorf("eumetsat search %s: no products", collection)
	}
	f := sr.Features[0]
	id = f.ID
	if raw, ok := f.Properties.Links["data"]; ok {
		var arr []struct {
			Href string `json:"href"`
		}
		if err := json.Unmarshal(raw, &arr); err == nil && len(arr) > 0 {
			dlURL = arr[0].Href
		} else {
			var single struct {
				Href string `json:"href"`
			}
			if err := json.Unmarshal(raw, &single); err == nil {
				dlURL = single.Href
			}
		}
	}
	if dlURL == "" {
		dlURL = downloadBase + "/" + url.PathEscape(collection) + "/products/" + url.PathEscape(id)
	}
	return id, dlURL, nil
}

func (c *Client) Download(ctx context.Context, dlURL string) ([]byte, error) {
	tok, err := c.Token(ctx)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", dlURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return nil, fmt.Errorf("eumetsat download: status %d (%s)", resp.StatusCode, body)
	}
	return io.ReadAll(resp.Body)
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "..."
}
