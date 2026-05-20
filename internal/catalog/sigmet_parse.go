package catalog

import (
	"regexp"
	"strconv"
	"strings"
)

// enrichSIGMETLikeProps parse le champ `decoded` (texte FR formaté par
// MetGate) des SIGMET / AIRMET / VolcanicAshSIGMET / TropicalCycloneSIGMET
// et ajoute des clefs structurées dans props :
//   - parsed_fl_min  (int, FL plancher)
//   - parsed_fl_max  (int, FL plafond)
//   - parsed_phenomenon       (string)
//   - parsed_evolution        (string)
//   - parsed_movement_dir_deg (float64)
//   - parsed_movement_speed_kt (float64)
//
// Les clefs ne sont ajoutées que si le pattern est trouvé : un consommateur
// qui les ignore ne change pas de comportement.
func enrichSIGMETLikeProps(props map[string]interface{}) {
	if props == nil {
		return
	}
	raw, ok := props["decoded"].(string)
	if !ok || raw == "" {
		return
	}

	// FL : "Plafond : FL340" / "Plancher : FL290" — éventuellement avec
	// préfixes parasites (espaces, accents alternatifs). Capture le nombre.
	if m := reFLPlafond.FindStringSubmatch(raw); len(m) > 1 {
		if v, err := strconv.Atoi(m[1]); err == nil {
			props["parsed_fl_max"] = v
		}
	}
	if m := reFLPlancher.FindStringSubmatch(raw); len(m) > 1 {
		if v, err := strconv.Atoi(m[1]); err == nil {
			props["parsed_fl_min"] = v
		}
	}
	// Si seul plafond connu, plancher=0 par convention SIGMET (surface→FL).
	if _, hasMax := props["parsed_fl_max"]; hasMax {
		if _, hasMin := props["parsed_fl_min"]; !hasMin {
			props["parsed_fl_min"] = 0
		}
	}

	if m := rePhenomenon.FindStringSubmatch(raw); len(m) > 1 {
		props["parsed_phenomenon"] = strings.TrimSpace(m[1])
	}
	if m := reEvolution.FindStringSubmatch(raw); len(m) > 1 {
		props["parsed_evolution"] = strings.TrimSpace(m[1])
	}
	if m := reMovement.FindStringSubmatch(raw); len(m) > 2 {
		if dir, err := strconv.ParseFloat(m[1], 64); err == nil {
			props["parsed_movement_dir_deg"] = dir
		}
		if spd, err := strconv.ParseFloat(m[2], 64); err == nil {
			props["parsed_movement_speed_kt"] = spd
		}
	}
}

// Patterns. Le texte vient d'un decoder MetGate qui peut varier (espaces,
// majuscules) : on accepte du flou et on tronque au premier saut de ligne.
var (
	reFLPlafond  = regexp.MustCompile(`(?i)Plafond\s*:\s*FL\s*(\d{1,3})`)
	reFLPlancher = regexp.MustCompile(`(?i)Plancher\s*:\s*FL\s*(\d{1,3})`)
	rePhenomenon = regexp.MustCompile(`(?i)Ph[ée]nom[èe]ne\s*:\s*([^\r\n]+)`)
	reEvolution  = regexp.MustCompile(`(?i)[ÉE]volution\s*:\s*([^\r\n]+)`)
	reMovement   = regexp.MustCompile(`(?i)Mouvement\s*:\s*(\d+(?:\.\d+)?)\s*°\s*à\s*(\d+(?:\.\d+)?)\s*kt`)
)
