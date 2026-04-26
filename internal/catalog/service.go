package catalog

import (
	"context"
	"encoding/csv"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/bmarty/metgate/internal/metgate"
)

// RawProduct est une ligne du catalogue RAW de MetGate (ex: COMPOSITE radar).
type RawProduct struct {
	Name         string `json:"name"`
	Type         string `json:"type"`
	DateInstance string `json:"date_instance"`
	InsertDate   string `json:"insert_date"`
	Size         int64  `json:"size"`
	Checksum     string `json:"checksum"`
}

type Service struct {
	mg    *metgate.Client
	cache *responseCache
}

// New construit le service avec un cache TTL pour les réponses MetGate.
// ttl <= 0 désactive le cache.
func New(mg *metgate.Client, ttl time.Duration) *Service {
	return &Service{mg: mg, cache: newResponseCache(ttl)}
}

// fetchCached récupère une réponse via le cache, en repassant à mg.Get sur miss.
func (s *Service) fetchCached(ctx context.Context, path string, query url.Values) (*metgate.Response, error) {
	return s.cache.get(ctx, path, query, func(ctx context.Context) (*metgate.Response, error) {
		return s.mg.Get(ctx, path, query)
	})
}

// fetchCapabilities est l'équivalent caché de mg.GetCapabilities.
func (s *Service) fetchCapabilities(ctx context.Context, service, version string) (*metgate.Response, error) {
	q := url.Values{}
	q.Set("service", service)
	q.Set("version", version)
	q.Set("request", "GetCapabilities")
	return s.fetchCached(ctx, "/broker_service/catalog", q)
}

// RawProducts interroge MetGate (service=RAW) et parse le CSV en objets typés.
func (s *Service) RawProducts(ctx context.Context) ([]RawProduct, error) {
	resp, err := s.fetchCapabilities(ctx, "RAW", "1.0.0")
	if err != nil {
		return nil, err
	}
	if resp.Status != 200 {
		return nil, fmt.Errorf("metgate RAW: status %d", resp.Status)
	}

	r := csv.NewReader(strings.NewReader(string(resp.Body)))
	rows, err := r.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("csv parse: %w", err)
	}
	if len(rows) < 2 {
		return nil, nil
	}

	out := make([]RawProduct, 0, len(rows)-1)
	for _, row := range rows[1:] {
		if len(row) < 6 {
			continue
		}
		size, _ := strconv.ParseInt(row[4], 10, 64)
		out = append(out, RawProduct{
			Name:         row[0],
			Type:         row[1],
			DateInstance: row[2],
			InsertDate:   row[3],
			Size:         size,
			Checksum:     row[5],
		})
	}
	return out, nil
}

// Capabilities renvoie la réponse brute de MetGate (utile pour WFS/WCS en XML).
func (s *Service) Capabilities(ctx context.Context, service, version string) ([]byte, int, error) {
	resp, err := s.fetchCapabilities(ctx, service, version)
	if err != nil {
		return nil, 0, err
	}
	return resp.Body, resp.Status, nil
}

// Proxy effectue un GET sur MetGate via le cache (content-type, status, body).
// Utilisé par les routes /api/wfs et /api/wcs pour relayer GetFeature/GetCoverage.
func (s *Service) Proxy(ctx context.Context, path string, query url.Values) (*metgate.Response, error) {
	return s.fetchCached(ctx, path, query)
}

// FeatureGeoJSON tape WFS GetFeature en GML 3.2 (via cache) puis convertit
// en GeoJSON. typeName ex: "METAR_last", count limite le nombre de features.
// Renvoie le GeoJSON et indique si la réponse MetGate venait du cache.
func (s *Service) FeatureGeoJSON(ctx context.Context, typeName string, count int) ([]byte, bool, error) {
	q := url.Values{}
	q.Set("service", "WFS")
	q.Set("version", "2.0.0")
	q.Set("request", "GetFeature")
	q.Set("typeNames", typeName)
	if count > 0 {
		q.Set("count", strconv.Itoa(count))
	}
	resp, err := s.fetchCached(ctx, "/broker_service/WFS", q)
	if err != nil {
		return nil, false, err
	}
	if resp.Status != 200 {
		return nil, false, fmt.Errorf("metgate WFS GetFeature %s: status %d (body=%q)",
			typeName, resp.Status, truncate(resp.Body, 200))
	}
	geo, err := GMLToGeoJSON(resp.Body)
	if err != nil {
		return nil, false, err
	}
	return geo, resp.FromCache, nil
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "..."
}
