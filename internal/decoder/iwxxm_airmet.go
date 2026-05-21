package decoder

import (
	"encoding/xml"
	"fmt"
	"strings"
)

// AIRMET partage l'essentiel de la structure du SIGMET, sauf que
// les EvolvingCondition s'appellent AIRMETEvolvingCondition (et leur
// collection AIRMETEvolvingConditionCollection).

type iwxxmAIRMET struct {
	XMLName             xml.Name              `xml:""`
	ReportStatus        string                `xml:"reportStatus,attr"`
	IssueTime           string                `xml:"issueTime>TimeInstant>timePosition"`
	IssuingFIR          iwxxmFIR              `xml:"issuingAirTrafficServicesRegion>Airspace>timeSlice>AirspaceTimeSlice"`
	OriginatingMWO      iwxxmUnit             `xml:"originatingMeteorologicalWatchOffice>Unit>timeSlice>UnitTimeSlice"`
	IssuingATSU         iwxxmUnit             `xml:"issuingAirTrafficServicesUnit>Unit>timeSlice>UnitTimeSlice"`
	SequenceNumber      string                `xml:"sequenceNumber"`
	ValidPeriod         iwxxmTimePeriod       `xml:"validPeriod>TimePeriod"`
	Phenomenon          iwxxmCodedRef         `xml:"phenomenon"`
	Cancelled           iwxxmCancelled        `xml:"cancelledReportSequenceNumber"`
	AnalysisCollections []iwxxmAirmetAnalysis `xml:"analysisCollection>analysisAndForecastPositionAnalysis"`
}

type iwxxmAirmetAnalysis struct {
	Collection iwxxmAirmetCollection `xml:"analysis>AIRMETEvolvingConditionCollection"`
}

type iwxxmAirmetCollection struct {
	TimeIndicator string                `xml:"timeIndicator,attr"`
	PhenomenonT   iwxxmPhenomTime       `xml:"phenomenonTime"`
	Members       []iwxxmEvolvingMember `xml:"member>AIRMETEvolvingCondition"`
}

// DecodeIWXXMAIRMET décode un AIRMET (IWXXM 2025-2 ou compatible).
func DecodeIWXXMAIRMET(opmet string) string {
	body := stripCDATA(opmet)
	if !strings.Contains(body, "<iwxxm:AIRMET") {
		return ""
	}
	var a iwxxmAIRMET
	if err := xml.Unmarshal([]byte(body), &a); err != nil {
		return ""
	}
	var lines []string
	lines = append(lines, "AIRMET")
	if a.SequenceNumber != "" {
		lines = append(lines, "Numéro : "+a.SequenceNumber)
	}
	if a.IssuingFIR.Designator != "" || a.IssuingFIR.Name != "" {
		fir := strings.TrimSpace(a.IssuingFIR.Designator + " " + a.IssuingFIR.Name)
		lines = append(lines, "FIR : "+fir)
	}
	if a.OriginatingMWO.Designator != "" {
		lines = append(lines, "Émis par MWO : "+a.OriginatingMWO.Designator)
	}
	if a.IssueTime != "" {
		lines = append(lines, "Émission : "+formatISOFR(a.IssueTime))
	}
	if a.ValidPeriod.Begin != "" {
		lines = append(lines, "Validité : "+formatISOFR(a.ValidPeriod.Begin)+" → "+formatISOFR(a.ValidPeriod.End))
	}
	if cancel := strings.TrimSpace(a.Cancelled.Sequence); cancel != "" {
		lines = append(lines, "Annule AIRMET n°"+cancel)
		return strings.Join(lines, "\n")
	}
	if code := lastSegment(a.Phenomenon.Href); code != "" {
		fr := airmetPhenomena[code]
		if fr == "" {
			fr = sigmetPhenomena[code] // fallback (certains codes partagés)
		}
		if fr == "" {
			fr = code
		}
		lines = append(lines, "Phénomène : "+fr)
	}
	if a.ReportStatus != "" && a.ReportStatus != "NORMAL" {
		lines = append(lines, "Statut : "+a.ReportStatus)
	}
	for i, ac := range a.AnalysisCollections {
		title := "Analyse"
		switch ac.Collection.TimeIndicator {
		case "FORECAST":
			title = "Prévision"
		case "OBSERVATION":
			title = "Observation"
		}
		if len(a.AnalysisCollections) > 1 {
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
