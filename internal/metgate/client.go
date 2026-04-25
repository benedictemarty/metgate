package metgate

import (
	"context"
	"fmt"
	"io"
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
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *Client) get(ctx context.Context, path string, query url.Values) ([]byte, int, error) {
	u, err := url.Parse(c.baseURL)
	if err != nil {
		return nil, 0, fmt.Errorf("base url: %w", err)
	}
	u.Path = path
	if query != nil {
		u.RawQuery = query.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json, application/xml;q=0.9, */*;q=0.1")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}

// GetCapabilities appelle /broker_service/catalog en mode OGC GetCapabilities.
// service vaut typiquement "RAW", "WFS" ou "WCS".
func (c *Client) GetCapabilities(ctx context.Context, service, version string) ([]byte, int, error) {
	q := url.Values{}
	q.Set("service", service)
	q.Set("version", version)
	q.Set("request", "GetCapabilities")
	return c.get(ctx, "/broker_service/catalog", q)
}
