package catalog

import "testing"

func TestEnrichSIGMETProps_TurbForte(t *testing.T) {
	props := map[string]interface{}{
		"decoded": `SIGMET
Numéro : L08
FIR : YMMM MELBOURNE FIR
Émission : 2026-05-02 00:31 UTC
Validité : 2026-05-02 00:51 UTC → 2026-05-02 04:51 UTC
Phénomène : turbulence forte

Prévision :
    Plafond : FL340
    Plancher : FL290
    Mouvement : 90° à 15 kt
    Évolution : faiblissant`,
	}
	enrichSIGMETLikeProps(props)
	checkInt(t, props, "parsed_fl_min", 290)
	checkInt(t, props, "parsed_fl_max", 340)
	checkStr(t, props, "parsed_phenomenon", "turbulence forte")
	checkStr(t, props, "parsed_evolution", "faiblissant")
	checkFloat(t, props, "parsed_movement_dir_deg", 90)
	checkFloat(t, props, "parsed_movement_speed_kt", 15)
}

func TestEnrichSIGMETProps_PlafondSeul(t *testing.T) {
	props := map[string]interface{}{
		"decoded": `SIGMET
Phénomène : orages noyés (EMBD TS)
Observation :
    Plafond : FL500
    Mouvement : 247.5° à 10 kt`,
	}
	enrichSIGMETLikeProps(props)
	// Plafond seul : plancher 0 par convention surface→FL.
	checkInt(t, props, "parsed_fl_min", 0)
	checkInt(t, props, "parsed_fl_max", 500)
	checkStr(t, props, "parsed_phenomenon", "orages noyés (EMBD TS)")
	checkFloat(t, props, "parsed_movement_dir_deg", 247.5)
}

func TestEnrichSIGMETProps_NoFL(t *testing.T) {
	// SIGMET sans plafond/plancher : on ne touche pas aux clefs FL.
	props := map[string]interface{}{
		"decoded": `SIGMET
FIR : NFFF
Validité : ...`,
	}
	enrichSIGMETLikeProps(props)
	if _, ok := props["parsed_fl_min"]; ok {
		t.Errorf("parsed_fl_min ne devrait pas être ajouté")
	}
	if _, ok := props["parsed_fl_max"]; ok {
		t.Errorf("parsed_fl_max ne devrait pas être ajouté")
	}
}

func TestEnrichSIGMETProps_NoDecoded(t *testing.T) {
	props := map[string]interface{}{}
	enrichSIGMETLikeProps(props) // ne doit pas paniquer
	if len(props) != 0 {
		t.Errorf("props ne devrait pas être modifiée: %v", props)
	}
	enrichSIGMETLikeProps(nil) // ne doit pas paniquer
}

func checkInt(t *testing.T, p map[string]interface{}, k string, want int) {
	t.Helper()
	v, ok := p[k]
	if !ok {
		t.Errorf("%s manquant", k)
		return
	}
	if vi, ok := v.(int); !ok || vi != want {
		t.Errorf("%s = %v, want %d", k, v, want)
	}
}

func checkStr(t *testing.T, p map[string]interface{}, k string, want string) {
	t.Helper()
	v, ok := p[k]
	if !ok {
		t.Errorf("%s manquant", k)
		return
	}
	if vs, ok := v.(string); !ok || vs != want {
		t.Errorf("%s = %v, want %q", k, v, want)
	}
}

func checkFloat(t *testing.T, p map[string]interface{}, k string, want float64) {
	t.Helper()
	v, ok := p[k]
	if !ok {
		t.Errorf("%s manquant", k)
		return
	}
	if vf, ok := v.(float64); !ok || vf != want {
		t.Errorf("%s = %v, want %v", k, v, want)
	}
}
