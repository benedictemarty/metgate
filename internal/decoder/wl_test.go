package decoder

import (
	"strings"
	"testing"
)

func TestDecodeWL(t *testing.T) {
	cases := []struct {
		name     string
		tac      string
		mustHave []string
	}{
		{
			name: "vent fort prévu",
			tac: `LFOK AD WRNG 1 VALID 011600/020000
SFC WSPD MAX >= 30 KT FCST.
NO WARNING BETWEEN 20:30 AND 03:00
=`,
			mustHave: []string{
				"Aerodrome Warning",
				"Aérodrome : LFOK",
				"Numéro : 1",
				"Validité : jour 01 16:00 → jour 02 00:00 UTC",
				"Vent en surface : maximum ≥ 30 kt (prévu)",
				"Pas d'alerte entre 20:30 et 03:00 UTC",
			},
		},
		{
			name: "brouillard prévu",
			tac: `LFRG AD WRNG 2 VALID 012300/020700
FG FCST.
=`,
			mustHave: []string{
				"Aérodrome : LFRG",
				"Validité : jour 01 23:00 → jour 02 07:00 UTC",
				"Brouillard (prévu)",
			},
		},
		{
			name: "annulation",
			tac: `LFRG CNL AD WRNG 2 012300/020700
=`,
			mustHave: []string{
				"Annulation du warning n°2",
			},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := DecodeWL(c.tac)
			for _, want := range c.mustHave {
				if !strings.Contains(got, want) {
					t.Errorf("missing %q in:\n%s", want, got)
				}
			}
		})
	}
}
