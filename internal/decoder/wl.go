package decoder

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	// Format VALID DDHHMM/DDHHMM (jour, heure, minute) sur 6 chiffres.
	rxWLHeader = regexp.MustCompile(`^([A-Z]{4})\s+AD\s+WRNG\s+(\d+)(?:\s+VALID\s+(\d{2})(\d{2})(\d{2})/(\d{2})(\d{2})(\d{2}))?`)
	rxWLCNL    = regexp.MustCompile(`^([A-Z]{4})\s+CNL\s+AD\s+WRNG\s+(\d+)\s+(\d{2})(\d{2})(\d{2})/(\d{2})(\d{2})(\d{2})`)
	rxWLNoWarn = regexp.MustCompile(`^NO\s+WARNING\s+BETWEEN\s+(\d{1,2}:\d{2})\s+AND\s+(\d{1,2}:\d{2})`)
	rxSFCWind  = regexp.MustCompile(`SFC\s+W(?:S)?PD?\s+(?:MAX\s+)?(>=|<=|>|<)?\s*(\d+)\s*KT`)
)

// Phénomènes WL/MAA reconnus (codes WMO + abréviations Météo-France).
// La traduction est volontairement courte et neutre ; le TAC reste affiché.
var wlPhenomena = map[string]string{
	"TS":             "orages",
	"TSGR":           "orages avec grêle",
	"GR":             "grêle",
	"HAIL":           "grêle",
	"SQ":             "grain",
	"LSQ":            "ligne de grain",
	"FG":             "brouillard",
	"FZFG":           "brouillard givrant",
	"SN":             "neige",
	"BLSN":           "chasse-neige élevée",
	"DRSN":           "chasse-neige basse",
	"BLDU":           "chasse-poussière élevée",
	"BLSA":           "chasse-sable élevée",
	"VA":             "cendres volcaniques",
	"DS":             "tempête de poussière",
	"SS":             "tempête de sable",
	"TC":             "cyclone tropical",
	"TSUNAMI":        "tsunami",
	"FZRA":           "pluie verglaçante",
	"FZDZ":           "bruine verglaçante",
	"FRZG":           "gel",
	"FROST":          "gel",
	"ICG":            "givrage",
	"TURB":           "turbulence",
	"CB":             "cumulonimbus",
	"TCU":            "cumulus bourgeonnants",
	"LTG":            "foudre",
	"LIGHTNING":      "foudre",
	"HEATWAVE":       "vague de chaleur",
	"COLDWAVE":       "vague de froid",
	"LOW VISIBILITY": "faible visibilité",
	"LOW VIS":        "faible visibilité",
	"VOLCANIC ASH":   "cendres volcaniques",
	"SANDSTORM":      "tempête de sable",
	"DUSTSTORM":      "tempête de poussière",
	"BLOWING SNOW":   "chasse-neige",
	"FREEZING RAIN":  "pluie verglaçante",
	"HVY RA":         "fortes pluies",
	"HVYRA":          "fortes pluies",
	"HVY SN":         "fortes chutes de neige",
	"HVYSN":          "fortes chutes de neige",
	"HVY TS":         "orages violents",
	"HVYDS":          "forte tempête de poussière",
	"HVYSS":          "forte tempête de sable",
}

// DecodeWL transforme un message Aerodrome Warning (MAA / code WMO WL) en
// texte FR. Le TAC est composé d'une ligne d'entête + N lignes de phénomènes
// prévus ou observés, terminé par "=".
func DecodeWL(tac string) string {
	tac = strings.TrimSpace(strings.TrimRight(strings.TrimSpace(tac), "="))
	if tac == "" {
		return ""
	}
	lines := strings.Split(tac, "\n")
	var out []string
	out = append(out, "Aerodrome Warning (MAA)")

	for i, raw := range lines {
		line := strings.TrimSpace(strings.TrimRight(raw, "="))
		if line == "" {
			continue
		}
		if i == 0 {
			if m := rxWLCNL.FindStringSubmatch(line); m != nil {
				out = append(out,
					"Aérodrome : "+m[1],
					fmt.Sprintf("Annulation du warning n°%s (validité initiale jour %s %s:%s → jour %s %s:%s UTC)",
						m[2], m[3], m[4], m[5], m[6], m[7], m[8]))
				continue
			}
			out = append(out, decodeWLHeader(line)...)
			continue
		}
		if m := rxWLNoWarn.FindStringSubmatch(line); m != nil {
			out = append(out, fmt.Sprintf("Pas d'alerte entre %s et %s UTC", m[1], m[2]))
			continue
		}
		if d := decodeWLPhenomenon(line); d != "" {
			out = append(out, d)
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

func decodeWLHeader(line string) []string {
	m := rxWLHeader.FindStringSubmatch(line)
	if m == nil {
		return []string{line}
	}
	res := []string{
		"Aérodrome : " + m[1],
		"Numéro : " + m[2],
	}
	if m[3] != "" {
		// m[3..8] = DD HH MM / DD HH MM
		res = append(res, fmt.Sprintf("Validité : jour %s %s:%s → jour %s %s:%s UTC",
			m[3], m[4], m[5], m[6], m[7], m[8]))
	}
	return res
}

// decodeWLPhenomenon repère un phénomène connu dans la ligne et précise s'il
// est prévu (FCST) ou observé (OBS). Retourne "" si rien de reconnu.
func decodeWLPhenomenon(line string) string {
	upper := strings.ToUpper(line)
	tense := ""
	switch {
	case strings.Contains(upper, "FCST"):
		tense = " (prévu)"
	case strings.Contains(upper, "OBS"):
		tense = " (observé)"
	}

	// Cas spécial vent en surface (SFC WIND / SFC WSPD MAX >= NN KT)
	if m := rxSFCWind.FindStringSubmatch(upper); m != nil {
		op := m[1]
		val := m[2]
		opFR := ""
		switch op {
		case ">=":
			opFR = "≥ "
		case "<=":
			opFR = "≤ "
		case ">":
			opFR = "> "
		case "<":
			opFR = "< "
		}
		return fmt.Sprintf("Vent en surface : maximum %s%s kt%s", opFR, val, tense)
	}

	// Recherche multi-mot d'abord (LOW VISIBILITY, BLOWING SNOW, HVY RA, etc.)
	for k, v := range wlPhenomena {
		if !strings.Contains(k, " ") {
			continue
		}
		if strings.Contains(upper, k) {
			return capitalize(v) + tense
		}
	}
	// Puis tokens isolés
	tokens := strings.Fields(strings.ReplaceAll(strings.ReplaceAll(upper, ".", " "), ",", " "))
	for _, tok := range tokens {
		if v, ok := wlPhenomena[tok]; ok {
			return capitalize(v) + tense
		}
	}
	return ""
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
