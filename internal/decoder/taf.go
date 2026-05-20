package decoder

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	rxTAFValidity   = regexp.MustCompile(`^(\d{2})(\d{2})/(\d{2})(\d{2})$`)
	rxTAFFM         = regexp.MustCompile(`^FM(\d{2})(\d{2})(\d{2})$`)
	rxTAFProb       = regexp.MustCompile(`^PROB(\d{2})$`)
	rxTAFCancelled  = regexp.MustCompile(`^CNL$`)
	rxTAFAmendment  = regexp.MustCompile(`^AMD$`)
)

// DecodeTAF transforme un TAC TAF en texte FR multi-ligne. Découpe le message
// en segments (initial + FM/BECMG/TEMPO/PROB) et décode chaque segment via la
// même grammaire de tokens que METAR.
func DecodeTAF(tac string) string {
	tac = strings.TrimRight(strings.TrimSpace(tac), "=")
	tokens := strings.Fields(tac)
	if len(tokens) == 0 {
		return ""
	}
	var lines []string
	i := 0

	if i < len(tokens) && tokens[i] == "TAF" {
		lines = append(lines, "Prévision d'aérodrome (TAF)")
		i++
	}
	for i < len(tokens) && (tokens[i] == "AMD" || tokens[i] == "COR") {
		if tokens[i] == "AMD" {
			lines = append(lines, "Amendement (AMD)")
		} else {
			lines = append(lines, "Message corrigé (COR)")
		}
		i++
	}
	if i < len(tokens) && rxStation.MatchString(tokens[i]) {
		lines = append(lines, "Station : "+tokens[i])
		i++
	}
	if i < len(tokens) {
		if m := rxTime.FindStringSubmatch(tokens[i]); m != nil {
			lines = append(lines, fmt.Sprintf("Émission : jour %s à %s:%s UTC", m[1], m[2], m[3]))
			i++
		}
	}
	if i < len(tokens) {
		if m := rxTAFValidity.FindStringSubmatch(tokens[i]); m != nil {
			lines = append(lines, fmt.Sprintf("Validité : du jour %s %sh au jour %s %sh UTC", m[1], m[2], m[3], m[4]))
			i++
		}
	}
	if i < len(tokens) && tokens[i] == "CNL" {
		lines = append(lines, "TAF annulé (CNL)")
		return strings.Join(lines, "\n")
	}
	if i < len(tokens) && tokens[i] == "NIL" {
		lines = append(lines, "TAF non disponible (NIL)")
		return strings.Join(lines, "\n")
	}

	// Segmentation : on découpe à chaque BECMG/TEMPO/FM.../PROBnn.
	segments := splitTAFSegments(tokens[i:])
	for idx, seg := range segments {
		if idx == 0 {
			lines = append(lines, "")
			lines = append(lines, "Conditions de base :")
		}
		lines = append(lines, decodeTAFSegment(seg)...)
	}
	return strings.Join(lines, "\n")
}

type tafSegment struct {
	header string   // "" pour le segment initial, sinon BECMG/TEMPO/FMxx/PROBxx
	header2 string  // PROB peut être suivi de TEMPO/BECMG : conservé séparément
	validity string // pour BECMG/TEMPO si validité explicite
	tokens []string
}

func splitTAFSegments(tokens []string) []tafSegment {
	var out []tafSegment
	cur := tafSegment{}
	flush := func() {
		if cur.header != "" || len(cur.tokens) > 0 {
			out = append(out, cur)
		}
	}
	i := 0
	for i < len(tokens) {
		tok := tokens[i]
		switch {
		case tok == "BECMG" || tok == "TEMPO":
			flush()
			cur = tafSegment{header: tok}
			i++
			if i < len(tokens) {
				if rxTAFValidity.MatchString(tokens[i]) {
					cur.validity = tokens[i]
					i++
				}
			}
		case rxTAFFM.MatchString(tok):
			flush()
			cur = tafSegment{header: tok}
			i++
		case rxTAFProb.MatchString(tok):
			flush()
			cur = tafSegment{header: tok}
			i++
			if i < len(tokens) && (tokens[i] == "TEMPO" || tokens[i] == "BECMG") {
				cur.header2 = tokens[i]
				i++
			}
			if i < len(tokens) && rxTAFValidity.MatchString(tokens[i]) {
				cur.validity = tokens[i]
				i++
			}
		default:
			cur.tokens = append(cur.tokens, tok)
			i++
		}
	}
	flush()
	return out
}

func decodeTAFSegment(seg tafSegment) []string {
	var lines []string
	hdr := segmentHeaderFR(seg)
	if hdr != "" {
		lines = append(lines, "")
		lines = append(lines, hdr)
	}
	// On reconstruit un pseudo-METAR pour réutiliser le décodeur de tokens.
	// Certains tokens spécifiques TAF (ex: WS020/27045KT) ne sont pas couverts
	// et apparaîtront en "Inconnu : ..." — c'est volontaire pour rester compact.
	pseudo := strings.Join(seg.tokens, " ")
	if pseudo == "" {
		return lines
	}
	dec := DecodeMETAR(pseudo)
	for _, l := range strings.Split(dec, "\n") {
		if l != "" {
			lines = append(lines, "  "+l)
		}
	}
	return lines
}

func segmentHeaderFR(seg tafSegment) string {
	switch {
	case seg.header == "":
		return ""
	case seg.header == "BECMG":
		return "Évolution graduelle (BECMG) " + validityFR(seg.validity)
	case seg.header == "TEMPO":
		return "Variations temporaires (TEMPO) " + validityFR(seg.validity)
	case strings.HasPrefix(seg.header, "FM"):
		if m := rxTAFFM.FindStringSubmatch(seg.header); m != nil {
			return fmt.Sprintf("À partir du jour %s à %s:%s UTC :", m[1], m[2], m[3])
		}
	case strings.HasPrefix(seg.header, "PROB"):
		m := rxTAFProb.FindStringSubmatch(seg.header)
		pct := ""
		if m != nil {
			pct = m[1]
		}
		switch seg.header2 {
		case "TEMPO":
			return fmt.Sprintf("Probabilité %s%% de variations temporaires %s", pct, validityFR(seg.validity))
		case "BECMG":
			return fmt.Sprintf("Probabilité %s%% d'évolution graduelle %s", pct, validityFR(seg.validity))
		default:
			return fmt.Sprintf("Probabilité %s%% %s", pct, validityFR(seg.validity))
		}
	}
	return seg.header
}

func validityFR(v string) string {
	m := rxTAFValidity.FindStringSubmatch(v)
	if m == nil {
		return ""
	}
	return fmt.Sprintf("du jour %s %sh au jour %s %sh UTC", m[1], m[2], m[3], m[4])
}
