package decoder

import (
	"encoding/xml"
	"fmt"
	"strings"
)

// Structures pour parser un IWXXM TAF (icao.int/iwxxm/2023-1).
// Les champs n'utilisent pas de namespace explicite : encoding/xml ignore le
// préfixe par défaut quand on match sur le local name.

type iwxxmTAF struct {
	XMLName        xml.Name           `xml:"TAF"`
	ReportStatus   string             `xml:"reportStatus,attr"`
	IssueTime      iwxxmTimeInstant   `xml:"issueTime>TimeInstant"`
	Aerodrome      iwxxmAerodrome     `xml:"aerodrome>AirportHeliport"`
	ValidPeriod    iwxxmTimePeriod    `xml:"validPeriod>TimePeriod"`
	BaseForecast   iwxxmForecast      `xml:"baseForecast>MeteorologicalAerodromeForecast"`
	ChangeForecast []iwxxmChangeBlock `xml:"changeForecast"`
}

type iwxxmTimeInstant struct {
	TimePosition string `xml:"timePosition"`
}

type iwxxmTimePeriod struct {
	Begin string `xml:"beginPosition"`
	End   string `xml:"endPosition"`
}

type iwxxmAerodrome struct {
	Designator string `xml:"timeSlice>AirportHeliportTimeSlice>designator"`
	ICAO       string `xml:"timeSlice>AirportHeliportTimeSlice>locationIndicatorICAO"`
}

type iwxxmChangeBlock struct {
	Forecast iwxxmForecast `xml:"MeteorologicalAerodromeForecast"`
}

type iwxxmForecast struct {
	ChangeIndicator      string                 `xml:"changeIndicator,attr"`
	CloudAndVisibilityOK string                 `xml:"cloudAndVisibilityOK,attr"`
	PhenomenonTime       iwxxmPhenomTime        `xml:"phenomenonTime"`
	PrevailingVisibility iwxxmMeasure           `xml:"prevailingVisibility"`
	SurfaceWind          iwxxmSurfaceWind       `xml:"surfaceWind>AerodromeSurfaceWindForecast"`
	Weather              []iwxxmCodedRef        `xml:"weather"`
	Cloud                iwxxmCloud             `xml:"cloud"`
	Temperature          []iwxxmTAFTemperature  `xml:"temperature>AerodromeAirTemperatureForecast"`
}

type iwxxmPhenomTime struct {
	TimePeriod   iwxxmTimePeriod  `xml:"TimePeriod"`
	TimeInstant  iwxxmTimeInstant `xml:"TimeInstant"`
}

type iwxxmMeasure struct {
	UOM   string `xml:"uom,attr"`
	Value string `xml:",chardata"`
}

type iwxxmSurfaceWind struct {
	VariableWindDirection string       `xml:"variableWindDirection,attr"`
	MeanWindDirection     iwxxmMeasure `xml:"meanWindDirection"`
	MeanWindSpeed         iwxxmMeasure `xml:"meanWindSpeed"`
	WindGustSpeed         iwxxmMeasure `xml:"windGustSpeed"`
}

type iwxxmCodedRef struct {
	Href      string `xml:"href,attr"`
	NilReason string `xml:"nilReason,attr"`
}

type iwxxmCloud struct {
	NilReason string             `xml:"nilReason,attr"`
	Layers    []iwxxmCloudLayer  `xml:"AerodromeCloudForecast>layer>CloudLayer"`
}

type iwxxmCloudLayer struct {
	Amount iwxxmCodedRef `xml:"amount"`
	Base   iwxxmMeasure  `xml:"base"`
}

type iwxxmTAFTemperature struct {
	MaxTemperature     iwxxmMeasure `xml:"maximumAirTemperature"`
	MaxTemperatureTime string       `xml:"maximumAirTemperatureTime>TimeInstant>timePosition"`
	MinTemperature     iwxxmMeasure `xml:"minimumAirTemperature"`
	MinTemperatureTime string       `xml:"minimumAirTemperatureTime>TimeInstant>timePosition"`
}

// DecodeIWXXMTAF parse un IWXXM TAF (XML) et produit un texte FR multi-ligne
// avec les conditions de base et chaque segment d'évolution (BECMG / TEMPO /
// FM / PROB). Retourne "" si le XML n'est pas un TAF parseable.
func DecodeIWXXMTAF(opmet string) string {
	body := stripCDATA(opmet)
	if !strings.Contains(body, ":TAF ") && !strings.Contains(body, "<TAF ") && !strings.Contains(body, "<iwxxm:TAF") {
		return ""
	}
	var t iwxxmTAF
	if err := xml.Unmarshal([]byte(body), &t); err != nil {
		return ""
	}
	var lines []string
	lines = append(lines, "Prévision d'aérodrome (TAF)")
	if icao := firstNonEmpty(t.Aerodrome.ICAO, t.Aerodrome.Designator); icao != "" {
		lines = append(lines, "Station : "+icao)
	}
	if it := strings.TrimSpace(t.IssueTime.TimePosition); it != "" {
		lines = append(lines, "Émission : "+formatISOFR(it))
	}
	if vb, ve := t.ValidPeriod.Begin, t.ValidPeriod.End; vb != "" && ve != "" {
		lines = append(lines, "Validité : "+formatISOFR(vb)+" → "+formatISOFR(ve))
	}
	if t.ReportStatus != "" && t.ReportStatus != "NORMAL" {
		lines = append(lines, "Statut : "+t.ReportStatus)
	}
	lines = append(lines, "")
	lines = append(lines, "Conditions de base :")
	lines = append(lines, decodeIWXXMForecast(t.BaseForecast)...)
	for _, c := range t.ChangeForecast {
		lines = append(lines, "")
		lines = append(lines, segmentIWXXMHeader(c.Forecast))
		lines = append(lines, decodeIWXXMForecast(c.Forecast)...)
	}
	return strings.Join(lines, "\n")
}

func stripCDATA(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "<![CDATA["); i >= 0 {
		s = s[i+len("<![CDATA["):]
		if j := strings.LastIndex(s, "]]>"); j >= 0 {
			s = s[:j]
		}
	}
	return s
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

var iwxxmChangeMap = map[string]string{
	"BECOMING":                              "Évolution graduelle (BECMG)",
	"TEMPORARY_FLUCTUATIONS":                "Variations temporaires (TEMPO)",
	"FROM":                                  "À partir de (FM)",
	"PROBABILITY_30":                        "Probabilité 30 %",
	"PROBABILITY_40":                        "Probabilité 40 %",
	"PROBABILITY_30_TEMPORARY_FLUCTUATIONS": "Probabilité 30 % de variations temporaires",
	"PROBABILITY_40_TEMPORARY_FLUCTUATIONS": "Probabilité 40 % de variations temporaires",
}

func segmentIWXXMHeader(f iwxxmForecast) string {
	label := iwxxmChangeMap[f.ChangeIndicator]
	if label == "" {
		if f.ChangeIndicator == "" {
			label = "Segment"
		} else {
			label = f.ChangeIndicator
		}
	}
	if f.PhenomenonTime.TimePeriod.Begin != "" {
		return fmt.Sprintf("%s — %s → %s :", label,
			formatISOFR(f.PhenomenonTime.TimePeriod.Begin),
			formatISOFR(f.PhenomenonTime.TimePeriod.End))
	}
	if f.PhenomenonTime.TimeInstant.TimePosition != "" {
		return fmt.Sprintf("%s — à partir de %s :", label,
			formatISOFR(f.PhenomenonTime.TimeInstant.TimePosition))
	}
	return label + " :"
}

func decodeIWXXMForecast(f iwxxmForecast) []string {
	var lines []string
	if f.CloudAndVisibilityOK == "true" {
		lines = append(lines, "  CAVOK")
	}
	w := f.SurfaceWind
	if v := stripTrailingZero(w.MeanWindSpeed.Value); v != "" {
		dir := stripTrailingZero(w.MeanWindDirection.Value)
		if w.VariableWindDirection == "true" || dir == "" {
			dir = "variable"
		} else {
			dir = dir + "°"
		}
		line := fmt.Sprintf("  Vent : %s à %s %s", dir, v, normUOM(w.MeanWindSpeed.UOM))
		if g := stripTrailingZero(w.WindGustSpeed.Value); g != "" {
			line += fmt.Sprintf(", rafales %s %s", g, normUOM(w.WindGustSpeed.UOM))
		}
		lines = append(lines, line)
	}
	if v := stripTrailingZero(f.PrevailingVisibility.Value); v != "" {
		uom := normUOM(f.PrevailingVisibility.UOM)
		lines = append(lines, "  Visibilité : "+v+" "+uom)
	}
	for _, ph := range f.Weather {
		if ph.NilReason != "" {
			continue
		}
		code := lastSegment(ph.Href)
		if code == "" {
			continue
		}
		if d := decodeWeather(code); d != "" {
			lines = append(lines, "  Phénomène : "+d)
		} else {
			lines = append(lines, "  Phénomène : "+code)
		}
	}
	if f.Cloud.NilReason != "" {
		lines = append(lines, "  Aucun nuage significatif")
	}
	for _, cl := range f.Cloud.Layers {
		amt := lastSegment(cl.Amount.Href)
		amountFR := map[string]string{
			"FEW": "1 à 2 octas",
			"SCT": "3 à 4 octas",
			"BKN": "5 à 7 octas",
			"OVC": "ciel couvert (8 octas)",
		}[amt]
		if amountFR == "" {
			amountFR = amt
		}
		base := stripTrailingZero(cl.Base.Value)
		uom := normUOM(cl.Base.UOM)
		if base != "" {
			lines = append(lines, fmt.Sprintf("  Nuages : %s à %s %s", amountFR, base, uom))
		} else {
			lines = append(lines, "  Nuages : "+amountFR)
		}
	}
	for _, tp := range f.Temperature {
		if v := stripTrailingZero(tp.MaxTemperature.Value); v != "" {
			lines = append(lines, fmt.Sprintf("  T°C max : %s à %s", v, formatISOFR(tp.MaxTemperatureTime)))
		}
		if v := stripTrailingZero(tp.MinTemperature.Value); v != "" {
			lines = append(lines, fmt.Sprintf("  T°C min : %s à %s", v, formatISOFR(tp.MinTemperatureTime)))
		}
	}
	return lines
}

func lastSegment(s string) string {
	if i := strings.LastIndex(s, "/"); i >= 0 {
		return s[i+1:]
	}
	return s
}

// stripTrailingZero retire les ".0" et zéros décimaux superflus pour
// l'affichage : "230.0" → "230", "10.5" → "10.5", "  " → "".
func stripTrailingZero(s string) string {
	s = strings.TrimSpace(s)
	if !strings.Contains(s, ".") {
		return s
	}
	s = strings.TrimRight(s, "0")
	s = strings.TrimRight(s, ".")
	return s
}

func normUOM(s string) string {
	switch s {
	case "[kn_i]", "kn", "kt", "KT":
		return "kt"
	case "m":
		return "m"
	case "km":
		return "km"
	case "deg":
		return "°"
	case "[ft_i]", "ft":
		return "ft"
	case "Cel", "degC":
		return "°C"
	case "Pa":
		return "Pa"
	case "hPa":
		return "hPa"
	}
	return s
}

func formatISOFR(s string) string {
	s = strings.TrimSpace(s)
	if len(s) < 16 {
		return s
	}
	return s[:10] + " " + s[11:16] + " UTC"
}
