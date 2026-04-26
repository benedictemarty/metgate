package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/bmarty/metgate/internal/catalog"
	"github.com/bmarty/metgate/internal/web"
)

type API struct {
	catalog *catalog.Service
}

func NewAPI(c *catalog.Service) *API {
	return &API{catalog: c}
}

func (a *API) Routes() *http.ServeMux {
	m := http.NewServeMux()
	m.HandleFunc("GET /healthz", a.healthz)
	m.HandleFunc("GET /api/catalog", a.handleCatalog)
	m.HandleFunc("GET /api/products", a.handleProducts)
	m.HandleFunc("GET /api/wfs", a.proxyTo("/broker_service/WFS"))
	m.HandleFunc("GET /api/wcs", a.proxyTo("/broker_service/WCS"))
	m.HandleFunc("GET /api/raw", a.proxyTo("/broker_service/RAW"))
	m.HandleFunc("GET /api/feature", a.handleFeature)
	m.HandleFunc("GET /api/wind", a.handleWind)
	m.Handle("GET /", web.Handler())
	return m
}

func (a *API) healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (a *API) handleCatalog(w http.ResponseWriter, r *http.Request) {
	service := strings.ToUpper(r.URL.Query().Get("service"))
	if service == "" {
		service = "RAW"
	}

	switch service {
	case "RAW":
		products, err := a.catalog.RawProducts(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"service":  "RAW",
			"count":    len(products),
			"products": products,
		})
	case "WFS", "WCS":
		version := r.URL.Query().Get("version")
		if version == "" {
			if service == "WFS" {
				version = "2.0.0"
			} else {
				version = "2.0.1"
			}
		}
		body, status, err := a.catalog.Capabilities(r.Context(), service, version)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write(body)
	default:
		http.Error(w, "service must be RAW, WFS or WCS", http.StatusBadRequest)
	}
}

// handleWind récupère le coverage WIND le plus récent (subset niveau + bbox)
// et renvoie la grille u/v décodée en JSON.
// Usage: /api/wind?bbox=-15,35,30,65&level=85000
func (a *API) handleWind(w http.ResponseWriter, r *http.Request) {
	bboxStr := r.URL.Query().Get("bbox")
	if bboxStr == "" {
		bboxStr = "-15,35,30,65"
	}
	var bbox [4]float64
	if _, err := fmt.Sscanf(bboxStr, "%f,%f,%f,%f", &bbox[0], &bbox[1], &bbox[2], &bbox[3]); err != nil {
		http.Error(w, "bbox doit être lonMin,latMin,lonMax,latMax", http.StatusBadRequest)
		return
	}
	level := 85000.0
	if v := r.URL.Query().Get("level"); v != "" {
		fmt.Sscanf(v, "%f", &level)
	}
	grid, err := a.catalog.WindGrid(r.Context(), level, bbox)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, grid)
}

// handleFeature relaie un WFS GetFeature de MetGate (GML) en GeoJSON.
// Usage: /api/feature?type=METAR_last&count=200
func (a *API) handleFeature(w http.ResponseWriter, r *http.Request) {
	typeName := r.URL.Query().Get("type")
	if typeName == "" {
		http.Error(w, "param 'type' requis (ex: METAR_last)", http.StatusBadRequest)
		return
	}
	count := 0
	if c := r.URL.Query().Get("count"); c != "" {
		fmt.Sscanf(c, "%d", &count)
	}
	geo, fromCache, err := a.catalog.FeatureGeoJSON(r.Context(), typeName, count)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/geo+json; charset=utf-8")
	w.Header().Set("X-Cache", cacheHeader(fromCache))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(geo)
}

func cacheHeader(hit bool) string {
	if hit {
		return "HIT"
	}
	return "MISS"
}

func (a *API) handleProducts(w http.ResponseWriter, r *http.Request) {
	agg, err := a.catalog.AggregateProducts(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, agg)
}

// proxyTo relaie GET ?... vers le path MetGate donné, en réinjectant les query
// params reçus, et en restituant content-type/status/body. Le token Bearer
// reste côté serveur. Le cache est appliqué en amont par catalog.Proxy.
func (a *API) proxyTo(metgatePath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resp, err := a.catalog.Proxy(r.Context(), metgatePath, r.URL.Query())
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		ct := resp.ContentType
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("X-Cache", cacheHeader(resp.FromCache))
		w.WriteHeader(resp.Status)
		_, _ = w.Write(resp.Body)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
