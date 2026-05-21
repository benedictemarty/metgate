// Package notam interroge l'API FAA NOTAM (api.faa.gov/notamapi/v1/notams).
// Clé API gratuite sur https://api.faa.gov/signup — deux champs : client_id
// et client_secret transmis en headers HTTP.
package notam

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

const baseURL = "https://api.faa.gov/notamapi/v1/notams"

// Client est un client HTTP minimal pour l'API FAA NOTAM.
type Client struct {
	clientID     string
	clientSecret string
	http         *http.Client
}

// New construit un Client FAA NOTAM.
func New(clientID, clientSecret string) *Client {
	return &Client{
		clientID:     clientID,
		clientSecret: clientSecret,
		http:         &http.Client{Timeout: 20 * time.Second},
	}
}

// Authenticated retourne true si des credentials sont configurés.
func (c *Client) Authenticated() bool {
	return c.clientID != "" && c.clientSecret != ""
}

// NOTAM est une notice NOTAM extraite de la réponse FAA.
type NOTAM struct {
	ID           string    `json:"id"`
	Number       string    `json:"number"`
	Type         string    `json:"type"`   // N=new R=replace C=cancel
	Issued       time.Time `json:"issued"`
	Location     string    `json:"location"` // ICAO 4 lettres
	EffectStart  time.Time `json:"effectiveStart"`
	EffectEnd    time.Time `json:"effectiveEnd"`
	Text         string    `json:"text"`         // TAC NOTAM brut
	PlainLang    string    `json:"plainLang"`    // traduction anglais FAA
	ICAOMessage  string    `json:"icaoMessage"`  // format ICAO Q-line
	Classification string  `json:"classification"` // INTL / DOM / FDC / POINTER
	MaxFL        string    `json:"maximumFL"`
	MinFL        string    `json:"minimumFL"`
	Coordinates  string    `json:"coordinates"` // DMS si ponctuel
	Radius       string    `json:"radius"`      // NM si circulaire
	Lon          float64   `json:"lon"`
	Lat          float64   `json:"lat"`
}

// Query encapsule les paramètres d'une requête NOTAM.
type Query struct {
	ICAOLocation string    // code ICAO aérodrome (ex: LFPG)
	Lon, Lat     float64   // centre géographique (si ICAOLocation vide)
	RadiusNM     float64   // rayon en NM autour de Lon/Lat
	EffectStart  time.Time // fenêtre de validité début
	EffectEnd    time.Time // fenêtre de validité fin
	PageSize     int       // max 1000 (défaut 100)
}

// Search interroge l'API FAA et retourne les NOTAM correspondants.
func (c *Client) Search(ctx context.Context, q Query) ([]NOTAM, error) {
	if !c.Authenticated() {
		return nil, fmt.Errorf("FAA_NOTAM_CLIENT_ID / CLIENT_SECRET non configurés")
	}

	params := url.Values{}
	if q.ICAOLocation != "" {
		params.Set("icaoLocation", q.ICAOLocation)
	} else if q.Lat != 0 || q.Lon != 0 {
		params.Set("locationLongitude", strconv.FormatFloat(q.Lon, 'f', 6, 64))
		params.Set("locationLatitude", strconv.FormatFloat(q.Lat, 'f', 6, 64))
		if q.RadiusNM > 0 {
			params.Set("locationRadius", strconv.FormatFloat(q.RadiusNM, 'f', 1, 64))
		}
	}
	if !q.EffectStart.IsZero() {
		params.Set("effectiveStartDate", q.EffectStart.UTC().Format("2006-01-02T15:04:05.000Z"))
	}
	if !q.EffectEnd.IsZero() {
		params.Set("effectiveEndDate", q.EffectEnd.UTC().Format("2006-01-02T15:04:05.000Z"))
	}
	pageSize := q.PageSize
	if pageSize <= 0 {
		pageSize = 100
	}
	params.Set("pageSize", strconv.Itoa(pageSize))
	params.Set("pageNum", "1")

	req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("client_id", c.clientID)
	req.Header.Set("client_secret", c.clientSecret)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("faa notam: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return nil, fmt.Errorf("faa notam: credentials invalides (HTTP %d)", resp.StatusCode)
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("faa notam: HTTP %d", resp.StatusCode)
	}

	var raw struct {
		Items []struct {
			Type     string `json:"type"`
			Geometry *struct {
				Type        string    `json:"type"`
				Coordinates []float64 `json:"coordinates"`
			} `json:"geometry"`
			Properties struct {
				CoreNOTAMData struct {
					Notam struct {
						ID             string `json:"id"`
						Number         string `json:"number"`
						Type           string `json:"type"`
						Issued         string `json:"issued"`
						Location       string `json:"location"`
						EffectiveStart string `json:"effectiveStart"`
						EffectiveEnd   string `json:"effectiveEnd"`
						Text           string `json:"text"`
						MaximumFL      string `json:"maximumFL"`
						MinimumFL      string `json:"minimumFL"`
						Coordinates    string `json:"coordinates"`
						Radius         string `json:"radius"`
						Classification string `json:"classification"`
					} `json:"notam"`
					NotamTranslation []struct {
						Type           string `json:"type"`
						SimpleText     string `json:"simpleText"`
						FormattedText  string `json:"formattedText"`
					} `json:"notamTranslation"`
				} `json:"coreNOTAMData"`
				ICAOMessage  string `json:"icaoMessage"`
				PlainLanguage string `json:"plainLanguage"`
			} `json:"properties"`
		} `json:"items"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("faa notam decode: %w", err)
	}

	parseTime := func(s string) time.Time {
		if s == "" {
			return time.Time{}
		}
		for _, layout := range []string{
			"2006-01-02T15:04:05.000Z",
			"2006-01-02T15:04:05Z",
			time.RFC3339,
		} {
			if t, err := time.Parse(layout, s); err == nil {
				return t
			}
		}
		return time.Time{}
	}

	out := make([]NOTAM, 0, len(raw.Items))
	for _, item := range raw.Items {
		n := item.Properties.CoreNOTAMData.Notam

		// Traduction plain language (priorité FAA Plain Language, sinon ICAO)
		plainLang := item.Properties.PlainLanguage
		for _, tr := range item.Properties.CoreNOTAMData.NotamTranslation {
			if tr.Type == "PLAIN_LANGUAGE" && tr.SimpleText != "" {
				plainLang = tr.SimpleText
				break
			}
		}

		notam := NOTAM{
			ID:             n.ID,
			Number:         n.Number,
			Type:           n.Type,
			Issued:         parseTime(n.Issued),
			Location:       n.Location,
			EffectStart:    parseTime(n.EffectiveStart),
			EffectEnd:      parseTime(n.EffectiveEnd),
			Text:           n.Text,
			PlainLang:      plainLang,
			ICAOMessage:    item.Properties.ICAOMessage,
			Classification: n.Classification,
			MaxFL:          n.MaximumFL,
			MinFL:          n.MinimumFL,
			Coordinates:    n.Coordinates,
			Radius:         n.Radius,
		}
		if item.Geometry != nil && len(item.Geometry.Coordinates) >= 2 {
			notam.Lon = item.Geometry.Coordinates[0]
			notam.Lat = item.Geometry.Coordinates[1]
		}
		out = append(out, notam)
	}
	return out, nil
}
