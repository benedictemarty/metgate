package metgate

import (
	"context"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"time"
)

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{
		baseURL: baseURL,
		token:   token,
		http:    &http.Client{Timeout: 90 * time.Second},
	}
}

// Response contient une réponse MetGate brute, content-type inclus.
type Response struct {
	Body        []byte
	ContentType string
	Status      int
	FromCache   bool // renseigné par la couche cache, pas par le client HTTP
	CacheAge    int  // secondes depuis mise en cache (0 si MISS ou cache désactivé)
}

func (c *Client) get(ctx context.Context, path string, query url.Values) (*Response, error) {
	u, err := url.Parse(c.baseURL)
	if err != nil {
		return nil, fmt.Errorf("base url: %w", err)
	}
	u.Path = path
	if query != nil {
		u.RawQuery = query.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json, application/xml;q=0.9, */*;q=0.1")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return &Response{
		Body:        body,
		ContentType: resp.Header.Get("Content-Type"),
		Status:      resp.StatusCode,
	}, nil
}

// isRetryable retourne true si le status HTTP justifie un retry
// (429 rate-limit ou 5xx erreur serveur transitoire).
func isRetryable(status int) bool {
	return status == http.StatusTooManyRequests || status >= 500
}

// Get effectue un GET avec retry exponentiel (×2, max 3 tentatives, jitter)
// sur les erreurs transitoires 429 et 5xx. Les erreurs réseau et les 4xx
// autres que 429 ne sont pas retentées.
func (c *Client) Get(ctx context.Context, path string, query url.Values) (*Response, error) {
	const maxAttempts = 3
	delay := 500 * time.Millisecond

	var last *Response
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			// Jitter ±25 % du délai pour éviter les tempêtes de retry synchronisées.
			jitter := time.Duration(rand.Float64()*0.5*float64(delay)) - delay/4
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay + jitter):
			}
			delay *= 2
		}

		resp, err := c.get(ctx, path, query)
		if err != nil {
			// Erreur réseau : retry immédiat (peut être un timeout transitoire).
			if attempt < maxAttempts-1 {
				continue
			}
			return nil, err
		}

		if !isRetryable(resp.Status) {
			return resp, nil
		}
		last = resp
	}
	return last, nil
}

// GetCapabilities appelle /broker_service/catalog en mode OGC GetCapabilities.
// service vaut typiquement "RAW", "WFS" ou "WCS".
func (c *Client) GetCapabilities(ctx context.Context, service, version string) ([]byte, int, error) {
	q := url.Values{}
	q.Set("service", service)
	q.Set("version", version)
	q.Set("request", "GetCapabilities")
	r, err := c.Get(ctx, "/broker_service/catalog", q)
	if err != nil {
		return nil, 0, err
	}
	return r.Body, r.Status, nil
}
