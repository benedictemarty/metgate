package decoder

import (
	"encoding/xml"
	"fmt"
	"strings"
)

// Structures pour parser un IWXXM SIGMET / VolcanicAshSIGMET /
// TropicalCycloneSIGMET. La structure de base est identique : seuls la racine
// et quelques champs additionnels (volcan / cyclone) varient.

type iwxxmSIGMET struct {
	XMLName             xml.Name             `xml:""`
	ReportStatus        string               `xml:"reportStatus,attr"`
	IssueTime           string               `xml:"issueTime>TimeInstant>timePosition"`
	IssuingFIR          iwxxmFIR             `xml:"issuingAirTrafficServicesRegion>Airspace>timeSlice>AirspaceTimeSlice"`
	OriginatingMWO      iwxxmUnit            `xml:"originatingMeteorologicalWatchOffice>Unit>timeSlice>UnitTimeSlice"`
	IssuingATSU         iwxxmUnit            `xml:"issuingAirTrafficServicesUnit>Unit>timeSlice>UnitTimeSlice"`
	SequenceNumber      string               `xml:"sequenceNumber"`
	ValidPeriod         iwxxmTimePeriod      `xml:"validPeriod>TimePeriod"`
	Phenomenon          iwxxmCodedRef        `xml:"phenomenon"`
	Cancelled           iwxxmCancelled       `xml:"cancelledReportSequenceNumber"`
	Volcano             iwxxmVolcano         `xml:"eruptingVolcano>Volcano"`
	Cyclone             iwxxmCyclone         `xml:"tropicalCycloneName"`
	AnalysisCollections []iwxxmAnalysisBlock `xml:"analysisCollection>analysisAndForecastPositionAnalysis"`
}

type iwxxmFIR struct {
	Type       string `xml:"type"`
	Designator string `xml:"designator"`
	Name       string `xml:"name"`
}

type iwxxmUnit struct {
	Designator string `xml:"designator"`
	Name       string `xml:"name"`
}

type iwxxmCancelled struct {
	Sequence string `xml:",chardata"`
}

type iwxxmVolcano struct {
	Name string `xml:"name"`
}

type iwxxmCyclone struct {
	Name string `xml:",chardata"`
}

type iwxxmAnalysisBlock struct {
	Collection iwxxmEvolvingCollection `xml:"analysis>SIGMETEvolvingConditionCollection"`
}

type iwxxmEvolvingCollection struct {
	TimeIndicator string                  `xml:"timeIndicator,attr"`
	PhenomenonT   iwxxmPhenomTime         `xml:"phenomenonTime"`
	Members       []iwxxmEvolvingMember   `xml:"member>SIGMETEvolvingCondition"`
}

type iwxxmEvolvingMember struct {
	IntensityChange   string                  `xml:"intensityChange,attr"`
	Geometry          iwxxmAirspaceVolume     `xml:"geometry>AirspaceVolume"`
	DirectionOfMotion iwxxmNullableMeasure    `xml:"directionOfMotion"`
	SpeedOfMotion     iwxxmNullableMeasure    `xml:"speedOfMotion"`
}

type iwxxmAirspaceVolume struct {
	UpperLimit          iwxxmMeasure `xml:"upperLimit"`
	UpperLimitReference string       `xml:"upperLimitReference"`
	LowerLimit          iwxxmMeasure `xml:"lowerLimit"`
	LowerLimitReference string       `xml:"lowerLimitReference"`
}

type iwxxmNullableMeasure struct {
	UOM       string `xml:"uom,attr"`
	Nil       string `xml:"nil,attr"`
	NilReason string `xml:"nilReason,attr"`
	Value     string `xml:",chardata"`
}

// Phénomènes WMO codes 49-2 (SIGMET + VolcanicAsh + TropicalCyclone).
var sigmetPhenomena = map[string]string{
	"OBSC_TS":    "orages cachés (OBSC TS)",
	"EMBD_TS":    "orages noyés dans la couche (EMBD TS)",
	"FRQ_TS":     "orages fréquents (FRQ TS)",
	"SQL_TS":     "orages en ligne (SQL TS)",
	"OBSC_TSGR":  "orages cachés avec grêle",
	"EMBD_TSGR":  "orages noyés avec grêle",
	"FRQ_TSGR":   "orages fréquents avec grêle",
	"SQL_TSGR":   "orages en ligne avec grêle",
	"TC":         "cyclone tropical",
	"SEV_TURB":   "turbulence forte",
	"MOD_TURB":   "turbulence modérée",
	"SEV_ICE":    "givrage fort",
	"SEV_ICE_FZRA": "givrage fort en pluie verglaçante",
	"MOD_ICE":    "givrage modéré",
	"SEV_MTW":    "ondes orographiques sévères",
	"MOD_MTW":    "ondes orographiques modérées",
	"HVY_DS":     "forte tempête de poussière",
	"HVY_SS":     "forte tempête de sable",
	"RDOACT_CLD": "nuage radioactif",
	"VA_CLD":     "nuage de cendres volcaniques",
	"VA_ERUPTION": "éruption volcanique",
	"VA":         "cendres volcaniques",
}

// Phénomènes AIRMET (codes 49-2/AIRMETPhenomena).
var airmetPhenomena = map[string]string{
	"ISOL_TS":     "orages isolés (ISOL TS)",
	"OCNL_TS":     "orages occasionnels (OCNL TS)",
	"ISOL_TSGR":   "orages isolés avec grêle",
	"OCNL_TSGR":   "orages occasionnels avec grêle",
	"MOD_TURB":    "turbulence modérée",
	"MOD_ICE":     "givrage modéré",
	"MOD_MTW":     "ondes orographiques modérées",
	"LOC_HVY_RA":  "fortes pluies localisées",
	"LOC_HVY_SN":  "fortes chutes de neige localisées",
	"IFR":         "conditions IFR",
	"BKN_CLD":     "ciel fragmenté (BKN)",
	"OVC_CLD":     "ciel couvert (OVC)",
	"MTN_OBSC":    "montagnes masquées",
	"LOW_BR":      "brume basse",
	"SFC_WSPD":    "vent en surface fort",
	"SFC_VIS":     "visibilité en surface réduite",
}

var intensityChangeFR = map[string]string{
	"NO_CHANGE":    "intensité stable",
	"INTENSIFYING": "se renforçant",
	"INTENSIFY":    "se renforçant",
	"WEAKENING":    "faiblissant",
	"WEAKEN":       "faiblissant",
}

// DecodeIWXXMSIGMET décode un SIGMET / VolcanicAshSIGMET / TropicalCycloneSIGMET.
func DecodeIWXXMSIGMET(opmet string) string {
	body := stripCDATA(opmet)
	isSIGMET := strings.Contains(body, "<iwxxm:SIGMET ") ||
		strings.Contains(body, "<iwxxm:VolcanicAshSIGMET") ||
		strings.Contains(body, "<iwxxm:TropicalCycloneSIGMET")
	if !isSIGMET {
		return ""
	}
	var s iwxxmSIGMET
	if err := xml.Unmarshal([]byte(body), &s); err != nil {
		return ""
	}
	var lines []string
	header := "SIGMET"
	if strings.Contains(body, "VolcanicAshSIGMET") {
		header = "SIGMET Cendres volcaniques"
	} else if strings.Contains(body, "TropicalCycloneSIGMET") {
		header = "SIGMET Cyclone tropical"
	}
	lines = append(lines, header)

	if s.SequenceNumber != "" {
		lines = append(lines, "Numéro : "+s.SequenceNumber)
	}
	if s.IssuingFIR.Designator != "" || s.IssuingFIR.Name != "" {
		fir := strings.TrimSpace(s.IssuingFIR.Designator + " " + s.IssuingFIR.Name)
		lines = append(lines, "FIR : "+fir)
	}
	if s.OriginatingMWO.Designator != "" {
		lines = append(lines, "Émis par MWO : "+s.OriginatingMWO.Designator)
	}
	if s.IssueTime != "" {
		lines = append(lines, "Émission : "+formatISOFR(s.IssueTime))
	}
	if s.ValidPeriod.Begin != "" {
		lines = append(lines, "Validité : "+formatISOFR(s.ValidPeriod.Begin)+" → "+formatISOFR(s.ValidPeriod.End))
	}
	if cancel := strings.TrimSpace(s.Cancelled.Sequence); cancel != "" {
		lines = append(lines, "Annule SIGMET n°"+cancel)
		return strings.Join(lines, "\n")
	}
	if code := lastSegment(s.Phenomenon.Href); code != "" {
		fr := sigmetPhenomena[code]
		if fr == "" {
			fr = code
		}
		lines = append(lines, "Phénomène : "+fr)
	}
	if v := strings.TrimSpace(s.Volcano.Name); v != "" {
		lines = append(lines, "Volcan : "+v)
	}
	if c := strings.TrimSpace(s.Cyclone.Name); c != "" {
		lines = append(lines, "Cyclone : "+c)
	}
	if s.ReportStatus != "" && s.ReportStatus != "NORMAL" {
		lines = append(lines, "Statut : "+s.ReportStatus)
	}

	for i, ac := range s.AnalysisCollections {
		title := "Analyse"
		switch ac.Collection.TimeIndicator {
		case "FORECAST":
			title = "Prévision"
		case "OBSERVATION":
			title = "Observation"
		}
		if len(s.AnalysisCollections) > 1 {
			title = fmt.Sprintf("%s %d", title, i+1)
		}
		lines = append(lines, "")
		lines = append(lines, title+" :")
		if t := strings.TrimSpace(ac.Collection.PhenomenonT.TimePeriod.Begin); t != "" {
			lines = append(lines, "  Période : "+formatISOFR(t)+" → "+formatISOFR(ac.Collection.PhenomenonT.TimePeriod.End))
		} else if t := strings.TrimSpace(ac.Collection.PhenomenonT.TimeInstant.TimePosition); t != "" {
			lines = append(lines, "  Instant : "+formatISOFR(t))
		}
		for j, m := range ac.Collection.Members {
			if len(ac.Collection.Members) > 1 {
				lines = append(lines, fmt.Sprintf("  Zone %d :", j+1))
			}
			lines = append(lines, decodeSIGMETMember(m, "    ")...)
		}
	}
	return strings.Join(lines, "\n")
}

func decodeSIGMETMember(m iwxxmEvolvingMember, indent string) []string {
	var lines []string
	if up := formatLimit(m.Geometry.UpperLimit, m.Geometry.UpperLimitReference); up != "" {
		lines = append(lines, indent+"Plafond : "+up)
	}
	if low := formatLimit(m.Geometry.LowerLimit, m.Geometry.LowerLimitReference); low != "" {
		lines = append(lines, indent+"Plancher : "+low)
	}
	if dir, speed := formatMotion(m.DirectionOfMotion, m.SpeedOfMotion); dir != "" || speed != "" {
		switch {
		case dir != "" && speed != "":
			lines = append(lines, indent+"Mouvement : "+dir+" à "+speed)
		case dir != "":
			lines = append(lines, indent+"Direction : "+dir)
		case speed != "":
			lines = append(lines, indent+"Vitesse : "+speed)
		}
	} else if isStationary(m.SpeedOfMotion) {
		lines = append(lines, indent+"Mouvement : stationnaire")
	}
	if ic := intensityChangeFR[m.IntensityChange]; ic != "" {
		lines = append(lines, indent+"Évolution : "+ic)
	}
	return lines
}

func formatLimit(m iwxxmMeasure, ref string) string {
	v := strings.TrimSpace(m.Value)
	if v == "" {
		return ""
	}
	switch v {
	case "GND", "SFC":
		return "sol (GND/SFC)"
	case "TOP":
		return "sommet (TOP)"
	}
	v = stripTrailingZero(v)
	if m.UOM == "FL" {
		// Format aviation classique : FL090, FL350.
		return fmt.Sprintf("FL%03s", v)
	}
	uom := normUOM(m.UOM)
	out := v + " " + uom
	switch ref {
	case "STD":
		out += " (FL)"
	case "MSL":
		out += " (MSL)"
	case "SFC":
		out += " / sol"
	}
	return out
}

func formatMotion(dir, speed iwxxmNullableMeasure) (string, string) {
	d := ""
	if dir.Nil != "true" && dir.NilReason == "" {
		if v := stripTrailingZero(dir.Value); v != "" && v != "0" {
			d = v + "°"
		}
	}
	s := ""
	if speed.Nil != "true" && speed.NilReason == "" {
		if v := stripTrailingZero(speed.Value); v != "" && v != "0" {
			s = v + " " + normUOM(speed.UOM)
		}
	}
	return d, s
}

func isStationary(speed iwxxmNullableMeasure) bool {
	if speed.Nil == "true" || speed.NilReason != "" {
		return false
	}
	v := stripTrailingZero(speed.Value)
	return v == "0"
}
