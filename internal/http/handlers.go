package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/bmarty/metgate/internal/aircraft"
	"github.com/bmarty/metgate/internal/catalog"
	"github.com/bmarty/metgate/internal/web"
)

type API struct {
	catalog  *catalog.Service
	aircraft *aircraft.Client
}

func NewAPI(c *catalog.Service, ac *aircraft.Client) *API {
	return &API{catalog: c, aircraft: ac}
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
	m.HandleFunc("GET /api/tropo", a.handleTropo)
	m.HandleFunc("GET /api/qvacis", a.handleQvacis)
	m.HandleFunc("GET /api/route", a.handleRoute)
	m.HandleFunc("GET /api/aircraft/search", a.handleAircraftSearch)
	m.HandleFunc("GET /api/aircraft/{icao24}", a.handleAircraftState)
	m.HandleFunc("GET /api/aircraft/{icao24}/route", a.handleAircraftRoute)
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
	dataset := strings.ToUpper(r.URL.Query().Get("dataset"))
	if dataset == "" {
		dataset = "WIND"
	}
	allSteps := r.URL.Query().Get("allSteps") == "1" || r.URL.Query().Get("allSteps") == "true"
	grid, err := a.catalog.WindGrid(r.Context(), dataset, level, bbox, allSteps)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, grid)
}

// handleTropo récupère le coverage TROPO le plus récent et renvoie la
// grille d'altitude tropopause sur tous les timesteps.
// Usage: /api/tropo?bbox=-15,35,30,65
func (a *API) handleTropo(w http.ResponseWriter, r *http.Request) {
	bboxStr := r.URL.Query().Get("bbox")
	if bboxStr == "" {
		bboxStr = "-15,35,30,65"
	}
	var bbox [4]float64
	if _, err := fmt.Sscanf(bboxStr, "%f,%f,%f,%f", &bbox[0], &bbox[1], &bbox[2], &bbox[3]); err != nil {
		http.Error(w, "bbox invalide", http.StatusBadRequest)
		return
	}
	grid, err := a.catalog.TropoGrid(r.Context(), bbox)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, grid)
}

// handleAircraftSearch : /api/aircraft/search?cs=AFR1234&bbox=lonMin,latMin,lonMax,latMax
// Recherche un avion par sous-chaîne de callsign. bbox réduit la zone interrogée
// (par défaut Europe pour limiter le volume).
func (a *API) handleAircraftSearch(w http.ResponseWriter, r *http.Request) {
	cs := strings.TrimSpace(r.URL.Query().Get("cs"))
	if cs == "" {
		http.Error(w, "param 'cs' (callsign) requis", http.StatusBadRequest)
		return
	}
	// Bbox par défaut Europe + Méditerranée + Maghreb pour ne pas saturer.
	bbox := [4]float64{-15, 30, 35, 70}
	if bs := r.URL.Query().Get("bbox"); bs != "" {
		fmt.Sscanf(bs, "%f,%f,%f,%f", &bbox[0], &bbox[1], &bbox[2], &bbox[3])
	}
	states, err := a.aircraft.QueryStates(r.Context(), &bbox, "", cs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"query":         cs,
		"authenticated": a.aircraft.Authenticated(),
		"count":         len(states),
		"states":        states,
	})
}

// handleAircraftState : /api/aircraft/{icao24}
// État courant d'un avion par identifiant ADS-B (24 bits hex).
func (a *API) handleAircraftState(w http.ResponseWriter, r *http.Request) {
	icao := strings.TrimSpace(r.PathValue("icao24"))
	if icao == "" {
		http.Error(w, "icao24 requis", http.StatusBadRequest)
		return
	}
	states, err := a.aircraft.QueryStates(r.Context(), nil, icao, "")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if len(states) == 0 {
		http.Error(w, "aucun état pour "+icao, http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, states[0])
}

// handleAircraftRoute : /api/aircraft/{icao24}/route?dur=60&dest=ICAO&events=1&wind=1
// Construit un plan de vol synthétique à partir de la position et du cap
// courants de l'avion, et déclenche le pipeline events / wind comme pour
// un plan de vol manuel.
func (a *API) handleAircraftRoute(w http.ResponseWriter, r *http.Request) {
	icao := strings.TrimSpace(r.PathValue("icao24"))
	if icao == "" {
		http.Error(w, "icao24 requis", http.StatusBadRequest)
		return
	}
	states, err := a.aircraft.QueryStates(r.Context(), nil, icao, "")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if len(states) == 0 {
		http.Error(w, "aucun état pour "+icao, http.StatusNotFound)
		return
	}
	st := states[0]

	q := r.URL.Query()
	dur := 60
	if v := q.Get("dur"); v != "" {
		fmt.Sscanf(v, "%d", &dur)
	}
	dest := strings.ToUpper(strings.TrimSpace(q.Get("dest")))
	autoDest := ""
	if dest == "" && q.Get("auto_dest") != "0" {
		// Tentative d'auto-détection via OpenSky /api/flights/aircraft sur
		// les 24 dernières heures. Nécessite l'auth ; en anonymous le call
		// est généralement refusé — on tombe alors silencieusement sur la
		// projection au cap.
		end := time.Now().UTC()
		begin := end.Add(-24 * time.Hour)
		segs, err := a.aircraft.FlightsByAircraft(r.Context(), icao, begin, end)
		if err == nil && len(segs) > 0 {
			// On prend le segment le plus récent qui a un estArrivalAirport
			for i := len(segs) - 1; i >= 0; i-- {
				if segs[i].EstArrivalAirport != "" {
					autoDest = segs[i].EstArrivalAirport
					dest = autoDest
					break
				}
			}
		}
	}

	depTime := time.Unix(st.TimePosition, 0).UTC()
	if st.TimePosition == 0 {
		depTime = time.Now().UTC()
	}
	depLabel := st.Callsign
	if depLabel == "" {
		depLabel = strings.ToUpper(icao)
	}

	plan, err := a.catalog.AircraftProjectedPlan(
		r.Context(),
		depLabel, st.Lat, st.Lon, st.FL, st.GsKt, st.TrueTrack,
		depTime, dur, dest,
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if q.Get("events") == "1" || q.Get("events") == "true" {
		ev, err := a.catalog.RouteEvents(r.Context(), plan, 50)
		if err == nil {
			plan.Events = ev
		}
	}
	if q.Get("wind") == "1" || q.Get("wind") == "true" {
		wp, err := a.catalog.RouteWindProfile(r.Context(), plan)
		if err == nil {
			plan.WindProfile = wp
		}
	}
	writeJSON(w, http.StatusOK, plan)
}

// handleQvacis : /api/qvacis?dataset=DETERMINISTIC|PROBABILISTIC&fl=325&bbox=...
func (a *API) handleQvacis(w http.ResponseWriter, r *http.Request) {
	bboxStr := r.URL.Query().Get("bbox")
	if bboxStr == "" {
		bboxStr = "-30,22,30,33" // bbox utile par défaut (Atlantique/Sahara)
	}
	var bbox [4]float64
	if _, err := fmt.Sscanf(bboxStr, "%f,%f,%f,%f", &bbox[0], &bbox[1], &bbox[2], &bbox[3]); err != nil {
		http.Error(w, "bbox invalide", http.StatusBadRequest)
		return
	}
	dataset := strings.ToUpper(r.URL.Query().Get("dataset"))
	if dataset == "" {
		dataset = "DETERMINISTIC"
	}
	fl := 325 // FL325 par défaut (~10 km, croisière moyens-courriers)
	if v := r.URL.Query().Get("fl"); v != "" {
		fmt.Sscanf(v, "%d", &fl)
	}
	grid, err := a.catalog.QvacisGrid(r.Context(), dataset, fl, bbox)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, grid)
}

// handleRoute calcule un plan de vol grand cercle entre deux ICAO.
// Usage: /api/route?dep=LFPG&arr=LFBO&fl=350&gs=450&dep_time=2026-04-26T08:00:00Z
func (a *API) handleRoute(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	dep := q.Get("dep")
	arr := q.Get("arr")
	if dep == "" || arr == "" {
		http.Error(w, "params 'dep' et 'arr' (ICAO) requis", http.StatusBadRequest)
		return
	}
	fl := 350
	if v := q.Get("fl"); v != "" {
		fmt.Sscanf(v, "%d", &fl)
	}
	gs := 450.0
	if v := q.Get("gs"); v != "" {
		fmt.Sscanf(v, "%f", &gs)
	}
	depTime := time.Now().UTC()
	if v := q.Get("dep_time"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			depTime = t
		}
	}
	plan, err := a.catalog.PlanRoute(r.Context(), dep, arr, fl, gs, depTime, 80)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if q.Get("events") == "1" || q.Get("events") == "true" {
		events, err := a.catalog.RouteEvents(r.Context(), plan, 50)
		if err == nil {
			plan.Events = events
		}
	}
	if q.Get("wind") == "1" || q.Get("wind") == "true" {
		wp, err := a.catalog.RouteWindProfile(r.Context(), plan)
		if err == nil {
			plan.WindProfile = wp
		}
	}
	writeJSON(w, http.StatusOK, plan)
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
