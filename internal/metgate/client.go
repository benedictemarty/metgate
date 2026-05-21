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

// Response contient une réponse MetGate brute, content-type inclus.
type Response struct {
	Body        []byte
	ContentType string
	Status      int
	FromCache   bool // renseigné par la couche cache, pas par le client HTTP
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

// Get effectue un GET brut. Utilisé par les routes proxy /api/wfs, /api/wcs.
func (c *Client) Get(ctx context.Context, path string, query url.Values) (*Response, error) {
	return c.get(ctx, path, query)
}

// GetCapabilities appelle /broker_service/catalog en mode OGC GetCapabilities.
// service vaut typiquement "RAW", "WFS" ou "WCS".
func (c *Client) GetCapabilities(ctx context.Context, service, version string) ([]byte, int, error) {
	q := url.Values{}
	q.Set("service", service)
	q.Set("version", version)
	q.Set("request", "GetCapabilities")
	r, err := c.get(ctx, "/broker_service/catalog", q)
	if err != nil {
		return nil, 0, err
	}
	return r.Body, r.Status, nil
}
