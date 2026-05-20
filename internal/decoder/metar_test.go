package decoder

import (
	"strings"
	"testing"
)

func TestDecodeMETAR(t *testing.T) {
	cases := []struct {
		name    string
		tac     string
		mustHave []string
	}{
		{
			name: "basique",
			tac:  "METAR LFPG 011200Z 27015KT 9999 SCT025 BKN040 15/08 Q1018 NOSIG",
			mustHave: []string{
				"Observation régulière",
				"Station : LFPG",
				"jour 01 à 12:00 UTC",
				"Vent : 270° à 15 kt",
				"Visibilité : ≥ 10 km",
				"3 à 4 octas",
				"5 à 7 octas",
				"Température : 15 °C",
				"point de rosée : 8 °C",
				"QNH : 1018 hPa",
				"NOSIG",
			},
		},
		{
			name: "rafales et variation",
			tac:  "METAR LFBO 011200Z 27015G25KT 240V300 9999 -SHRA SCT020CB BKN040 15/08 Q1018",
			mustHave: []string{
				"Vent : 270° à 15 kt, rafales 25 kt",
				"Direction variable entre 240° et 300°",
				"faible averses pluie",
				"cumulonimbus",
			},
		},
		{
			name: "CAVOK + temp négative",
			tac:  "METAR EFHK 011200Z 36005KT CAVOK M05/M08 Q1025",
			mustHave: []string{
				"CAVOK",
				"Température : -5 °C",
				"point de rosée : -8 °C",
			},
		},
		{
			name: "vent calme + brouillard",
			tac:  "METAR LFBO 011200Z 00000KT 0500 R32L/0500 FG VV001 02/02 Q1023",
			mustHave: []string{
				"Vent : calme",
				"Visibilité : 500 m",
				"RVR piste 32L : 500 m",
				"brouillard",
				"Visibilité verticale",
			},
		},
		{
			name: "SPECI variable",
			tac:  "SPECI LFPG 011245Z VRB02KT 9999 SCT020 12/10 Q1015 NOSIG",
			mustHave: []string{
				"Observation spéciale",
				"Vent : variable à 2 kt",
			},
		},
		{
			name: "format MetGate avec slashes et =",
			tac:  "METAR ENBV 011050Z 230/16KT CAVOK 8/2 Q1002=",
			mustHave: []string{
				"Station : ENBV",
				"Vent : 230° à 16 kt",
				"CAVOK",
				"Température : 8 °C",
				"point de rosée : 2 °C",
				"QNH : 1002 hPa",
			},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := DecodeMETAR(c.tac)
			for _, want := range c.mustHave {
				if !strings.Contains(got, want) {
					t.Errorf("missing %q in:\n%s", want, got)
				}
			}
		})
	}
}

func TestDecodeTAF(t *testing.T) {
	tac := "TAF LFPG 011100Z 0112/0212 27015KT 9999 SCT025 BECMG 0118/0120 30020G35KT TEMPO 0120/0124 4000 SHRA BKN015CB PROB30 TEMPO 0200/0204 1500 BR FM020600 32010KT CAVOK"
	got := DecodeTAF(tac)
	mustHave := []string{
		"Prévision d'aérodrome",
		"Station : LFPG",
		"Validité : du jour 01 12h au jour 02 12h UTC",
		"Conditions de base",
		"Vent : 270° à 15 kt",
		"Évolution graduelle (BECMG) du jour 01 18h au jour 01 20h UTC",
		"Variations temporaires (TEMPO) du jour 01 20h au jour 01 24h UTC",
		"averses pluie",
		"Probabilité 30% de variations temporaires du jour 02 00h au jour 02 04h UTC",
		"À partir du jour 02 à 06:00 UTC",
		"CAVOK",
	}
	for _, want := range mustHave {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
}
