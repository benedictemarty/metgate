package decoder

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var (
	rxStation = regexp.MustCompile(`^[A-Z]{4}$`)
	rxTime    = regexp.MustCompile(`^(\d{2})(\d{2})(\d{2})Z$`)
	rxWind    = regexp.MustCompile(`^(VRB|\d{3})/?(\d{1,3})(?:G(\d{1,3}))?(KT|MPS|KMH)$`)
	rxWindVar = regexp.MustCompile(`^(\d{3})V(\d{3})$`)
	rxVisM    = regexp.MustCompile(`^(\d{4})(NDV)?$`)
	rxVisSM   = regexp.MustCompile(`^(M)?(\d+)(?:/(\d+))?SM$`)
	rxRVR     = regexp.MustCompile(`^R(\d{2}[LCR]?)/(M|P)?(\d{4})(?:V(M|P)?(\d{4}))?(FT)?(/[NDU])?$`)
	rxSky     = regexp.MustCompile(`^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU|///)?$`)
	rxVV      = regexp.MustCompile(`^VV(\d{3})$`)
	rxTemp    = regexp.MustCompile(`^(M?\d{1,2})/(M?\d{1,2})$`)
	rxQNH     = regexp.MustCompile(`^(Q|A)(\d{4})$`)
	rxMissing = regexp.MustCompile(`^/+$`)             // // //// //////
	rxRVRClrd = regexp.MustCompile(`^R(\d{2}[LCR]?)/CLRD(\d{2})$`) // R26/CLRD70
)

// DecodeMETAR transforme un TAC METAR/SPECI en texte FR multi-ligne.
// Ne tente pas une analyse exhaustive : le TAC reste affiché en parallèle.
func DecodeMETAR(tac string) string {
	tac = strings.TrimRight(strings.TrimSpace(tac), "=")
	tokens := strings.Fields(tac)
	if len(tokens) == 0 {
		return ""
	}
	var lines []string
	i := 0

	if t := tokens[i]; t == "METAR" || t == "SPECI" {
		if t == "SPECI" {
			lines = append(lines, "Observation spéciale (SPECI)")
		} else {
			lines = append(lines, "Observation régulière (METAR)")
		}
		i++
	}
	for i < len(tokens) && (tokens[i] == "COR" || tokens[i] == "AUTO") {
		if tokens[i] == "COR" {
			lines = append(lines, "Message corrigé")
		} else {
			lines = append(lines, "Station automatique")
		}
		i++
	}

	if i < len(tokens) && rxStation.MatchString(tokens[i]) {
		lines = append(lines, "Station : "+tokens[i])
		i++
	}
	if i < len(tokens) {
		if m := rxTime.FindStringSubmatch(tokens[i]); m != nil {
			lines = append(lines, fmt.Sprintf("Heure d'observation : jour %s à %s:%s UTC", m[1], m[2], m[3]))
			i++
		}
	}

	for i < len(tokens) {
		tok := tokens[i]
		switch tok {
		case "CAVOK":
			lines = append(lines, "CAVOK : visibilité ≥ 10 km, pas de nuages significatifs, pas de phénomène")
			i++
			continue
		case "NOSIG":
			lines = append(lines, "Tendance : pas de changement significatif prévu (NOSIG)")
			i++
			continue
		case "BECMG":
			lines = append(lines, "Tendance : évolution graduelle (BECMG) — "+joinRest(tokens, i+1))
			return strings.Join(lines, "\n")
		case "TEMPO":
			lines = append(lines, "Tendance : variations temporaires (TEMPO) — "+joinRest(tokens, i+1))
			return strings.Join(lines, "\n")
		case "RMK":
			lines = append(lines, "Remarques : "+joinRest(tokens, i+1))
			return strings.Join(lines, "\n")
		case "NSC":
			lines = append(lines, "Aucun nuage significatif (NSC)")
			i++
			continue
		case "NCD":
			lines = append(lines, "Aucun nuage détecté (NCD, station auto)")
			i++
			continue
		case "SKC", "CLR":
			lines = append(lines, "Ciel clair")
			i++
			continue
		case "AUTO":
			lines = append(lines, "Station automatique (AUTO)")
			i++
			continue
		case "COR":
			lines = append(lines, "Message corrigé (COR)")
			i++
			continue
		case "SPECI":
			i++ // mot-clé SPECI en tête du TAC — déjà traité dans le header
			continue
		}

		// Données manquantes : //, ////, etc. → ignorer silencieusement
		if rxMissing.MatchString(tok) {
			i++
			continue
		}

		// Heure en double (TAC reconstruit depuis IWXXM) → ignorer
		if rxTime.MatchString(tok) {
			i++
			continue
		}

		// RE<phénomène> : météo récente (RERA, RETS, RESHGR, RE// …)
		if strings.HasPrefix(tok, "RE") && len(tok) > 2 {
			suffix := tok[2:]
			if rxMissing.MatchString(suffix) || suffix == "" {
				i++
				continue
			}
			if w := decodeWeather(suffix); w != "" {
				lines = append(lines, "Phénomène récent : "+w)
			} else {
				lines = append(lines, "Phénomène récent : "+suffix)
			}
			i++
			continue
		}

		if m := rxWind.FindStringSubmatch(tok); m != nil {
			lines = append(lines, decodeWind(m))
			i++
			if i < len(tokens) {
				if v := rxWindVar.FindStringSubmatch(tokens[i]); v != nil {
					lines = append(lines, fmt.Sprintf("Direction variable entre %s° et %s°", v[1], v[2]))
					i++
				}
			}
			continue
		}
		if m := rxVisM.FindStringSubmatch(tok); m != nil {
			lines = append(lines, decodeVisMeters(m))
			i++
			continue
		}
		if m := rxVisSM.FindStringSubmatch(tok); m != nil {
			lines = append(lines, decodeVisSM(m))
			i++
			continue
		}
		if m := rxRVRClrd.FindStringSubmatch(tok); m != nil {
			lines = append(lines, fmt.Sprintf("RVR piste %s : piste dégagée (CLRD), coeff. %s", m[1], m[2]))
			i++
			continue
		}
		if m := rxRVR.FindStringSubmatch(tok); m != nil {
			lines = append(lines, decodeRVR(m))
			i++
			continue
		}
		if m := rxSky.FindStringSubmatch(tok); m != nil {
			lines = append(lines, decodeSky(m))
			i++
			continue
		}
		if m := rxVV.FindStringSubmatch(tok); m != nil {
			vv, _ := strconv.Atoi(m[1])
			lines = append(lines, fmt.Sprintf("Visibilité verticale : %d ft (%.0f m)", vv*100, float64(vv)*30.48))
			i++
			continue
		}
		if m := rxTemp.FindStringSubmatch(tok); m != nil {
			lines = append(lines, fmt.Sprintf("Température : %s °C, point de rosée : %s °C",
				normTemp(m[1]), normTemp(m[2])))
			i++
			continue
		}
		if m := rxQNH.FindStringSubmatch(tok); m != nil {
			val, _ := strconv.Atoi(m[2])
			if m[1] == "Q" {
				lines = append(lines, fmt.Sprintf("QNH : %d hPa", val))
			} else {
				lines = append(lines, fmt.Sprintf("Calage altimétrique : %.2f inHg", float64(val)/100))
			}
			i++
			continue
		}
		if w := decodeWeather(tok); w != "" {
			lines = append(lines, "Phénomène : "+w)
			i++
			continue
		}
		// Token inconnu : on le garde tel quel (souvent NDV, RE..., WS..., etc.)
		lines = append(lines, "Inconnu : "+tok)
		i++
	}
	return strings.Join(lines, "\n")
}

func joinRest(tokens []string, from int) string {
	if from >= len(tokens) {
		return ""
	}
	return strings.Join(tokens[from:], " ")
}

func decodeWind(m []string) string {
	dir := m[1]
	speed, _ := strconv.Atoi(m[2])
	gust := m[3]
	unit := m[4]
	unitFR := map[string]string{"KT": "kt", "MPS": "m/s", "KMH": "km/h"}[unit]
	var dirFR string
	if dir == "VRB" {
		dirFR = "variable"
	} else {
		dirFR = dir + "°"
	}
	if gust == "" {
		if speed == 0 {
			return "Vent : calme"
		}
		return fmt.Sprintf("Vent : %s à %d %s", dirFR, speed, unitFR)
	}
	g, _ := strconv.Atoi(gust)
	return fmt.Sprintf("Vent : %s à %d %s, rafales %d %s", dirFR, speed, unitFR, g, unitFR)
}

func decodeVisMeters(m []string) string {
	v, _ := strconv.Atoi(m[1])
	if v == 9999 {
		return "Visibilité : ≥ 10 km"
	}
	if v >= 1000 {
		return fmt.Sprintf("Visibilité : %.1f km", float64(v)/1000)
	}
	return fmt.Sprintf("Visibilité : %d m", v)
}

func decodeVisSM(m []string) string {
	prefix := ""
	if m[1] == "M" {
		prefix = "moins de "
	}
	if m[3] != "" {
		return fmt.Sprintf("Visibilité : %s%s/%s SM (%s mile US)", prefix, m[2], m[3], m[2]+"/"+m[3])
	}
	return fmt.Sprintf("Visibilité : %s%s SM", prefix, m[2])
}

func decodeRVR(m []string) string {
	rwy := m[1]
	prefix := ""
	switch m[2] {
	case "M":
		prefix = "moins de "
	case "P":
		prefix = "plus de "
	}
	val, _ := strconv.Atoi(m[3])
	if m[5] != "" {
		varPrefix := ""
		switch m[4] {
		case "M":
			varPrefix = "moins de "
		case "P":
			varPrefix = "plus de "
		}
		varVal, _ := strconv.Atoi(m[5])
		return fmt.Sprintf("RVR piste %s : %s%d à %s%d m (variable)", rwy, prefix, val, varPrefix, varVal)
	}
	return fmt.Sprintf("RVR piste %s : %s%d m", rwy, prefix, val)
}

func decodeSky(m []string) string {
	cover := map[string]string{
		"FEW": "1 à 2 octas",
		"SCT": "3 à 4 octas",
		"BKN": "5 à 7 octas",
		"OVC": "ciel couvert (8 octas)",
	}[m[1]]
	height, _ := strconv.Atoi(m[2])
	heightFt := height * 100
	heightM := float64(heightFt) * 0.3048
	suffix := ""
	switch m[3] {
	case "CB":
		suffix = " — cumulonimbus (CB)"
	case "TCU":
		suffix = " — cumulus bourgeonnants (TCU)"
	case "///":
		// type non observé (station auto) — on l'ignore
	}
	return fmt.Sprintf("Nuages : %s à %d ft (~%.0f m)%s", cover, heightFt, heightM, suffix)
}

var (
	weatherIntensity = map[string]string{"-": "faible ", "+": "fort ", "VC": "à proximité "}
	weatherDesc      = map[string]string{
		"MI": "mince ", "BC": "bancs ", "PR": "partiel ", "DR": "chasse basse ",
		"BL": "chasse haute ", "SH": "averses ", "TS": "orage ", "FZ": "se congelant ",
	}
	weatherPhen = map[string]string{
		"DZ": "bruine", "RA": "pluie", "SN": "neige", "SG": "neige en grains",
		"IC": "cristaux de glace", "PL": "granules de glace", "GR": "grêle",
		"GS": "petite grêle / grésil", "UP": "précipitation indéterminée",
		"BR": "brume", "FG": "brouillard", "FU": "fumée", "VA": "cendres volcaniques",
		"DU": "poussière généralisée", "SA": "sable", "HZ": "brume sèche",
		"PO": "tourbillons de poussière/sable", "SQ": "grain", "FC": "trombe",
		"SS": "tempête de sable", "DS": "tempête de poussière",
	}
)

// decodeWeather reconnaît les groupes "phénomènes significatifs" comme -RA,
// +SHRA, VCTS, BCFG, FZRA, etc. Renvoie "" si le token n'est pas un groupe
// météo valide.
func decodeWeather(tok string) string {
	rest := tok
	var parts []string
	if strings.HasPrefix(rest, "-") || strings.HasPrefix(rest, "+") {
		parts = append(parts, weatherIntensity[string(rest[0])])
		rest = rest[1:]
	} else if strings.HasPrefix(rest, "VC") {
		parts = append(parts, weatherIntensity["VC"])
		rest = rest[2:]
	}
	for len(rest) >= 2 {
		head := rest[:2]
		if d, ok := weatherDesc[head]; ok {
			parts = append(parts, d)
			rest = rest[2:]
			continue
		}
		if p, ok := weatherPhen[head]; ok {
			parts = append(parts, p)
			rest = rest[2:]
			continue
		}
		return ""
	}
	if rest != "" || len(parts) == 0 {
		return ""
	}
	return strings.TrimSpace(strings.Join(parts, ""))
}

// normTemp convertit "M05" → "-5", "12" → "12".
func normTemp(s string) string {
	if strings.HasPrefix(s, "M") {
		return "-" + strings.TrimLeft(s[1:], "0")
	}
	return strings.TrimLeft(s, "0")
}

// DecodeCloudGroups décode un ou plusieurs groupes ciel séparés par des espaces
// (ex: "FEW086 OVC110", "SCT030CB BKN033", "SKC") en texte FR.
// Retourne "" si aucun groupe reconnu.
func DecodeCloudGroups(s string) string {
	var parts []string
	for _, tok := range strings.Fields(s) {
		switch tok {
		case "SKC", "CLR":
			parts = append(parts, "Ciel clair")
			continue
		case "NSC":
			parts = append(parts, "Aucun nuage significatif (NSC)")
			continue
		case "NCD":
			parts = append(parts, "Aucun nuage détecté (NCD)")
			continue
		}
		if m := rxSky.FindStringSubmatch(tok); m != nil {
			parts = append(parts, decodeSky(m))
		}
	}
	return strings.Join(parts, " | ")
}
