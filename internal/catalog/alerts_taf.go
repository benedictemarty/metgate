package catalog

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ─── Parsing TAF TAC ─────────────────────────────────────────────────────────

var (
	// Période de validité DDhh/DDhh (ex: 2306/2412).
	rxTAFPeriod = regexp.MustCompile(`\b(\d{2})(\d{2})/(\d{2})(\d{2})\b`)

	// Groupes de changement TAF : TEMPO, BECMG, PROB30/40, FM suivi de DDHHmm.
	rxTAFChangeKw = regexp.MustCompile(`\b(TEMPO|BECMG|PROB(?:30|40)?|FM\d{6})\b`)

	// FM avec heure intégrée : FM230800 → day=23 hour=08.
	rxTAFFM = regexp.MustCompile(`\bFM(\d{2})(\d{2})\d{2}\b`)
)

// tafTACAlertLevel analyse un TAC TAF brut (FT_last / FC_last ou TAC dans WL_last)
// et retourne le niveau d'alerte maximal pour les phénomènes valides dans
// [now, now+lookAheadH heures].
func tafTACAlertLevel(tac string, now time.Time, lookAheadH int) (AlertLevel, string, string) {
	tac = strings.TrimRight(strings.Join(strings.Fields(
		strings.NewReplacer("\n", " ", "\r", " ").Replace(tac)), " "), "=")
	if tac == "" {
		return AlertNone, "", ""
	}

	window := now.Add(time.Duration(lookAheadH) * time.Hour)

	// ── 1. Groupes de changement (TEMPO / BECMG / PROB / FM) ────────────────
	type grp struct {
		keyword        string
		vStart, vEnd   time.Time
		text           string
	}
	var groups []grp

	kwLocs := rxTAFChangeKw.FindAllStringIndex(tac, -1)
	for i, loc := range kwLocs {
		kw := tac[loc[0]:loc[1]]
		// Texte du groupe : de la fin du mot-clé jusqu'au prochain mot-clé.
		end := len(tac)
		if i+1 < len(kwLocs) {
			end = kwLocs[i+1][0]
		}
		seg := tac[loc[1]:end]

		var vs, ve time.Time
		ok := false

		if m := rxTAFFM.FindStringSubmatch(kw); len(m) == 3 {
			// FM230800 → valide à partir de day 23 heure 08 jusqu'à la fin du TAF.
			dd, _ := strconv.Atoi(m[1])
			hh, _ := strconv.Atoi(m[2])
			vs = resolveTAFHour(dd, hh, 0, now)
			ve = vs.Add(48 * time.Hour) // borne haute large
			ok = true
		} else if m := rxTAFPeriod.FindStringSubmatch(seg); len(m) == 5 {
			// TEMPO/BECMG DDhh/DDhh.
			dd1, _ := strconv.Atoi(m[1])
			hh1, _ := strconv.Atoi(m[2])
			dd2, _ := strconv.Atoi(m[3])
			hh2, _ := strconv.Atoi(m[4])
			vs = resolveTAFHour(dd1, hh1, 0, now)
			ve = resolveTAFHour(dd2, hh2, 0, now)
			if ve.Before(vs) {
				ve = ve.AddDate(0, 0, 1)
			}
			ok = true
		}
		if ok {
			groups = append(groups, grp{kw, vs, ve, seg})
		}
	}

	// ── 2. Prévision de base (tout ce qui précède le premier mot-clé) ────────
	base := tac
	if len(kwLocs) > 0 {
		base = tac[:kwLocs[0][0]]
	}
	// Période de la prévision de base = 1er DDhh/DDhh du TAF.
	if m := rxTAFPeriod.FindStringSubmatch(base); len(m) == 5 {
		dd1, _ := strconv.Atoi(m[1])
		hh1, _ := strconv.Atoi(m[2])
		dd2, _ := strconv.Atoi(m[3])
		hh2, _ := strconv.Atoi(m[4])
		vs := resolveTAFHour(dd1, hh1, 0, now)
		ve := resolveTAFHour(dd2, hh2, 0, now)
		if ve.Before(vs) {
			ve = ve.AddDate(0, 0, 1)
		}
		groups = append(groups, grp{"BASE", vs, ve, base})
	}

	// ── 3. Sélectionner les groupes qui chevauchent [now, window] ────────────
	best := AlertNone
	bestPheno, bestText := "", ""

	for _, g := range groups {
		if g.vEnd.Before(now) || g.vStart.After(window) {
			continue
		}
		l, pheno, txt := levelFromTAC(g.text)
		if l > best {
			best = l
			bestPheno = pheno
			label := g.keyword
			if label == "BASE" {
				label = "TAF base"
			}
			bestText = label + ": " + txt
		}
	}

	return best, bestPheno, bestText
}

// resolveTAFHour convertit un jour/heure relatif TAF en time.Time absolu.
// Utilise le mois courant ; si le jour est dans le passé lointain, passe au mois suivant.
func resolveTAFHour(day, hour, minute int, ref time.Time) time.Time {
	y, m, refDay := ref.UTC().Date()
	t := time.Date(y, m, day, hour, minute, 0, 0, time.UTC)
	// Si le jour est très en arrière par rapport à aujourd'hui (plus de 15 jours),
	// on suppose que c'est le mois prochain (TAF émis en fin de mois).
	if day < refDay-15 {
		t = time.Date(y, m+1, day, hour, minute, 0, 0, time.UTC)
	}
	return t
}

// ─── Parsing IWXXM TAF ───────────────────────────────────────────────────────

var (
	// Blocs <iwxxm:changeForecast> ou <iwxxm:baseForecast> avec leur validTime.
	rxIWXXMForecastBlock = regexp.MustCompile(
		`(?s)<iwxxm:(?:base|change)Forecast[^>]*>(.*?)</iwxxm:(?:base|change)Forecast>`)

	// Période de validité IWXXM : beginPosition / endPosition.
	rxIWXXMBegin = regexp.MustCompile(`<gml:beginPosition[^>]*>([^<]+)</gml:beginPosition>`)
	rxIWXXMEnd   = regexp.MustCompile(`<gml:endPosition[^>]*>([^<]+)</gml:endPosition>`)

	// Météo présente IWXXM : /SynopticCondition/TS, /Phenomena/RA, etc.
	rxIWXXMWx = regexp.MustCompile(`/SynopticCondition/([A-Z]+)|/Phenomena/([A-Z]+)`)

	// Intensité (descriptor /) : Heavy/Moderate/Light.
	rxIWXXMIntensity = regexp.MustCompile(`/intensity\s*>\s*(Heavy|Moderate|Light)`)
)

// tafIWXXMAlertLevel analyse un payload IWXXM TAF (XML brut) et retourne le
// niveau d'alerte maximal pour les groupes valides dans [now, now+lookAheadH].
func tafIWXXMAlertLevel(opmet string, now time.Time, lookAheadH int) (AlertLevel, string, string) {
	if opmet == "" {
		return AlertNone, "", ""
	}
	window := now.Add(time.Duration(lookAheadH) * time.Hour)
	best := AlertNone
	bestPheno, bestText := "", ""

	for _, block := range rxIWXXMForecastBlock.FindAllString(opmet, -1) {
		// Lire la fenêtre de validité du bloc.
		var vs, ve time.Time
		if m := rxIWXXMBegin.FindStringSubmatch(block); len(m) == 2 {
			if t, err := time.Parse(time.RFC3339, strings.TrimSpace(m[1])); err == nil {
				vs = t
			}
		}
		if m := rxIWXXMEnd.FindStringSubmatch(block); len(m) == 2 {
			if t, err := time.Parse(time.RFC3339, strings.TrimSpace(m[1])); err == nil {
				ve = t
			}
		}
		// baseForecast n'a pas forcément de validTime → couvrir now si les deux sont zéro.
		if vs.IsZero() {
			vs = now.Add(-1 * time.Hour)
		}
		if ve.IsZero() {
			ve = now.Add(48 * time.Hour)
		}
		if ve.Before(now) || vs.After(window) {
			continue
		}

		// Extraire les phénomènes météo du bloc IWXXM.
		l, pheno, txt := iwxxmBlockLevel(block)
		if l > best {
			best = l
			bestPheno = pheno
			bestText = "TAF IWXXM: " + txt
		}
	}

	return best, bestPheno, bestText
}

// iwxxmBlockLevel détermine le niveau d'alerte d'un bloc IWXXM (forecast / change).
func iwxxmBlockLevel(block string) (AlertLevel, string, string) {
	// TS : orage détecté dans le bloc IWXXM.
	if strings.Contains(block, "/SynopticCondition/TS") ||
		strings.Contains(block, "Thunderstorm") ||
		strings.Contains(block, "TSRA") {
		return AlertRed, "TS", "Orage (IWXXM)"
	}
	if strings.Contains(block, "FreezingRain") || strings.Contains(block, "FreezingDrizzle") ||
		strings.Contains(block, "FreezingFog") || strings.Contains(block, "Hail") {
		return AlertOrange, "FZ/GR", "Verglaçant / grêle (IWXXM)"
	}

	// Phénomènes extraits par regex.
	for _, m := range rxIWXXMWx.FindAllStringSubmatch(block, -1) {
		code := m[1]
		if code == "" {
			code = m[2]
		}
		switch code {
		case "TS":
			return AlertRed, "TS", "Orage"
		case "FZRA", "FZDZ", "GR":
			return AlertOrange, code, "Verglaçant"
		case "SN", "RASN", "SNRA", "BLSN":
			return AlertYellow, "SN", "Neige"
		case "FG", "RA", "DZ", "BR":
			return AlertBlue, code, "Brouillard / précipitations"
		}
	}

	// Heavy precipitation (intensity) → jaune minimum.
	if rxIWXXMIntensity.MatchString(block) &&
		strings.Contains(rxIWXXMIntensity.FindString(block), "Heavy") {
		return AlertYellow, "+PRECIP", "Précipitations fortes"
	}

	// Visibilité basse (< 800 m) = brouillard probable.
	if strings.Contains(block, "<iwxxm:prevailingVisibility") {
		rx := regexp.MustCompile(`<iwxxm:prevailingVisibility[^>]*>([0-9.]+)`)
		if m := rx.FindStringSubmatch(block); len(m) == 2 {
			if v, err := strconv.ParseFloat(m[1], 64); err == nil && v < 800 {
				return AlertBlue, "FG", "Faible visibilité"
			}
		}
	}

	return AlertNone, "", ""
}
