package fir

import (
	"encoding/json"
	"testing"
)

type featureCollection struct {
	Type     string `json:"type"`
	Features []struct {
		Type       string `json:"type"`
		Properties struct {
			ICAO string `json:"icao"`
			Name string `json:"name"`
			Type string `json:"type"`
			UIR  bool   `json:"uir"`
		} `json:"properties"`
		Geometry struct {
			Type string `json:"type"`
		} `json:"geometry"`
	} `json:"features"`
}

// TestWorldGeoJSON valide l'asset FIR/UIR embarqué (source EUROCONTROL EAD,
// cf. gen_fir.py) : structure GeoJSON, schéma de propriétés attendu par le
// frontend (icao/uir) et couverture mondiale réelle.
func TestWorldGeoJSON(t *testing.T) {
	var fc featureCollection
	if err := json.Unmarshal(WorldGeoJSON, &fc); err != nil {
		t.Fatalf("fir_world.geojson illisible : %v", err)
	}
	if fc.Type != "FeatureCollection" {
		t.Fatalf("type racine = %q, attendu FeatureCollection", fc.Type)
	}
	if len(fc.Features) < 300 {
		t.Fatalf("seulement %d FIR/UIR, attendu ~336 (couverture mondiale OACI)", len(fc.Features))
	}

	ids := make(map[string]bool, len(fc.Features))
	var firCount, uirCount int
	for _, f := range fc.Features {
		if f.Properties.ICAO == "" {
			t.Errorf("feature sans propriété icao : %+v", f.Properties)
		}
		switch f.Geometry.Type {
		case "Polygon", "MultiPolygon":
		default:
			t.Errorf("géométrie inattendue %q pour %s", f.Geometry.Type, f.Properties.ICAO)
		}
		// uir doit être cohérent avec type
		if (f.Properties.Type == "UIR") != f.Properties.UIR {
			t.Errorf("incohérence uir/type pour %s : type=%q uir=%v", f.Properties.ICAO, f.Properties.Type, f.Properties.UIR)
		}
		ids[f.Properties.ICAO] = true
		if f.Properties.UIR {
			uirCount++
		} else {
			firCount++
		}
	}
	if firCount == 0 || uirCount == 0 {
		t.Fatalf("attendu des FIR et des UIR, obtenu FIR=%d UIR=%d", firCount, uirCount)
	}

	// Échantillon mondial : Europe, Amérique du Nord, Asie, Afrique, Océanie.
	for _, want := range []string{"LFFF", "EGTT", "KZNY", "VABF", "FACA", "RJJJ", "YBBB"} {
		if !ids[want] {
			t.Errorf("FIR/UIR attendue absente : %s", want)
		}
	}
}
