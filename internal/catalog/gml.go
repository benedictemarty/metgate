package catalog

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"strconv"
	"strings"
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
func GMLToGeoJSON(body []byte) ([]byte, error) {
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
		f, err := parseMember(dec)
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
func parseMember(dec *xml.Decoder) (map[string]any, error) {
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
				// CDATA IWXXM volumineux — on saute.
				if err := dec.Skip(); err != nil {
					return nil, err
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

// parseGeometry cherche un gml:Point dans le conteneur géométrique courant.
// Renvoie nil si rien d'exploitable.
func parseGeometry(dec *xml.Decoder) (map[string]any, error) {
	var pt map[string]any
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "Point" {
				lon, lat, err := readPos(dec)
				if err != nil {
					return nil, err
				}
				pt = map[string]any{
					"type":        "Point",
					"coordinates": []float64{lon, lat},
				}
			} else {
				if err := dec.Skip(); err != nil {
					return nil, err
				}
			}
		case xml.EndElement:
			return pt, nil
		}
	}
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
