package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"
)

// Aerodrome est un point d'aérodrome identifié par son code OACI.
type Aerodrome struct {
	ICAO string  `json:"icao"`
	Lon  float64 `json:"lon"`
	Lat  float64 `json:"lat"`
}

// RouteWaypoint est un point de la trajectoire grand cercle.
type RouteWaypoint struct {
	Lon     float64 `json:"lon"`
	Lat     float64 `json:"lat"`
	FL      int     `json:"fl"`
	TimeISO string  `json:"time"`
	DistNM  float64 `json:"dist_nm"`
}

// RoutePlan est le résultat d'un plan de vol simple : trajectoire grand
// cercle DEP→ARR avec profil vertical trapézoïdal, GS constant.
type RoutePlan struct {
	Dep       Aerodrome       `json:"dep"`
	Arr       Aerodrome       `json:"arr"`
	FL        int             `json:"fl"`
	GSkt      float64         `json:"gs_kt"`
	DepTime   string          `json:"dep_time"`
	ArrTime   string          `json:"arr_time"`
	DistNM    float64         `json:"distance_nm"`
	DurMin    float64         `json:"duration_min"`
	Waypoints   []RouteWaypoint `json:"waypoints"`
	Events      []RouteEvent    `json:"events,omitempty"`
	WindProfile *WindProfile    `json:"wind_profile,omitempty"`
}

// RouteEvent est un événement météo rencontré le long de la route.
type RouteEvent struct {
	Kind            string         `json:"kind"`              // SIGMET / AIRMET / METAR / TAF / SPECI / CAT / GIVRAGE / RDT
	Family          string         `json:"family"`            // FeatureType WFS d'origine
	Label           string         `json:"label"`             // ex: "EHAM" ou "FIR LFFF — OBSC TS"
	NearIdx         int            `json:"near_waypoint_idx"` // index du waypoint le plus pertinent
	DistanceNM      float64        `json:"distance_nm"`       // pour Points : distance min à la route
	Lon             float64        `json:"lon"`               // position du Point ou centroïde du Polygon
	Lat             float64        `json:"lat"`
	FIR             string         `json:"fir,omitempty"` // issuingAirTrafficServicesRegion si dispo
	WaypointTime    string         `json:"waypoint_time"` // time du waypoint le plus proche
	ValidityStart   string         `json:"validity_start,omitempty"`
	ValidityEnd     string         `json:"validity_end,omitempty"`
	WaypointInRange bool           `json:"waypoint_in_range"` // true si waypoint.time ∈ [start, end]
	Properties      map[string]any `json:"properties,omitempty"`
}

const earthRadiusNM = 3440.065

// ICAOIndex construit ICAO → (lon, lat) depuis les METAR_last + TAF_last +
// SPECI_last en cache. Sources concaténées : si un même ICAO apparaît dans
// plusieurs feed, on garde la 1ère position rencontrée (METAR > TAF > SPECI).
func (s *Service) ICAOIndex(ctx context.Context) (map[string][2]float64, error) {
	idx := make(map[string][2]float64)
	for _, t := range []string{"METAR_last", "TAF_last", "SPECI_last"} {
		geo, _, err := s.FeatureGeoJSON(ctx, t, 2000)
		if err != nil {
			continue
		}
		var fc struct {
			Features []struct {
				Properties map[string]any `json:"properties"`
				Geometry   struct {
					Type        string    `json:"type"`
					Coordinates []float64 `json:"coordinates"`
				} `json:"geometry"`
			} `json:"features"`
		}
		if err := json.Unmarshal(geo, &fc); err != nil {
			continue
		}
		for _, f := range fc.Features {
			if f.Geometry.Type != "Point" || len(f.Geometry.Coordinates) < 2 {
				continue
			}
			icao, _ := f.Properties["locationIndicatorICAO"].(string)
			if icao == "" {
				continue
			}
			icao = strings.ToUpper(strings.TrimSpace(icao))
			if _, exists := idx[icao]; exists {
				continue
			}
			idx[icao] = [2]float64{f.Geometry.Coordinates[0], f.Geometry.Coordinates[1]}
		}
	}
	return idx, nil
}

// PointFamilies sont les couches WFS Point qu'on scanne pour les events
// (METAR, TAF, etc.).
var routePointFamilies = []string{"METAR_last", "TAF_last", "SPECI_last"}

// PolyFamilies sont les couches WFS Polygon qu'on scanne pour les events.
var routePolyFamilies = []string{
	"AIRMET_last",
	"SIGMET_last",
	"VolcanicAshSIGMET_last",
	"TropicalCycloneSIGMET_last",
	"CAT_EURAT01_last",
	"GIVRAGE_EURAT01_last",
	"RDT_MSG_last",
}

// PlanRoute calcule un plan de vol grand cercle entre deux ICAO.
// gsKt par défaut 450 si <= 0, fl par défaut 350, nWaypoints 80.
func (s *Service) PlanRoute(
	ctx context.Context,
	depICAO, arrICAO string,
	fl int,
	gsKt float64,
	depTime time.Time,
	nWaypoints int,
) (*RoutePlan, error) {
	idx, err := s.ICAOIndex(ctx)
	if err != nil {
		return nil, err
	}
	dep := strings.ToUpper(strings.TrimSpace(depICAO))
	arr := strings.ToUpper(strings.TrimSpace(arrICAO))
	depPos, ok1 := idx[dep]
	arrPos, ok2 := idx[arr]
	if !ok1 {
		return nil, fmt.Errorf("ICAO %s introuvable dans le cache METAR/TAF/SPECI", dep)
	}
	if !ok2 {
		return nil, fmt.Errorf("ICAO %s introuvable dans le cache METAR/TAF/SPECI", arr)
	}
	if gsKt <= 0 {
		gsKt = 450
	}
	if fl <= 0 {
		fl = 350
	}
	if nWaypoints < 2 {
		nWaypoints = 80
	}
	if depTime.IsZero() {
		depTime = time.Now().UTC()
	}

	dist := gcDistance(depPos[1], depPos[0], arrPos[1], arrPos[0])
	durMin := dist / gsKt * 60

	// Profil vertical simple : montée linéaire pendant climbMin minutes,
	// descente linéaire pendant descentMin minutes, palier de croisière au
	// milieu. Si le vol est trop court pour atteindre cruise, on fait un
	// triangle dont le sommet vaut cruise * climb/(climb+descent).
	const climbMin = 20.0   // ~1850 ft/min vers FL370
	const descentMin = 25.0 // ~1480 ft/min depuis FL370

	wps := make([]RouteWaypoint, nWaypoints)
	for i := 0; i < nWaypoints; i++ {
		f := float64(i) / float64(nWaypoints-1)
		la, lo := gcInterpolate(depPos[1], depPos[0], arrPos[1], arrPos[0], f)
		t := f * durMin
		flAt := profileFL(t, durMin, float64(fl), climbMin, descentMin)
		ts := depTime.Add(time.Duration(t * float64(time.Minute))).UTC()
		wps[i] = RouteWaypoint{
			Lon:     lo,
			Lat:     la,
			FL:      flAt,
			TimeISO: ts.Format("2006-01-02T15:04:05Z"),
			DistNM:  f * dist,
		}
	}

	return &RoutePlan{
		Dep:       Aerodrome{ICAO: dep, Lon: depPos[0], Lat: depPos[1]},
		Arr:       Aerodrome{ICAO: arr, Lon: arrPos[0], Lat: arrPos[1]},
		FL:        fl,
		GSkt:      gsKt,
		DepTime:   wps[0].TimeISO,
		ArrTime:   wps[nWaypoints-1].TimeISO,
		DistNM:    dist,
		DurMin:    durMin,
		Waypoints: wps,
	}, nil
}

// profileFL calcule le niveau de vol à l'instant t (minutes depuis le
// décollage) selon un profil trapézoïdal : montée → palier → descente.
// Si le vol est trop court pour atteindre cruise, profil triangulaire.
func profileFL(t, totalMin, cruise, climbMin, descentMin float64) int {
	if t <= 0 {
		return 0
	}
	if t >= totalMin {
		return 0
	}
	if totalMin >= climbMin+descentMin {
		// Trapèze : montée 0..climb, palier climb..(total-descent), descente
		switch {
		case t < climbMin:
			return int(cruise * t / climbMin)
		case t > totalMin-descentMin:
			return int(cruise * (totalMin - t) / descentMin)
		default:
			return int(cruise)
		}
	}
	// Triangle : on n'atteint pas cruise. Sommet à climb/(climb+descent)
	// du temps total, hauteur = cruise * climb/(climb+descent).
	peakFrac := climbMin / (climbMin + descentMin)
	peakT := totalMin * peakFrac
	peakFL := cruise * peakFrac
	if t < peakT {
		return int(peakFL * t / peakT)
	}
	return int(peakFL * (totalMin - t) / (totalMin - peakT))
}

// RouteEvents calcule les événements météo le long d'une route déjà planifiée.
// - Pour chaque famille Point (METAR/TAF/SPECI), calcule la distance min entre
//   le point et la route. Garde les features ≤ maxDistNM.
// - Pour chaque famille Polygon (SIGMET/AIRMET/CAT/GIVRAGE/RDT), test si au
//   moins un waypoint est dans le polygone. Note si le waypoint correspondant
//   tombe dans la fenêtre de validité.
// Trie les événements par moment de passage (waypoint time).
func (s *Service) RouteEvents(
	ctx context.Context,
	plan *RoutePlan,
	maxDistNM float64,
) ([]RouteEvent, error) {
	if plan == nil || len(plan.Waypoints) == 0 {
		return nil, nil
	}
	if maxDistNM <= 0 {
		maxDistNM = 50
	}

	var (
		mu     sync.Mutex
		events []RouteEvent
		errs   []error
		wg     sync.WaitGroup
	)

	process := func(family string, geomKind string) {
		defer wg.Done()
		// Pour les polygones (CAT, GIVRAGE) MetGate publie ~115 zones × 12
		// fenêtres temporelles = >1000 features. Sans count élevé on ne voit
		// que la 1ère fenêtre et on rate les events pour des vols futurs.
		count := 2500
		if geomKind == "Polygon" {
			count = 12000
		}
		geo, _, err := s.FeatureGeoJSON(ctx, family, count)
		if err != nil {
			mu.Lock()
			errs = append(errs, fmt.Errorf("%s: %w", family, err))
			mu.Unlock()
			return
		}
		var fc geoJSONFeatureCollection
		if err := json.Unmarshal(geo, &fc); err != nil {
			return
		}
		for _, f := range fc.Features {
			ev, ok := matchFeature(plan, f, family, geomKind, maxDistNM)
			if !ok {
				continue
			}
			// Filtrage temporel : si la feature a une fenêtre de validité
			// connue (METAR : obs+90 min, TAF : begin/end, polygones :
			// validitystart/end), on n'affiche que si le moment de passage
			// du waypoint est dans cette fenêtre. Un METAR de 8h est inutile
			// pour un avion qui passe à 14h.
			if ev.ValidityStart != "" && !ev.WaypointInRange {
				continue
			}
			mu.Lock()
			events = append(events, ev)
			mu.Unlock()
		}
	}

	for _, fam := range routePointFamilies {
		wg.Add(1)
		go process(fam, "Point")
	}
	for _, fam := range routePolyFamilies {
		wg.Add(1)
		go process(fam, "Polygon")
	}
	wg.Wait()

	sort.Slice(events, func(i, j int) bool {
		return events[i].WaypointTime < events[j].WaypointTime
	})
	return events, nil
}

// geoJSONFeatureCollection : décodage minimal pour parcourir features.
type geoJSONFeatureCollection struct {
	Features []geoJSONFeature `json:"features"`
}

type geoJSONFeature struct {
	Geometry   geoJSONGeometry        `json:"geometry"`
	Properties map[string]interface{} `json:"properties"`
}

type geoJSONGeometry struct {
	Type        string          `json:"type"`
	Coordinates json.RawMessage `json:"coordinates"`
}

// matchFeature : pour un Point, calcule la distance min à la route ; pour un
// Polygon/MultiPolygon, cherche le 1er waypoint dans le polygone.
// Retourne (event, true) si la feature concerne la route.
func matchFeature(
	plan *RoutePlan,
	f geoJSONFeature,
	family, geomKind string,
	maxDistNM float64,
) (RouteEvent, bool) {
	var ev RouteEvent
	ev.Family = family
	ev.Kind = familyKind(family)
	ev.Properties = compactProps(f.Properties)
	if fir, ok := f.Properties["issuingAirTrafficServicesRegion"].(string); ok {
		ev.FIR = strings.TrimSpace(fir)
	}
	ev.ValidityStart, ev.ValidityEnd = effectiveValidityWindow(f.Properties, family)

	switch f.Geometry.Type {
	case "Point":
		var c [2]float64
		if err := json.Unmarshal(f.Geometry.Coordinates, &c); err != nil {
			return ev, false
		}
		idx, dist := nearestWaypoint(plan, c[1], c[0])
		if dist > maxDistNM {
			return ev, false
		}
		ev.NearIdx = idx
		ev.DistanceNM = dist
		ev.Lon = c[0]
		ev.Lat = c[1]
		ev.WaypointTime = plan.Waypoints[idx].TimeISO
		ev.WaypointInRange = isInValidity(ev.WaypointTime, ev.ValidityStart, ev.ValidityEnd)
		ev.Label = pointLabel(f.Properties, family)
		return ev, true
	case "Polygon":
		var rings [][][]float64
		if err := json.Unmarshal(f.Geometry.Coordinates, &rings); err != nil {
			return ev, false
		}
		idx, ok := firstWaypointIn(plan, rings)
		if !ok {
			return ev, false
		}
		ev.NearIdx = idx
		ev.Lon, ev.Lat = ringCentroid(rings[0])
		ev.WaypointTime = plan.Waypoints[idx].TimeISO
		ev.WaypointInRange = isInValidity(ev.WaypointTime, ev.ValidityStart, ev.ValidityEnd)
		ev.Label = polyLabel(ev, family)
		return ev, true
	case "MultiPolygon":
		var polys [][][][]float64
		if err := json.Unmarshal(f.Geometry.Coordinates, &polys); err != nil {
			return ev, false
		}
		bestIdx := -1
		var bestRing [][]float64
		for _, rings := range polys {
			idx, ok := firstWaypointIn(plan, rings)
			if !ok {
				continue
			}
			if bestIdx < 0 || idx < bestIdx {
				bestIdx = idx
				if len(rings) > 0 {
					bestRing = rings[0]
				}
			}
		}
		if bestIdx < 0 {
			return ev, false
		}
		ev.NearIdx = bestIdx
		if len(bestRing) > 0 {
			ev.Lon, ev.Lat = ringCentroid(bestRing)
		}
		ev.WaypointTime = plan.Waypoints[bestIdx].TimeISO
		ev.WaypointInRange = isInValidity(ev.WaypointTime, ev.ValidityStart, ev.ValidityEnd)
		ev.Label = polyLabel(ev, family)
		return ev, true
	}
	return ev, false
}

// effectiveValidityWindow retourne la fenêtre temporelle pendant laquelle un
// produit a une valeur opérationnelle. On mappe chaque famille à une convention
// OACI/WMO :
//   - METAR / SPECI / LocalReport : observation à H, valable ~90 min
//     (au-delà, l'obs est obsolète).
//   - TAF : begin_position → end_position si publiés, sinon
//     issueTime → +24h (convention TAF FC court terme).
//   - SIGMET / AIRMET / VolcanicAshSIGMET / TropicalCycloneSIGMET :
//     validitystarttime → validityendtime ; sinon issueTime → +6h.
//   - CAT / GIVRAGE / RDT_MSG : validitystarttime → validityendtime.
//   - VolcanicAshAdvisory / TropicalCycloneAdvisory / SpaceWeatherAdvisory :
//     validity OACI ~6h après issueTime si pas de bornes explicites.
//
// Si aucune fenêtre n'est identifiable, retourne ("", "") et le filtrage
// laisse passer (on n'a pas d'info pour juger).
func effectiveValidityWindow(
	props map[string]interface{},
	family string,
) (start, end string) {
	// 1. Priorité aux bornes explicites validitystarttime/end (le plus fiable)
	if s, ok := props["validitystarttime"].(string); ok && s != "" {
		if e, ok2 := props["validityendtime"].(string); ok2 && e != "" {
			return s, e
		}
	}
	// 2. Sinon begin_position / end_position (TAF parfois)
	if b, ok := props["begin_position"].(string); ok && b != "" {
		if e, ok2 := props["end_position"].(string); ok2 && e != "" {
			return b, e
		}
	}
	// 3. Conventions OACI selon la famille
	switch family {
	case "METAR_last", "SPECI_last", "LocalReport_last":
		if obs, ok := props["observationTime"].(string); ok && obs != "" {
			return obs, addMinutesToISO(obs, 90)
		}
	case "TAF_last":
		if iss, ok := props["issueTime"].(string); ok && iss != "" {
			return iss, addMinutesToISO(iss, 24*60)
		}
	case "SIGMET_last", "VolcanicAshSIGMET_last", "TropicalCycloneSIGMET_last", "AIRMET_last":
		if iss, ok := props["issueTime"].(string); ok && iss != "" {
			return iss, addMinutesToISO(iss, 6*60)
		}
	case "VolcanicAshAdvisory_last", "TropicalCycloneAdvisory_last", "SpaceWeatherAdvisory_last":
		if iss, ok := props["issueTime"].(string); ok && iss != "" {
			return iss, addMinutesToISO(iss, 6*60)
		}
		// observationTime parfois utilisé pour ces advisories
		if obs, ok := props["observationTime"].(string); ok && obs != "" {
			return obs, addMinutesToISO(obs, 6*60)
		}
	}
	return "", ""
}

// addMinutesToISO ajoute n minutes à un ISO string, retourne ISO. En cas de
// parse error, retourne la chaîne d'origine.
func addMinutesToISO(iso string, n int) string {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		// Tentative tolérante (sans nanosecondes / Z)
		t, err = time.Parse("2006-01-02T15:04:05Z", iso)
		if err != nil {
			return iso
		}
	}
	return t.Add(time.Duration(n) * time.Minute).UTC().Format("2006-01-02T15:04:05Z")
}

// ringCentroid : centroïde simple d'un ring polygonal (moyenne des sommets,
// rapide et suffisamment fidèle pour positionner un pictogramme).
func ringCentroid(ring [][]float64) (lon, lat float64) {
	if len(ring) == 0 {
		return 0, 0
	}
	// On ignore le dernier point s'il duplique le premier (anneau fermé).
	n := len(ring)
	if n > 1 && ring[0][0] == ring[n-1][0] && ring[0][1] == ring[n-1][1] {
		n--
	}
	var sx, sy float64
	for i := 0; i < n; i++ {
		sx += ring[i][0]
		sy += ring[i][1]
	}
	return sx / float64(n), sy / float64(n)
}

func familyKind(family string) string {
	stripped := strings.TrimSuffix(family, "_last")
	return stripped
}

func pointLabel(props map[string]interface{}, family string) string {
	if icao, ok := props["locationIndicatorICAO"].(string); ok && icao != "" {
		return strings.TrimSuffix(family, "_last") + " " + icao
	}
	return strings.TrimSuffix(family, "_last")
}

func polyLabel(ev RouteEvent, family string) string {
	stripped := strings.TrimSuffix(family, "_last")
	if ev.FIR != "" {
		return stripped + " · FIR " + ev.FIR
	}
	return stripped
}

// compactProps copie une sélection des propriétés utiles (skip les UUID, etc.).
func compactProps(p map[string]interface{}) map[string]interface{} {
	if p == nil {
		return nil
	}
	out := map[string]interface{}{}
	for _, k := range []string{
		"locationIndicatorICAO", "tac", "status", "cavok",
		"airTemperature_C", "dewpointTemperature_C", "qnh_hPa",
		"windDirection_deg", "windSpeed_kt",
		"issuingAirTrafficServicesRegion", "validitystarttime", "validityendtime",
		"intensity", "cattype", "altitude", "top", "bottom",
		"producttype", "severity", "trackingid",
		"begin_position", "end_position",
		"observationTime", "issueTime",
	} {
		if v, ok := p[k]; ok && v != nil && v != "" {
			out[k] = v
		}
	}
	return out
}

func nearestWaypoint(plan *RoutePlan, lat, lon float64) (int, float64) {
	bestIdx := 0
	bestDist := math.Inf(1)
	for i, w := range plan.Waypoints {
		d := gcDistance(w.Lat, w.Lon, lat, lon)
		if d < bestDist {
			bestDist = d
			bestIdx = i
		}
	}
	return bestIdx, bestDist
}

// firstWaypointIn retourne l'index du premier waypoint dans le polygone.
// rings[0] est l'extérieur, rings[1..] sont les trous (ignorés ici).
func firstWaypointIn(plan *RoutePlan, rings [][][]float64) (int, bool) {
	if len(rings) == 0 {
		return 0, false
	}
	for i, w := range plan.Waypoints {
		if pointInRing(w.Lon, w.Lat, rings[0]) {
			return i, true
		}
	}
	return 0, false
}

// pointInRing : ray casting standard (lon en X, lat en Y).
// ring est une liste de [lon, lat].
func pointInRing(lon, lat float64, ring [][]float64) bool {
	in := false
	n := len(ring)
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		xi, yi := ring[i][0], ring[i][1]
		xj, yj := ring[j][0], ring[j][1]
		if ((yi > lat) != (yj > lat)) &&
			lon < (xj-xi)*(lat-yi)/(yj-yi)+xi {
			in = !in
		}
	}
	return in
}

func isInValidity(waypointTime, start, end string) bool {
	if start == "" {
		return true
	}
	if waypointTime < start {
		return false
	}
	if end != "" && waypointTime >= end {
		return false
	}
	return true
}

// AircraftProjectedPlan construit un plan de vol synthétique pour un avion
// suivi : départ = position courante, arrivée = projection grand cercle au
// cap actuel sur durMin minutes (par défaut 60), ou destination ICAO si
// fournie. Le FL et le GS sont ceux de l'avion réel (pas de profil
// trapézoïdal — l'avion est en vol, on garde son altitude actuelle).
func (s *Service) AircraftProjectedPlan(
	ctx context.Context,
	depICAO string, // pseudo-label, ex "AFR1234"
	depLat, depLon float64,
	currentFL int,
	gsKt float64,
	trackDeg float64,
	depTime time.Time,
	durMin int,
	destICAO string,
) (*RoutePlan, error) {
	if depTime.IsZero() {
		depTime = time.Now().UTC()
	}
	if gsKt <= 0 {
		gsKt = 450
	}
	if currentFL <= 0 {
		currentFL = 100
	}
	if durMin <= 0 {
		durMin = 60
	}

	var arrLat, arrLon, dist float64
	arrLabel := "PROJ"
	if destICAO != "" {
		idx, err := s.ICAOIndex(ctx)
		if err != nil {
			return nil, err
		}
		ap, ok := idx[strings.ToUpper(strings.TrimSpace(destICAO))]
		if !ok {
			return nil, fmt.Errorf("dest %s introuvable", destICAO)
		}
		arrLon, arrLat = ap[0], ap[1]
		arrLabel = strings.ToUpper(destICAO)
		dist = gcDistance(depLat, depLon, arrLat, arrLon)
	} else {
		dist = gsKt * float64(durMin) / 60
		arrLat, arrLon = projectAtBearing(depLat, depLon, trackDeg, dist)
	}
	durEffMin := dist / gsKt * 60
	const nWaypoints = 60

	wps := make([]RouteWaypoint, nWaypoints)
	for i := 0; i < nWaypoints; i++ {
		f := float64(i) / float64(nWaypoints-1)
		la, lo := gcInterpolate(depLat, depLon, arrLat, arrLon, f)
		ts := depTime.Add(time.Duration(f * durEffMin * float64(time.Minute))).UTC()
		wps[i] = RouteWaypoint{
			Lon:     lo,
			Lat:     la,
			FL:      currentFL,
			TimeISO: ts.Format("2006-01-02T15:04:05Z"),
			DistNM:  f * dist,
		}
	}

	return &RoutePlan{
		Dep:       Aerodrome{ICAO: depICAO, Lon: depLon, Lat: depLat},
		Arr:       Aerodrome{ICAO: arrLabel, Lon: arrLon, Lat: arrLat},
		FL:        currentFL,
		GSkt:      gsKt,
		DepTime:   wps[0].TimeISO,
		ArrTime:   wps[nWaypoints-1].TimeISO,
		DistNM:    dist,
		DurMin:    durEffMin,
		Waypoints: wps,
	}, nil
}

// projectAtBearing projette un point à dist NM dans la direction bearing
// (degrés vrais) depuis (lat, lon). Formule sphérique standard.
func projectAtBearing(lat, lon, bearingDeg, distNM float64) (float64, float64) {
	br := bearingDeg * math.Pi / 180
	d := distNM / earthRadiusNM // angular distance
	la1 := lat * math.Pi / 180
	lo1 := lon * math.Pi / 180
	la2 := math.Asin(math.Sin(la1)*math.Cos(d) + math.Cos(la1)*math.Sin(d)*math.Cos(br))
	lo2 := lo1 + math.Atan2(
		math.Sin(br)*math.Sin(d)*math.Cos(la1),
		math.Cos(d)-math.Sin(la1)*math.Sin(la2),
	)
	return la2 * 180 / math.Pi, lo2 * 180 / math.Pi
}

// gcDistance retourne la distance grand cercle (NM) entre deux points en deg.
func gcDistance(lat1, lon1, lat2, lon2 float64) float64 {
	p1 := lat1 * math.Pi / 180
	p2 := lat2 * math.Pi / 180
	dp := (lat2 - lat1) * math.Pi / 180
	dl := (lon2 - lon1) * math.Pi / 180
	a := math.Sin(dp/2)*math.Sin(dp/2) +
		math.Cos(p1)*math.Cos(p2)*math.Sin(dl/2)*math.Sin(dl/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return earthRadiusNM * c
}

// gcInterpolate interpole sur le grand cercle entre deux points (slerp).
func gcInterpolate(lat1, lon1, lat2, lon2, f float64) (lat, lon float64) {
	d := gcDistance(lat1, lon1, lat2, lon2) / earthRadiusNM
	if d == 0 {
		return lat1, lon1
	}
	p1 := lat1 * math.Pi / 180
	p2 := lat2 * math.Pi / 180
	l1 := lon1 * math.Pi / 180
	l2 := lon2 * math.Pi / 180
	a := math.Sin((1-f)*d) / math.Sin(d)
	b := math.Sin(f*d) / math.Sin(d)
	x := a*math.Cos(p1)*math.Cos(l1) + b*math.Cos(p2)*math.Cos(l2)
	y := a*math.Cos(p1)*math.Sin(l1) + b*math.Cos(p2)*math.Sin(l2)
	z := a*math.Sin(p1) + b*math.Sin(p2)
	return math.Atan2(z, math.Sqrt(x*x+y*y)) * 180 / math.Pi,
		math.Atan2(y, x) * 180 / math.Pi
}
