package httpapi

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/bmarty/metgate/internal/aircraft"
	"github.com/bmarty/metgate/internal/airports"
	"github.com/bmarty/metgate/internal/catalog"
	"github.com/bmarty/metgate/internal/cloudtop"
	"github.com/bmarty/metgate/internal/fir"
	"github.com/bmarty/metgate/internal/geo"
	"github.com/bmarty/metgate/internal/lightning"
	"github.com/bmarty/metgate/internal/satellite"
	"github.com/bmarty/metgate/internal/web"
)

type API struct {
	catalog   *catalog.Service
	aircraft  *aircraft.Service
	lightning *lightning.Service
	satellite *satellite.Proxy
	cloudtop  *cloudtop.Service
	airports  *airports.Store
}

func NewAPI(c *catalog.Service, ac *aircraft.Service, lt *lightning.Service, sp *satellite.Proxy, ct *cloudtop.Service, ap *airports.Store) *API {
	return &API{catalog: c, aircraft: ac, lightning: lt, satellite: sp, cloudtop: ct, airports: ap}
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
	m.HandleFunc("GET /api/lightning", a.handleLightning)
	m.HandleFunc("GET /api/satellite/tile", a.satellite.HandleTile)
	m.HandleFunc("GET /api/cloudtop", a.handleCloudtop)
	m.HandleFunc("GET /api/airport/{icao}", a.handleAirport)
	m.HandleFunc("GET /api/airports/search", a.handleAirportsSearch)
	m.HandleFunc("GET /api/fir", a.handleFIR)
	m.HandleFunc("GET /api/geo/countries", a.handleGeoCountries)
	m.HandleFunc("GET /api/alerts", a.handleAlerts)
	m.HandleFunc("GET /api/openapi.yaml", a.handleOpenAPI)
	m.HandleFunc("GET /api/docs", a.handleDocs)
	m.Handle("GET /", web.Handler())
	return m
}

func (a *API) healthz(w http.ResponseWriter, _ *http.Request) {
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
// Usage: /api/wind?bbox=-15,35,30,65&level=85000.
func (a *API) handleWind(w http.ResponseWriter, r *http.Request) {
	bbox, ok := parseBBoxParam(w, r, "bbox", [4]float64{-15, 35, 30, 65})
	if !ok {
		return
	}
	// Limiter à 80°×60° max pour éviter des NetCDF trop volumineux.
	bbox = clampBBox(bbox, 80, 60)
	level, ok := parseFloatParam(w, r, "level", 85000)
	if !ok {
		return
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
// Usage: /api/tropo?bbox=-15,35,30,65.
func (a *API) handleTropo(w http.ResponseWriter, r *http.Request) {
	bbox, ok := parseBBoxParam(w, r, "bbox", [4]float64{-15, 35, 30, 65})
	if !ok {
		return
	}
	bbox = clampBBox(bbox, 80, 60)
	grid, err := a.catalog.TropoGrid(r.Context(), bbox)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, grid)
}

// handleAircraftSearch : /api/aircraft/search?cs=AFR1234&bbox=lonMin,latMin,lonMax,latMax
// Recherche par sous-chaîne de callsign + bbox optionnelle. Si `cs` est
// absent, retourne tous les avions de la bbox (utile pour les vues locales
// type Tour 3D : trafic dans un rayon autour de l'aérodrome).
func (a *API) handleAircraftSearch(w http.ResponseWriter, r *http.Request) {
	cs := strings.TrimSpace(r.URL.Query().Get("cs"))
	bboxParam := strings.TrimSpace(r.URL.Query().Get("bbox"))
	if cs == "" && bboxParam == "" {
		http.Error(w, "param 'cs' (callsign) ou 'bbox' requis", http.StatusBadRequest)
		return
	}
	// Bbox par défaut Europe + Méditerranée + Maghreb pour ne pas saturer.
	bbox, ok := parseBBoxParam(w, r, "bbox", [4]float64{-15, 30, 35, 70})
	if !ok {
		return
	}
	states, err := a.aircraft.Search(r.Context(), &bbox, cs)
	if err != nil {
		// On *ne* remonte plus 502 : OpenSky renvoie fréquemment des
		// 429 (compte gratuit rate-limité) et le frontend interprétait
		// chaque échec comme une vraie panne, ce qui faisait spammer
		// la console côté navigateur. On répond 200 avec une liste
		// vide + le motif, le client garde son back-off et la scène
		// reste affichable.
		writeJSON(w, http.StatusOK, map[string]any{
			"query":         cs,
			"authenticated": a.aircraft.Authenticated(),
			"count":         0,
			"states":        []any{},
			"error":         err.Error(),
		})
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
// Retourne toujours 200 pour éviter les erreurs console navigateur :
//   - état live  → {…State, stale:false}
//   - état stale → {…State, stale:true}  (dernier connu en mémoire)
//   - introuvable → {found:false, icao24:…}
func (a *API) handleAircraftState(w http.ResponseWriter, r *http.Request) {
	icao := strings.TrimSpace(r.PathValue("icao24"))
	if icao == "" {
		http.Error(w, "icao24 requis", http.StatusBadRequest)
		return
	}
	st, err := a.aircraft.State(r.Context(), icao)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	type stateResp struct {
		aircraft.State
		Found bool `json:"found"`
		Stale bool `json:"stale"`
	}
	if st != nil {
		writeJSON(w, http.StatusOK, stateResp{State: *st, Found: true, Stale: false})
		return
	}
	// Fallback : dernier état connu en mémoire (stale = plus mis à jour par OpenSky).
	if hist := a.aircraft.History(icao); len(hist) > 0 {
		writeJSON(w, http.StatusOK, stateResp{State: hist[len(hist)-1], Found: true, Stale: true})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"found": false, "icao24": icao})
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
	st, err := a.aircraft.State(r.Context(), icao)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if st == nil {
		// Avion non visible dans OpenSky (atterri ou hors couverture ADS-B).
		// Fallback : dernier état connu depuis le ring buffer en mémoire.
		if hist := a.aircraft.History(icao); len(hist) > 0 {
			last := hist[len(hist)-1]
			st = &last
		} else {
			http.Error(w, "aucun état pour "+icao, http.StatusNotFound)
			return
		}
	}

	q := r.URL.Query()
	dur, ok := parseIntParam(w, r, "dur", 60, 1, 720)
	if !ok {
		return
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

	// Préfixe les positions passées (ring buffer 30 min) AVANT de calculer
	// events et wind, pour que les near_waypoint_idx soient cohérents avec
	// le plan complet (passé + futur).
	currentIdx := 0
	if past := a.aircraft.History(icao); len(past) > 0 {
		plan, currentIdx = prefixPastWaypoints(plan, past)
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

	// Réponse enrichie avec l'index du waypoint "maintenant" (= 1er point
	// projeté après le passé). Le frontend pose le cursor dessus par défaut.
	if pf := plan.PartialFailures(); len(pf) > 0 {
		w.Header().Set("X-Partial-Errors", strings.Join(pf, ","))
	}
	writeJSON(w, http.StatusOK, struct {
		*catalog.RoutePlan
		CurrentIdx int `json:"current_idx"`
	}{plan, currentIdx})
}

// prefixPastWaypoints insère devant les waypoints projetés du plan ceux qui
// correspondent aux positions historiques accumulées pour cet avion. Retourne
// le plan modifié et l'index du waypoint correspondant à la position
// courante (= 1er waypoint projeté, après le passé).
func prefixPastWaypoints(plan *catalog.RoutePlan, past []aircraft.State) (*catalog.RoutePlan, int) {
	if len(past) == 0 {
		return plan, 0
	}
	depTime, _ := time.Parse(time.RFC3339, plan.DepTime)
	cutoff := depTime.Unix()

	// Trier le passé par TimePosition croissant (au cas où).
	sortedPast := make([]aircraft.State, 0, len(past))
	for _, p := range past {
		if p.TimePosition < cutoff {
			sortedPast = append(sortedPast, p)
		}
	}
	if len(sortedPast) == 0 {
		return plan, 0
	}

	// Distances cumulées depuis le 1er point passé.
	pastWps := make([]catalog.RouteWaypoint, len(sortedPast))
	var cum float64
	for i, p := range sortedPast {
		if i > 0 {
			cum += gcDistanceNM(
				sortedPast[i-1].Lat, sortedPast[i-1].Lon,
				p.Lat, p.Lon,
			)
		}
		pastWps[i] = catalog.RouteWaypoint{
			Lon:     p.Lon,
			Lat:     p.Lat,
			FL:      p.FL,
			TimeISO: time.Unix(p.TimePosition, 0).UTC().Format("2006-01-02T15:04:05Z"),
			DistNM:  cum, // valeur temporaire, ré-écrite ci-dessous
		}
	}
	// Distance totale parcourue dans le passé observé.
	totalPast := pastWps[len(pastWps)-1].DistNM
	// Décaler : passé = négatif (-totalPast → 0), futur = positif.
	for i := range pastWps {
		pastWps[i].DistNM -= totalPast
	}
	currentIdx := len(pastWps) // index du 1er waypoint futur dans plan.Waypoints
	plan.Waypoints = append(pastWps, plan.Waypoints...)
	return plan, currentIdx
}

// gcDistanceNM : haversine en NM.
func gcDistanceNM(lat1, lon1, lat2, lon2 float64) float64 {
	const r = 3440.065
	const deg = 0.0174532925199 // π/180
	p1 := lat1 * deg
	p2 := lat2 * deg
	dp := (lat2 - lat1) * deg
	dl := (lon2 - lon1) * deg
	s1 := math.Sin(dp / 2)
	s2 := math.Sin(dl / 2)
	a := s1*s1 + math.Cos(p1)*math.Cos(p2)*s2*s2
	return 2 * r * math.Asin(math.Sqrt(a))
}

// handleQvacis : /api/qvacis?dataset=DETERMINISTIC|PROBABILISTIC&fl=325&bbox=...
func (a *API) handleQvacis(w http.ResponseWriter, r *http.Request) {
	bbox, ok := parseBBoxParam(w, r, "bbox", [4]float64{-30, 22, 30, 33})
	if !ok {
		return
	}
	dataset := strings.ToUpper(r.URL.Query().Get("dataset"))
	if dataset == "" {
		dataset = "DETERMINISTIC"
	}
	fl, ok := parseIntParam(w, r, "fl", 325, 0, 700)
	if !ok {
		return
	}
	grid, err := a.catalog.QvacisGrid(r.Context(), dataset, fl, bbox)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, grid)
}

// handleRoute calcule un plan de vol grand cercle entre deux ICAO.
// Usage: /api/route?dep=LFPG&arr=LFBO&fl=350&gs=450&dep_time=2026-04-26T08:00:00Z.
func (a *API) handleRoute(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	dep := q.Get("dep")
	arr := q.Get("arr")
	if dep == "" || arr == "" {
		http.Error(w, "params 'dep' et 'arr' (ICAO) requis", http.StatusBadRequest)
		return
	}
	fl, ok := parseIntParam(w, r, "fl", 350, 0, 600)
	if !ok {
		return
	}
	gs, ok := parseFloatParam(w, r, "gs", 450)
	if !ok {
		return
	}
	depTime := time.Now().UTC()
	if v := q.Get("dep_time"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			http.Error(w, "dep_time: format ISO RFC3339 attendu", http.StatusBadRequest)
			return
		}
		depTime = t
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
	if q.Get("tropo") == "1" || q.Get("tropo") == "true" {
		// Best-effort : si MetGate refuse / timeout, on garde le plan sans tropo.
		_ = a.catalog.EnrichRouteWithTropo(r.Context(), plan)
	}
	if pf := plan.PartialFailures(); len(pf) > 0 {
		w.Header().Set("X-Partial-Errors", strings.Join(pf, ","))
	}
	writeJSON(w, http.StatusOK, plan)
}

// handleFeature relaie un WFS GetFeature de MetGate (GML) en GeoJSON.
// Usage: /api/feature?type=METAR_last&count=200.
func (a *API) handleFeature(w http.ResponseWriter, r *http.Request) {
	typeName := r.URL.Query().Get("type")
	if typeName == "" {
		http.Error(w, "param 'type' requis (ex: METAR_last)", http.StatusBadRequest)
		return
	}
	count, ok := parseIntParam(w, r, "count", 0, 0, 100000)
	if !ok {
		return
	}
	filter := r.URL.Query().Get("filter") // OGC FES 2.0 XML, optionnel
	// Contexte découplé du proxy/navigateur : les réponses WFS volumineuses
	// (RDT_MSG_last count=2000 → ~1.6 MB) peuvent prendre plusieurs secondes.
	// On utilise un contexte background pour que la réponse soit mise en cache
	// même si le client s'est déconnecté entre-temps.
	wfsCtx, wfsCancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer wfsCancel()
	geo, fromCache, err := a.catalog.FeatureGeoJSON(wfsCtx, typeName, count, filter)
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
	if len(agg.PartialFailures) > 0 {
		w.Header().Set("X-Partial-Errors", strings.Join(agg.PartialFailures, ","))
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

// handleAirportsSearch : /api/airports/search?q=...&limit=N
// Recherche dans OurAirports par ICAO, IATA, nom ou ville. Tri par
// pertinence (exact match d'abord), filtre heliports/closed.
func (a *API) handleAirportsSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		http.Error(w, "param 'q' requis", http.StatusBadRequest)
		return
	}
	limit, ok := parseIntParam(w, r, "limit", 12, 1, 50)
	if !ok {
		return
	}
	results := a.airports.Search(q, limit)
	writeJSON(w, http.StatusOK, map[string]any{
		"query":   q,
		"count":   len(results),
		"results": results,
	})
}

// handleAirport : /api/airport/{icao} → fiche aéroport + pistes (OurAirports).
func (a *API) handleAirport(w http.ResponseWriter, r *http.Request) {
	icao := strings.ToUpper(strings.TrimSpace(r.PathValue("icao")))
	if len(icao) != 4 {
		http.Error(w, "icao 4-letter requis", http.StatusBadRequest)
		return
	}
	ap := a.airports.Airport(icao)
	if ap == nil {
		http.Error(w, "aérodrome inconnu", http.StatusNotFound)
		return
	}
	rwys := a.airports.Runways(icao)
	writeJSON(w, http.StatusOK, map[string]any{
		"airport":  ap,
		"runways":  rwys,
		"has_geometry": len(rwys) > 0,
	})
}

// handleCloudtop : /api/cloudtop?bbox=lonMin,latMin,lonMax,latMax&minfl=NN&w=PX&h=PX
// Renvoie un PNG colorisé : sommets nuageux (CTH) au-dessus de minFL.
// Source : EUMETSAT MTG-FCI CTTH (situationnel, non OPMET).
func (a *API) handleCloudtop(w http.ResponseWriter, r *http.Request) {
	if !a.cloudtop.Authenticated() {
		http.Error(w, "cloudtop indisponible (EUMETSAT_CONSUMER_KEY/SECRET non configurés)", http.StatusServiceUnavailable)
		return
	}
	bbox, ok := parseBBoxParam(w, r, "bbox", [4]float64{-30, 30, 50, 65})
	if !ok {
		return
	}
	minFL, ok := parseIntParam(w, r, "minfl", 0, 0, 600)
	if !ok {
		return
	}
	width, ok := parseIntParam(w, r, "w", 1024, 64, 4096)
	if !ok {
		return
	}
	height, ok := parseIntParam(w, r, "h", 768, 64, 4096)
	if !ok {
		return
	}

	// Cache du snapshot 5 min (cadence MTG-CTTH = 10 min, donc on rafraîchit
	// largement au-delà avec une marge).
	snap, err := a.cloudtop.Latest(r.Context(), 5*time.Minute)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Source", "EUMETSAT MTG-FCI CTTH (situationnel non OPMET)")
	w.Header().Set("X-Fetched-At", snap.FetchedAt.UTC().Format(time.RFC3339))
	_, _ = w.Write(snap.PNG(bbox, width, height, minFL))
}

// handleLightning : /api/lightning?bbox=lonMin,latMin,lonMax,latMax&since=ISO
// Retourne les flashes du dernier produit MTG-LI (10 min) en GeoJSON Points.
// Source EUMETSAT — situationnel, non-OPMET (cf. bandeau UI).
func (a *API) handleLightning(w http.ResponseWriter, r *http.Request) {
	if !a.lightning.Authenticated() {
		http.Error(w, "lightning indisponible (EUMETSAT_CONSUMER_KEY/SECRET non configurés)", http.StatusServiceUnavailable)
		return
	}
	q := r.URL.Query()
	var bbox *[4]float64
	if q.Get("bbox") != "" {
		bb, ok := parseBBoxParam(w, r, "bbox", [4]float64{})
		if !ok {
			return
		}
		bbox = &bb
	}
	var since time.Time
	if s := q.Get("since"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			http.Error(w, "since: format ISO RFC3339 attendu", http.StatusBadRequest)
			return
		}
		since = t
	}

	// Découpler du contexte request (proxy nginx peut couper à 30 s).
	// Le premier téléchargement EUMETSAT peut prendre > 30 s ; le résultat
	// est mis en cache 60 s, les appels suivants sont instantanés.
	ltCtx, ltCancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer ltCancel()
	flashes, fetchedAt, err := a.lightning.Latest(ltCtx, 60*time.Second)
	if err != nil {
		// 503 : service EUMETSAT indisponible (token expiré, produit absent…)
		// 502 serait trompeur (ce n'est pas un problème de proxy réseau).
		http.Error(w, "lightning indisponible : "+err.Error(), http.StatusServiceUnavailable)
		return
	}

	type feat struct {
		Type     string         `json:"type"`
		Geometry map[string]any `json:"geometry"`
		Props    map[string]any `json:"properties"`
	}
	features := make([]feat, 0, len(flashes))
	for _, f := range flashes {
		if bbox != nil {
			if f.Lon < bbox[0] || f.Lon > bbox[2] || f.Lat < bbox[1] || f.Lat > bbox[3] {
				continue
			}
		}
		if !since.IsZero() && f.Time.Before(since) {
			continue
		}
		props := map[string]any{
			"time": f.Time.UTC().Format(time.RFC3339),
		}
		if !math.IsNaN(f.Radiance) && !math.IsInf(f.Radiance, 0) {
			props["radiance"] = f.Radiance
		}
		if !math.IsNaN(f.Duration) && !math.IsInf(f.Duration, 0) {
			props["duration"] = f.Duration
		}
		if !math.IsNaN(f.Confidence) && !math.IsInf(f.Confidence, 0) {
			props["confidence"] = f.Confidence
		}
		features = append(features, feat{
			Type: "Feature",
			Geometry: map[string]any{
				"type":        "Point",
				"coordinates": []float64{f.Lon, f.Lat},
			},
			Props: props,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"type":        "FeatureCollection",
		"features":    features,
		"fetched_at":  fetchedAt.UTC().Format(time.RFC3339),
		"source":      "EUMETSAT MTG-LI Lightning Flashes (LFL)",
		"disclaimer":  "Donnée satellite à titre situationnel — non OPMET (OACI Annexe 3 / 2017/373)",
	})
}

// handleAlerts : /api/alerts?bbox=lonMin,latMin,lonMax,latMax
// Retourne la liste des aérodromes (medium + large) de la bbox ayant des alertes
// météo actives, croisées depuis SPECI (SP_last), MAA (WL_last) et RDT (RDT_MSG_last).
func (a *API) handleAlerts(w http.ResponseWriter, r *http.Request) {
	bbox, ok := parseBBoxParam(w, r, "bbox", [4]float64{-15, 35, 30, 65})
	if !ok {
		return
	}
	// Refuser les bbox trop grandes (>40°×30°) : trop d'aérodromes + MetGate lent.
	if (bbox[2]-bbox[0]) > 40 || (bbox[3]-bbox[1]) > 30 {
		writeJSON(w, http.StatusOK, map[string]any{
			"alerts":           []any{},
			"count":            0,
			"airports_checked": 0,
			"fetched_at":       time.Now().UTC().Format(time.RFC3339),
			"note":             "Zoom pour voir les alertes aérodromes",
		})
		return
	}
	// On inclut les petits aérodromes si la bbox est petite (< 5° de côté).
	mediumLargeOnly := (bbox[2]-bbox[0]) > 5 || (bbox[3]-bbox[1]) > 5
	aps := a.airports.InBbox(bbox, mediumLargeOnly)
	// Cap à 400 aérodromes max pour éviter les traitements trop longs.
	if len(aps) > 400 {
		aps = aps[:400]
	}

	simple := make([]catalog.SimpleAirport, len(aps))
	for i, ap := range aps {
		simple[i] = catalog.SimpleAirport{ICAO: ap.ICAO, Lat: ap.Lat, Lon: ap.Lon}
	}

	alertCtx, alertCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer alertCancel()

	alerts, err := a.catalog.AlertsForAirports(alertCtx, simple)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"alerts":          alerts,
		"count":           len(alerts),
		"airports_checked": len(simple),
		"fetched_at":      time.Now().UTC().Format(time.RFC3339),
	})
}

// handleFIR sert les limites des FIR/UIR mondiales (GeoJSON statique embarqué).
// Source : jaluebbe/FlightMapEuropeSimple + NFDC North America, licence ouverte.
func (a *API) handleFIR(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/geo+json")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Write(fir.WorldGeoJSON) //nolint:errcheck
}

// handleGeoCountries sert les polygones pays (Natural Earth 110m, GeoJSON embarqué).
func (a *API) handleGeoCountries(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/geo+json")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Write(geo.CountriesGeoJSON) //nolint:errcheck
}

