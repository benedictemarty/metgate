package catalog

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"github.com/bmarty/metgate/internal/decoder"
)

// GMLToGeoJSON convertit une wfs:FeatureCollection GML 3.2 (sortie MetGate)
// en GeoJSON FeatureCollection.
//
// Limitations actuelles :
//   - seules les géométries Point sont extraites (cas METAR/TAF/SPECI/AIRMET) ;
//     les Polygon/MultiPolygon (SIGMET, zones de turbulence) ne sont pas
//     encore supportés et la feature est ignorée.
//   - le champ opmet_msg (IWXXM XML brut, parfois > 10 KB) est volontairement
//     omis pour ne pas alourdir le GeoJSON. Le client peut le récupérer
//     séparément via une route dédiée si besoin.
//   - axe-order EPSG:4326 dans MetGate = lat,lon ; on swap en [lon,lat]
//     pour respecter GeoJSON RFC 7946.
func GMLToGeoJSON(body []byte, typeName string) ([]byte, error) {
	dec := xml.NewDecoder(bytes.NewReader(body))
	features := []map[string]any{}

	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("gml parse: %w", err)
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local != "member" {
			continue
		}
		f, err := parseMember(dec, typeName)
		if err != nil {
			return nil, err
		}
		if f != nil {
			features = append(features, f)
		}
	}

	return json.Marshal(map[string]any{
		"type":     "FeatureCollection",
		"features": features,
	})
}

// parseMember consomme le contenu jusqu'au </member> et tente d'en extraire
// une feature GeoJSON. Renvoie nil si aucune géométrie utilisable.
// typeName (ex: "METAR_last") sert à router le décodage TAC → texte FR.
func parseMember(dec *xml.Decoder, typeName string) (map[string]any, error) {
	props := map[string]any{}
	var geom map[string]any
	depth := 0

	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			local := t.Name.Local
			depth++
			// Le premier StartElement (depth=1) est le type de feature ;
			// on n'en fait rien et on continue à descendre.
			if depth == 1 {
				continue
			}
			switch local {
			case "boundedBy":
				if err := dec.Skip(); err != nil {
					return nil, err
				}
				depth--
			case "opmet_msg":
				// opmet_msg peut contenir :
				//   - du IWXXM XML (METAR, TAF, SIGMET, AIRMET récents) → on
				//     extrait le TAC ou on reconstruit depuis les champs scalaires
				//   - du TAC brut (Aerodrome Warnings WL = code MAA Météo France,
				//     parfois SIGMET/TAF anciens) → on le pose directement
				txt, err := readNestedText(dec, t)
				if err != nil {
					return nil, err
				}
				trimmed := strings.TrimSpace(txt)
				if strings.HasPrefix(trimmed, "<") {
					enrichFromIWXXM(props, trimmed)
				} else if trimmed != "" {
					props["tac"] = trimmed
				}
				depth--
			case "msGeometry", "geom", "geometry", "the_geom":
				g, err := parseGeometry(dec)
				if err != nil {
					return nil, err
				}
				geom = g
				depth--
			default:
				text, err := readNestedText(dec, t)
				if err != nil {
					return nil, err
				}
				if text != "" {
					props[local] = text
				}
				depth--
			}
		case xml.EndElement:
			if t.Name.Local == "member" {
				if geom == nil {
					return nil, nil
				}
				if tac, ok := props["tac"].(string); ok && tac != "" {
					if d := decoder.Decode(typeName, tac); d != "" {
						props["decoded"] = d
					}
					// Pour les produits plats (SA_last, SP_last) : extraire T/Td/QNH/vent
					// depuis le TAC si les champs structurés sont absents.
					if _, hasTemp := props["airTemperature_C"]; !hasTemp {
						enrichFromTAC(props, tac)
					}
				}
				out := map[string]any{
					"type":       "Feature",
					"geometry":   geom,
					"properties": props,
				}
				if id, ok := props["ogc_fid"]; ok {
					out["id"] = id
				}
				return out, nil
			}
			depth--
		}
	}
}

// parseGeometry cherche une géométrie GML supportée (Point, Polygon,
// MultiSurface→MultiPolygon) dans le conteneur géométrique courant.
// Renvoie nil si rien d'exploitable.
func parseGeometry(dec *xml.Decoder) (map[string]any, error) {
	var geom map[string]any
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "Point":
				lon, lat, err := readPos(dec)
				if err != nil {
					return nil, err
				}
				geom = map[string]any{
					"type":        "Point",
					"coordinates": []float64{lon, lat},
				}
			case "Polygon":
				rings, err := parsePolygon(dec)
				if err != nil {
					return nil, err
				}
				if len(rings) > 0 {
					geom = map[string]any{
						"type":        "Polygon",
						"coordinates": rings,
					}
				}
			case "MultiSurface", "MultiPolygon":
				polys, err := parseMultiPolygon(dec)
				if err != nil {
					return nil, err
				}
				if len(polys) > 0 {
					geom = map[string]any{
						"type":        "MultiPolygon",
						"coordinates": polys,
					}
				}
			default:
				if err := dec.Skip(); err != nil {
					return nil, err
				}
			}
		case xml.EndElement:
			return geom, nil
		}
	}
}

// parsePolygon lit un gml:Polygon (gml:exterior + 0..N gml:interior) et
// renvoie les anneaux comme [exterior, hole1, hole2, ...] où chaque anneau
// est []{lon, lat}.
func parsePolygon(dec *xml.Decoder) ([][][]float64, error) {
	var rings [][][]float64
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "exterior", "interior":
				ring, err := parseRing(dec)
				if err != nil {
					return nil, err
				}
				if len(ring) >= 4 { // anneau valide : 3 points + fermeture
					rings = append(rings, ring)
				}
			default:
				if err := dec.Skip(); err != nil {
					return nil, err
				}
			}
		case xml.EndElement:
			return rings, nil
		}
	}
}

// parseRing lit un gml:LinearRing > gml:posList "lat lon lat lon..." et
// retourne []{lon, lat}. Appelé après consommation de <gml:exterior> ou
// <gml:interior>, doit consommer jusqu'à l'EndElement matching.
//
// On tient un compteur car <LinearRing> introduit un EndElement
// supplémentaire (</LinearRing>) avant le </exterior> attendu.
func parseRing(dec *xml.Decoder) ([][]float64, error) {
	var coords [][]float64
	depth := 0
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "LinearRing", "Ring":
				depth++ // niveau supplémentaire à dépiler
			case "posList":
				txt, err := readText(dec) // consomme </posList>
				if err != nil {
					return nil, err
				}
				coords = parsePosList(txt)
			default:
				if err := dec.Skip(); err != nil {
					return nil, err
				}
			}
		case xml.EndElement:
			if depth == 0 {
				return coords, nil
			}
			depth--
		}
	}
}

// parseMultiPolygon lit un gml:MultiSurface (ou MultiPolygon) et collecte
// chaque sous-Polygon. Retourne [polygon1, polygon2, ...] où chaque polygon
// est [[exterior, hole1, ...]].
func parseMultiPolygon(dec *xml.Decoder) ([][][][]float64, error) {
	var polys [][][][]float64
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "surfaceMember", "polygonMember":
				poly, err := readNestedPolygon(dec)
				if err != nil {
					return nil, err
				}
				if len(poly) > 0 {
					polys = append(polys, poly)
				}
			default:
				if err := dec.Skip(); err != nil {
					return nil, err
				}
			}
		case xml.EndElement:
			return polys, nil
		}
	}
}

// readNestedPolygon descend dans un surfaceMember/polygonMember et lit le
// gml:Polygon qui s'y trouve.
func readNestedPolygon(dec *xml.Decoder) ([][][]float64, error) {
	var rings [][][]float64
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "Polygon" {
				r, err := parsePolygon(dec)
				if err != nil {
					return nil, err
				}
				rings = r
			} else {
				if err := dec.Skip(); err != nil {
					return nil, err
				}
			}
		case xml.EndElement:
			return rings, nil
		}
	}
}

// parsePosList convertit "lat lon lat lon ..." (axe-order EPSG:4326 MetGate)
// en []{lon, lat} pour GeoJSON.
func parsePosList(s string) [][]float64 {
	parts := strings.Fields(s)
	if len(parts) < 2 || len(parts)%2 != 0 {
		return nil
	}
	out := make([][]float64, 0, len(parts)/2)
	for i := 0; i+1 < len(parts); i += 2 {
		la, e1 := strconv.ParseFloat(parts[i], 64)
		lo, e2 := strconv.ParseFloat(parts[i+1], 64)
		if e1 != nil || e2 != nil {
			continue
		}
		out = append(out, []float64{lo, la})
	}
	return out
}

// readPos lit <gml:pos>LAT LON</gml:pos> dans un <gml:Point>.
// MetGate publie en EPSG:4326 axe lat,lon ; on retourne (lon, lat) pour GeoJSON.
func readPos(dec *xml.Decoder) (lon, lat float64, err error) {
	for {
		tok, e := dec.Token()
		if e != nil {
			return 0, 0, e
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "pos" {
				txt, e := readText(dec)
				if e != nil {
					return 0, 0, e
				}
				parts := strings.Fields(txt)
				if len(parts) < 2 {
					return 0, 0, fmt.Errorf("gml:pos invalide: %q", txt)
				}
				la, e1 := strconv.ParseFloat(parts[0], 64)
				lo, e2 := strconv.ParseFloat(parts[1], 64)
				if e1 != nil || e2 != nil {
					return 0, 0, fmt.Errorf("gml:pos non numérique: %q", txt)
				}
				// On n'a pas encore consommé </Point> — skip jusqu'à la fin.
				if err := dec.Skip(); err != nil {
					return 0, 0, err
				}
				return lo, la, nil
			}
			if err := dec.Skip(); err != nil {
				return 0, 0, err
			}
		case xml.EndElement:
			return 0, 0, fmt.Errorf("gml:pos absent dans le Point")
		}
	}
}

// readText collecte le texte scalaire d'un élément simple (jusqu'à la balise fermante).
func readText(dec *xml.Decoder) (string, error) {
	var sb strings.Builder
	for {
		tok, err := dec.Token()
		if err != nil {
			return "", err
		}
		switch t := tok.(type) {
		case xml.CharData:
			sb.Write(t)
		case xml.EndElement:
			return strings.TrimSpace(sb.String()), nil
		case xml.StartElement:
			// élément imbriqué inattendu — on en prend juste le texte
			inner, err := readText(dec)
			if err != nil {
				return "", err
			}
			sb.WriteString(inner)
		}
	}
}

var (
	// IWXXM 2021-2 et antérieurs conservaient le TAC d'origine en attribut.
	rxTACAttr = regexp.MustCompile(`translated(?:Failed)?TAC="([^"]*)"`)

	// IWXXM 3.0 : champs scalaires utiles pour reconstruire un TAC compact.
	rxAirTemp  = regexp.MustCompile(`<iwxxm:airTemperature[^>]*uom="([^"]+)"[^>]*>([^<]+)</iwxxm:airTemperature>`)
	rxDewTemp  = regexp.MustCompile(`<iwxxm:dewpointTemperature[^>]*uom="([^"]+)"[^>]*>([^<]+)</iwxxm:dewpointTemperature>`)
	rxQNH      = regexp.MustCompile(`<iwxxm:qnh[^>]*uom="([^"]+)"[^>]*>([^<]+)</iwxxm:qnh>`)
	rxWindDir  = regexp.MustCompile(`<iwxxm:meanWindDirection[^>]*uom="([^"]+)"[^>]*>([^<]+)</iwxxm:meanWindDirection>`)
	rxWindSpd  = regexp.MustCompile(`<iwxxm:meanWindSpeed[^>]*uom="([^"]+)"[^>]*>([^<]+)</iwxxm:meanWindSpeed>`)
	rxCAVOK    = regexp.MustCompile(`cloudAndVisibilityOK="(true|false)"`)
	rxVisi     = regexp.MustCompile(`<iwxxm:prevailingVisibility[^>]*uom="([^"]+)"[^>]*>([^<]+)</iwxxm:prevailingVisibility>`)
	rxICAOInfo = regexp.MustCompile(`<aixm:designator>([^<]+)</aixm:designator>`)

	// TAC brut (SA_last, SP_last, FT_last, FC_last) — patterns positionnels METAR/TAF OACI.
	rxTACWindKT  = regexp.MustCompile(`\b(VRB|\d{3})(\d{2,3})(?:G\d{2,3})?KT\b`)
	rxTACWindMPS = regexp.MustCompile(`\b(VRB|\d{3})(\d{2,3})(?:G\d{2,3})?MPS\b`)
	rxTACTempDew = regexp.MustCompile(`\b(M?\d{2})/(M?\d{2})\b`)
	rxTACQNH     = regexp.MustCompile(`\bQ(\d{4})\b`)
	rxTACCAVOK   = regexp.MustCompile(`\bCAVOK\b`)
)

// enrichFromIWXXM extrait du payload IWXXM les champs courants et les ajoute
// aux properties GeoJSON ; calcule également un champ `tac` (texte court)
// soit en reprenant l'attribut translatedFailedTAC s'il existe, soit en
// reconstruisant un TAC minimal à partir des champs IWXXM 3.0.
func enrichFromIWXXM(props map[string]any, opmet string) {
	if m := rxTACAttr.FindStringSubmatch(opmet); len(m) >= 2 && strings.TrimSpace(m[1]) != "" {
		props["tac"] = strings.TrimSpace(m[1])
		return
	}

	// Cas TAF / SIGMET / AIRMET (IWXXM 3.0+) : pas de TAC reconstituable
	// simple, on décode directement le XML structuré en français. Consigne :
	// « afficher le TAC s'il existe, sinon uniquement la traduction ».
	if strings.Contains(opmet, "<iwxxm:TAF") || strings.Contains(opmet, ":TAF ") {
		if d := decoder.DecodeIWXXMTAF(opmet); d != "" {
			props["decoded"] = d
		}
		return
	}
	if strings.Contains(opmet, "<iwxxm:SIGMET ") ||
		strings.Contains(opmet, "<iwxxm:VolcanicAshSIGMET") ||
		strings.Contains(opmet, "<iwxxm:TropicalCycloneSIGMET") {
		if d := decoder.DecodeIWXXMSIGMET(opmet); d != "" {
			props["decoded"] = d
		}
		return
	}
	if strings.Contains(opmet, "<iwxxm:AIRMET") {
		if d := decoder.DecodeIWXXMAIRMET(opmet); d != "" {
			props["decoded"] = d
		}
		return
	}

	get := func(rx *regexp.Regexp) (val, uom string) {
		m := rx.FindStringSubmatch(opmet)
		if len(m) >= 3 {
			return strings.TrimSpace(m[2]), m[1]
		}
		return "", ""
	}

	temp, _ := get(rxAirTemp)
	dew, _ := get(rxDewTemp)
	qnh, _ := get(rxQNH)
	wdir, _ := get(rxWindDir)
	wspd, _ := get(rxWindSpd)
	visi, _ := get(rxVisi)
	cavok := false
	if m := rxCAVOK.FindStringSubmatch(opmet); len(m) >= 2 && m[1] == "true" {
		cavok = true
	}

	if temp != "" {
		props["airTemperature_C"] = temp
	}
	if dew != "" {
		props["dewpointTemperature_C"] = dew
	}
	if qnh != "" {
		props["qnh_hPa"] = qnh
	}
	if wdir != "" {
		props["windDirection_deg"] = wdir
	}
	if wspd != "" {
		props["windSpeed_kt"] = wspd
	}
	if visi != "" {
		props["visibility_m"] = visi
	}
	if cavok {
		props["cavok"] = true
	}

	icao, _ := props["locationIndicatorICAO"].(string)
	if icao == "" {
		if m := rxICAOInfo.FindStringSubmatch(opmet); len(m) >= 2 {
			icao = strings.TrimSpace(m[1])
		}
	}

	if temp != "" || wspd != "" {
		props["tac"] = formatTAC(icao, props, temp, dew, qnh, wdir, wspd, cavok)
	}
}

// formatTAC compose un TAC simplifié dans l'esprit OACI mais lisible :
// `METAR LFPG 252210Z 240/10KT CAVOK 09/03 Q1018=`
func formatTAC(icao string, props map[string]any, temp, dew, qnh, wdir, wspd string, cavok bool) string {
	var sb strings.Builder
	sb.WriteString("METAR ")
	if icao != "" {
		sb.WriteString(icao)
		sb.WriteByte(' ')
	}
	if t, ok := props["observationTime"].(string); ok && len(t) >= 16 {
		// 2026-04-25T22:50:00Z → 252250Z
		sb.WriteString(t[8:10] + t[11:13] + t[14:16] + "Z ")
	}
	if wdir != "" || wspd != "" {
		if wdir == "" {
			wdir = "VRB"
		}
		if wspd == "" {
			wspd = "//"
		}
		fmt.Fprintf(&sb, "%s/%sKT ", trimDecimals(wdir), trimDecimals(wspd))
	}
	if cavok {
		sb.WriteString("CAVOK ")
	}
	if temp != "" || dew != "" {
		fmt.Fprintf(&sb, "%s/%s ", trimDecimals(temp), trimDecimals(dew))
	}
	if qnh != "" {
		fmt.Fprintf(&sb, "Q%s ", trimDecimals(qnh))
	}
	return strings.TrimSpace(sb.String()) + "="
}

func trimDecimals(s string) string {
	if i := strings.IndexByte(s, '.'); i >= 0 {
		// "31.0" → "31", "1007.0" → "1007"
		return s[:i]
	}
	return s
}

// enrichFromTAC parse un TAC METAR/TAF brut (SA_last, SP_last, FT_last, FC_last)
// et renseigne les mêmes champs structurés qu'enrichFromIWXXM (T, Td, QNH, wind).
// N'écrase pas un champ déjà présent (priorité IWXXM si les deux coexistent).
func enrichFromTAC(props map[string]any, tac string) {
	set := func(k, v string) {
		if _, exists := props[k]; !exists && v != "" {
			props[k] = v
		}
	}

	// Vent KT : 25012KT / VRB03KT / 25012G18KT
	if m := rxTACWindKT.FindStringSubmatch(tac); len(m) >= 3 {
		if m[1] != "VRB" {
			set("windDirection_deg", m[1])
		}
		set("windSpeed_kt", m[2])
	} else if m := rxTACWindMPS.FindStringSubmatch(tac); len(m) >= 3 {
		// Vent MPS (ex: TAF russe/asiatique) → conversion en kt (×1.944, arrondi)
		if m[1] != "VRB" {
			set("windDirection_deg", m[1])
		}
		if n, err := strconv.Atoi(m[2]); err == nil {
			set("windSpeed_kt", strconv.Itoa(int(float64(n)*1.944+0.5)))
		}
	}

	// Température / point de rosée : 15/07 ou M03/M07 (négatif)
	if m := rxTACTempDew.FindStringSubmatch(tac); len(m) >= 3 {
		conv := func(s string) string {
			if strings.HasPrefix(s, "M") {
				return "-" + s[1:]
			}
			return s
		}
		set("airTemperature_C", conv(m[1]))
		set("dewpointTemperature_C", conv(m[2]))
	}

	// QNH : Q1018
	if m := rxTACQNH.FindStringSubmatch(tac); len(m) >= 2 {
		set("qnh_hPa", m[1])
	}

	// CAVOK
	if rxTACCAVOK.MatchString(tac) {
		if _, exists := props["cavok"]; !exists {
			props["cavok"] = true
		}
	}
}

// readNestedText lit le contenu textuel d'un élément, en tolérant un seul
// niveau d'imbrication (cas observationTime > gml:timePosition).
func readNestedText(dec *xml.Decoder, current xml.StartElement) (string, error) {
	var sb strings.Builder
	for {
		tok, err := dec.Token()
		if err != nil {
			return "", err
		}
		switch t := tok.(type) {
		case xml.CharData:
			sb.Write(t)
		case xml.EndElement:
			if t.Name.Local == current.Name.Local {
				return strings.TrimSpace(sb.String()), nil
			}
		case xml.StartElement:
			inner, err := readText(dec)
			if err != nil {
				return "", err
			}
			sb.WriteString(inner)
		}
	}
}
