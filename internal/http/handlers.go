package httpapi

import (
	"encoding/json"
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

func (a *API) handleProducts(w http.ResponseWriter, r *http.Request) {
	agg, err := a.catalog.AggregateProducts(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, agg)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
