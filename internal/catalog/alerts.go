package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// rdtProximityNM : distance maximale en NM entre l'aérodrome et le centroïde
// d'une cellule RDT pour déclencher une alerte de proximité.
const rdtProximityNM = 30

// AlertLevel encode la sévérité d'une alerte météo sur un aérodrome.
type AlertLevel int

const (
	AlertNone   AlertLevel = 0
	AlertBlue   AlertLevel = 1 // précipitations faibles, brume, brouillard
	AlertYellow AlertLevel = 2 // pluie forte, neige, grêle
	AlertOrange AlertLevel = 3 // FZRA, FZFG, convection proche T+30
	AlertRed    AlertLevel = 4 // TS (orage) observé ou imminent
)

// AlertSource décrit la source d'une alerte sur un aérodrome.
type AlertSource struct {
	Type       string `json:"type"`             // "SPECI", "MAA", "RDT"
	Phenomenon string `json:"phenomenon"`        // ex: "TS", "FG", "SN"
	Text       string `json:"text,omitempty"`    // résumé lisible
	ForecastMin int   `json:"forecast_min,omitempty"` // RDT forecast time (minutes)
}

// AirportAlert regroupe toutes les alertes actives sur un aérodrome.
type AirportAlert struct {
	ICAO    string        `json:"icao"`
	Lat     float64       `json:"lat"`
	Lon     float64       `json:"lon"`
	Level   AlertLevel    `json:"level"`
	Sources []AlertSource `json:"sources"`
}

// SimpleAirport est une représentation minimale d'un aérodrome, fournie par le handler.
type SimpleAirport struct {
	ICAO string
	Lat  float64
	Lon  float64
}

// rxTS détecte les codes orage dans un TAC METAR/SPECI/MAA.
// Couvre : TS, TSRA, TSSN, TSGR, TSGS, VCTS, +TS, -TS.
var rxTS = regexp.MustCompile(`(?:^|[\s+\-])(?:VC)?TS(?:RA|SN|GR|GS|PL|DZ|IC|UP)?(?:\s|=|$)`)

// AlertsForAirports calcule les alertes météo actives pour une liste d'aérodromes.
// Interroge en parallèle SPECI (SP_last), MAA (WL_last) et RDT (RDT_MSG_last).
// En cas d'échec partiel d'un fetch, les autres sources sont quand même utilisées.
func (s *Service) AlertsForAirports(ctx context.Context, aps []SimpleAirport) ([]AirportAlert, error) {
	type featResult struct {
		feats []map[string]any
		err   error
	}
	speciCh := make(chan featResult, 1)
	maaCh   := make(chan featResult, 1)
	rdtCh   := make(chan featResult, 1)

	go func() {
		f, err := s.fetchFeatures(ctx, "SP_last", 500, "")
		speciCh <- featResult{f, err}
	}()
	go func() {
		f, err := s.fetchFeatures(ctx, "WL_last", 500, "")
		maaCh <- featResult{f, err}
	}()
	go func() {
		f, err := s.fetchFeatures(ctx, "RDT_MSG_last", 2000, "")
		rdtCh <- featResult{f, err}
	}()

	speciRes := <-speciCh
	maaRes   := <-maaCh
	rdtRes   := <-rdtCh

	// Indexer SPECI et MAA par code ICAO.
	speciByICAO := map[string]map[string]any{}
	for _, f := range speciRes.feats {
		p := propsOf(f)
		if icao := icaoFromProps(p); icao != "" {
			speciByICAO[icao] = f
		}
	}
	maaByICAO := map[string]map[string]any{}
	for _, f := range maaRes.feats {
		p := propsOf(f)
		icao := icaoFromProps(p)
		if icao == "" {
			if tac, ok := p["tac"].(string); ok {
				icao = icaoFromFirstToken(tac)
			}
		}
		if icao != "" {
			maaByICAO[icao] = f
		}
	}

	// Construire la liste des alertes par aérodrome.
	alerts := make([]AirportAlert, 0)
	for _, ap := range aps {
		var sources []AlertSource
		level := AlertNone

		// 1. SPECI : observation significative récente.
		if feat, ok := speciByICAO[ap.ICAO]; ok {
			p := propsOf(feat)
			tac, _ := p["tac"].(string)
			if tac == "" {
				// Certains SP_last IWXXM n'ont pas de TAC reconstitué ; on tente
				// de lire le champ `weather` ou `decoded`.
				tac, _ = p["decoded"].(string)
			}
			if l, pheno, text := levelFromTAC(tac); l > AlertNone {
				sources = append(sources, AlertSource{Type: "SPECI", Phenomenon: pheno, Text: text})
				if l > level {
					level = l
				}
			}
		}

		// 2. MAA : avertissement aérodrome en cours.
		if feat, ok := maaByICAO[ap.ICAO]; ok {
			p := propsOf(feat)
			tac, _ := p["tac"].(string)
			if l, pheno, text := levelFromTAC(tac); l > AlertNone {
				sources = append(sources, AlertSource{Type: "MAA", Phenomenon: pheno, Text: text})
				if l > level {
					level = l
				}
			}
		}

		// 3. RDT : intersection spatiale avec cellules convectives.
		// On déclenche si l'aérodrome est DANS la cellule (menace directe) OU
		// si le centroïde de la cellule est à moins de rdtProximityNM NM (menace proche).
		bestRDT := AlertNone
		bestRDTSrc := AlertSource{}
		for _, feat := range rdtRes.feats {
			inside := pointInFeature(ap.Lat, ap.Lon, feat)
			distNM := centroidDistNM(ap.Lat, ap.Lon, feat)
			if !inside && distNM > rdtProximityNM {
				continue
			}
			p := propsOf(feat)
			ftMin := rdtForecastMin(p)
			l := rdtLevel(ftMin)
			// Si seulement proche (pas dedans), on abaisse d'un niveau.
			if !inside && l > AlertBlue {
				l--
			}
			if l > bestRDT {
				bestRDT = l
				proximity := ""
				if !inside {
					proximity = fmt.Sprintf(" (à %.0f NM)", distNM)
				}
				bestRDTSrc = AlertSource{
					Type:        "RDT",
					Phenomenon:  "TS/CB",
					Text:        rdtText(ftMin) + proximity,
					ForecastMin: ftMin,
				}
			}
		}
		if bestRDT > AlertNone {
			sources = append(sources, bestRDTSrc)
			if bestRDT > level {
				level = bestRDT
			}
		}

		if level > AlertNone {
			alerts = append(alerts, AirportAlert{
				ICAO:    ap.ICAO,
				Lat:     ap.Lat,
				Lon:     ap.Lon,
				Level:   level,
				Sources: sources,
			})
		}
	}

	return alerts, nil
}

// fetchFeatures récupère les features WFS (via cache) et les désérialise.
func (s *Service) fetchFeatures(ctx context.Context, typeName string, count int, filter string) ([]map[string]any, error) {
	raw, _, err := s.FeatureGeoJSON(ctx, typeName, count, filter)
	if err != nil {
		return nil, err
	}
	var fc struct {
		Features []map[string]any `json:"features"`
	}
	if err := json.Unmarshal(raw, &fc); err != nil {
		return nil, err
	}
	return fc.Features, nil
}

// propsOf extrait le champ "properties" d'une feature GeoJSON.
func propsOf(f map[string]any) map[string]any {
	p, _ := f["properties"].(map[string]any)
	if p == nil {
		return map[string]any{}
	}
	return p
}

// icaoFromProps extrait le code ICAO depuis les propriétés d'une feature.
// Essaie d'abord `locationIndicatorICAO` puis quelques variantes de noms.
func icaoFromProps(p map[string]any) string {
	// "id" est le champ ICAO des produits plats MetGate (SP_last, SA_last, FT_last, FC_last).
	for _, k := range []string{"locationIndicatorICAO", "id", "stationid", "icao", "station_id"} {
		if v, ok := p[k].(string); ok {
			v = strings.TrimSpace(strings.ToUpper(v))
			if len(v) == 4 {
				return v
			}
		}
	}
	// Tenter de lire depuis le TAC (SPECI/METAR : 1er ou 2e token).
	if tac, ok := p["tac"].(string); ok {
		return icaoFromMetarTAC(tac)
	}
	return ""
}

// icaoFromMetarTAC extrait le code ICAO d'un TAC METAR/SPECI.
// Format : [SPECI|METAR] ICAO DDHHMMz ...
func icaoFromMetarTAC(tac string) string {
	fields := strings.Fields(tac)
	idx := 0
	if len(fields) > 0 && (fields[0] == "SPECI" || fields[0] == "METAR") {
		idx = 1
	}
	if idx < len(fields) {
		f := strings.ToUpper(strings.TrimSpace(fields[idx]))
		if len(f) == 4 && isAllAlpha(f) {
			return f
		}
	}
	return ""
}

// icaoFromFirstToken extrait le 1er token d'un TAC (format MAA : "LFRD AD WRNG ...").
func icaoFromFirstToken(tac string) string {
	fields := strings.Fields(tac)
	if len(fields) == 0 {
		return ""
	}
	f := strings.ToUpper(strings.TrimSpace(fields[0]))
	if len(f) == 4 && isAllAlpha(f) {
		return f
	}
	return ""
}

func isAllAlpha(s string) bool {
	for _, c := range s {
		if (c < 'A' || c > 'Z') && (c < 'a' || c > 'z') {
			return false
		}
	}
	return len(s) > 0
}

// levelFromTAC détermine le niveau d'alerte à partir d'un TAC METAR/SPECI/MAA.
// Retourne (niveau, code phénomène, texte court).
func levelFromTAC(tac string) (AlertLevel, string, string) {
	if tac == "" {
		return AlertNone, "", ""
	}
	u := strings.ToUpper(tac)

	// Orage (TS) : priorité maximale.
	if rxTS.MatchString(u) || containsToken(u, "TSRA") || containsToken(u, "TSSN") ||
		containsToken(u, "TSGR") || containsToken(u, "TSGS") || containsToken(u, "VCTS") {
		return AlertRed, "TS", "Orage"
	}

	// Verglas / précipitations froides : orange.
	if containsToken(u, "FZRA") || containsToken(u, "FZDZ") || containsToken(u, "FZFG") ||
		containsToken(u, "GR") || containsToken(u, "+GR") {
		return AlertOrange, "FZ", "Verglaçant / grêle"
	}

	// Précipitations fortes ou neige.
	if containsToken(u, "+RA") || containsToken(u, "+SN") || containsToken(u, "SN") ||
		containsToken(u, "+DZ") || containsToken(u, "BLSN") || containsToken(u, "GS") ||
		containsToken(u, "RASN") || containsToken(u, "SNRA") {
		return AlertYellow, "SN/+RA", "Précipitations fortes ou neige"
	}

	// Faible visibilité, brouillard, pluie légère.
	if containsToken(u, "FG") || containsToken(u, "RA") || containsToken(u, "DZ") ||
		containsToken(u, "BR") || containsToken(u, "-RA") || containsToken(u, "-SN") {
		return AlertBlue, "FG/RA", "Brouillard ou précipitations"
	}

	return AlertNone, "", ""
}

// containsToken vérifie si `word` apparaît comme token délimité par des espaces
// ou marques de ponctuation dans `s` (déjà mis en majuscules).
func containsToken(s, word string) bool {
	return strings.Contains(s, " "+word+" ") ||
		strings.Contains(s, " "+word+"=") ||
		strings.Contains(s, " "+word+"\n") ||
		strings.Contains(s, "\n"+word+" ") ||
		strings.HasPrefix(s, word+" ") ||
		s == word
}

// rdtForecastMin extrait forecasttime en minutes depuis les properties d'un RDT.
func rdtForecastMin(p map[string]any) int {
	v := p["forecasttime"]
	switch n := v.(type) {
	case float64:
		return int(n)
	case string:
		if f, err := strconv.ParseFloat(n, 64); err == nil {
			return int(f)
		}
	}
	return 0
}

// rdtLevel mappe le forecasttime RDT sur un niveau d'alerte.
func rdtLevel(ftMin int) AlertLevel {
	switch {
	case ftMin <= 15:
		return AlertOrange // cellule présente ou dans 15 min
	case ftMin <= 30:
		return AlertYellow
	default:
		return AlertBlue // T+45 / T+60
	}
}

func rdtText(ftMin int) string {
	if ftMin == 0 {
		return "Cellule convective active"
	}
	return fmt.Sprintf("Cellule convective T+%d min", ftMin)
}

// pointInFeature teste si le point (lat, lon) est à l'intérieur de la géométrie
// GeoJSON de la feature (Polygon ou MultiPolygon). Utilise le ray-casting.
func pointInFeature(lat, lon float64, feature map[string]any) bool {
	geom, ok := feature["geometry"].(map[string]any)
	if !ok || geom == nil {
		return false
	}
	gtype, _ := geom["type"].(string)
	coords := geom["coordinates"]

	switch gtype {
	case "Polygon":
		rings := toRings(coords)
		if len(rings) == 0 {
			return false
		}
		return pointInRingXY(lon, lat, rings[0])
	case "MultiPolygon":
		polys := toMultiPolygon(coords)
		for _, poly := range polys {
			if len(poly) > 0 && pointInRingXY(lon, lat, poly[0]) {
				return true
			}
		}
	}
	return false
}

// pointInRingXY : ray-casting en coordonnées [lon, lat] (x=lon, y=lat).
func pointInRingXY(x, y float64, ring [][]float64) bool {
	n := len(ring)
	inside := false
	j := n - 1
	for i := 0; i < n; i++ {
		xi, yi := ring[i][0], ring[i][1]
		xj, yj := ring[j][0], ring[j][1]
		if ((yi > y) != (yj > y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi) {
			inside = !inside
		}
		j = i
	}
	return inside
}

func toRings(v any) [][][]float64 {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([][][]float64, 0, len(arr))
	for _, r := range arr {
		ring := toRing(r)
		if ring != nil {
			out = append(out, ring)
		}
	}
	return out
}

func toRing(v any) [][]float64 {
	pts, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([][]float64, 0, len(pts))
	for _, p := range pts {
		pair, ok := p.([]any)
		if !ok || len(pair) < 2 {
			continue
		}
		x, ok1 := toFloat64(pair[0])
		y, ok2 := toFloat64(pair[1])
		if ok1 && ok2 {
			out = append(out, []float64{x, y})
		}
	}
	return out
}

func toMultiPolygon(v any) [][][][]float64 {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([][][][]float64, 0, len(arr))
	for _, poly := range arr {
		rings := toRings(poly)
		if rings != nil {
			out = append(out, rings)
		}
	}
	return out
}

func toFloat64(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

// centroidDistNM calcule la distance en NM entre (lat, lon) et le centroïde
// approximatif du premier anneau extérieur de la géométrie de la feature.
// Renvoie +Inf si la géométrie est absente ou illisible.
func centroidDistNM(lat, lon float64, feature map[string]any) float64 {
	geom, ok := feature["geometry"].(map[string]any)
	if !ok || geom == nil {
		return math.Inf(1)
	}
	gtype, _ := geom["type"].(string)
	coords := geom["coordinates"]

	var ring [][]float64
	switch gtype {
	case "Polygon":
		rings := toRings(coords)
		if len(rings) > 0 {
			ring = rings[0]
		}
	case "MultiPolygon":
		polys := toMultiPolygon(coords)
		if len(polys) > 0 && len(polys[0]) > 0 {
			ring = polys[0][0]
		}
	}
	if len(ring) == 0 {
		return math.Inf(1)
	}

	// Centroïde = moyenne des sommets (précis pour des polygones convexes).
	var sumX, sumY float64
	for _, pt := range ring {
		sumX += pt[0]
		sumY += pt[1]
	}
	cLon := sumX / float64(len(ring))
	cLat := sumY / float64(len(ring))
	return haversineNM(lat, lon, cLat, cLon)
}

// haversineNM : distance orthodromique en NM entre deux points (lat/lon en degrés).
func haversineNM(lat1, lon1, lat2, lon2 float64) float64 {
	const r = 3440.065 // rayon terrestre en NM
	const deg = math.Pi / 180
	p1 := lat1 * deg
	p2 := lat2 * deg
	dp := (lat2 - lat1) * deg
	dl := (lon2 - lon1) * deg
	s1 := math.Sin(dp / 2)
	s2 := math.Sin(dl / 2)
	a := s1*s1 + math.Cos(p1)*math.Cos(p2)*s2*s2
	return 2 * r * math.Asin(math.Sqrt(a))
}
