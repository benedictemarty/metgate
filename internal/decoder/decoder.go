// Package decoder traduit en français les messages OACI codés (METAR, SPECI,
// TAF, et plus tard SIGMET/AIRMET/MAA) à partir de leur TAC (Traditional
// Alphanumeric Code).
package decoder

import "strings"

// Decode route le TAC vers le décodeur adapté au type WFS (ex: "METAR_last",
// "TAF_last"). Retourne une chaîne multi-ligne FR, ou "" si non décodable.
func Decode(typeName, tac string) string {
	tac = strings.TrimSpace(tac)
	if tac == "" {
		return ""
	}
	base := strings.TrimSuffix(typeName, "_last")
	switch {
	case base == "METAR" || base == "SPECI":
		return DecodeMETAR(tac)
	case base == "TAF":
		return DecodeTAF(tac)
	case strings.EqualFold(base, "WL"):
		return DecodeWL(tac)
	}
	return ""
}
