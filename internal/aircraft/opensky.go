// Package aircraft est un client minimal pour OpenSky Network
// (opensky-network.org). Permet d'interroger les états ADS-B en live.
package aircraft

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// State est un état ADS-B aplati pour un avion. Convention :
//   - lon/lat en degrés (EPSG:4326)
//   - baro_alt en mètres (BARO altitude pression standard 1013.25)
//   - velocity en m/s ground speed
//   - true_track en degrés (0=N, 90=E)
//   - vertical_rate en m/s (positif = montée)
type State struct {
	ICAO24         string  `json:"icao24"`
	Callsign       string  `json:"callsign"`
	OriginCountry  string  `json:"origin_country"`
	TimePosition   int64   `json:"time_position"` // Unix s
	LastContact    int64   `json:"last_contact"`
	Lon            float64 `json:"lon"`
	Lat            float64 `json:"lat"`
	BaroAltM       float64 `json:"baro_alt_m"`
	OnGround       bool    `json:"on_ground"`
	VelocityMs     float64 `json:"velocity_ms"`
	TrueTrack      float64 `json:"true_track_deg"`
	VerticalRateMs float64 `json:"vertical_rate_ms"`
	GeoAltM        float64 `json:"geo_alt_m"`
	Squawk         string  `json:"squawk"`

	// Champs dérivés (kt, FL) calculés ici pour éviter au frontend de répéter.
	GsKt      float64 `json:"gs_kt"`
	BaroAltFt float64 `json:"baro_alt_ft"`
	FL        int     `json:"fl"`
	TimeISO   string  `json:"time_iso"`
}

// Client interroge OpenSky. Auth basic optionnelle (sans : 100 req/jour).
type Client struct {
	baseURL string
	user    string
	pass    string
	http    *http.Client
}

func New(user, pass string) *Client {
	return &Client{
		baseURL: "https://opensky-network.org",
		user:    user,
		pass:    pass,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

// Authenticated retourne true si des credentials sont fournis.
func (c *Client) Authenticated() bool {
	return c.user != ""
}

// QueryStates effectue un GET /api/states/all. bbox et icao24 sont optionnels.
// Le filtre callsign est appliqué côté Go (l'API OpenSky ne le gère pas en
// paramètre). On cherche par sous-chaîne case-insensitive.
func (c *Client) QueryStates(
	ctx context.Context,
	bbox *[4]float64, // [lonMin, latMin, lonMax, latMax] ou nil
	icao24Filter string, // exact ou ""
	callsignFilter string, // sous-chaîne ou ""
) ([]State, error) {
	u := c.baseURL + "/api/states/all"
	params := []string{}
	if bbox != nil {
		params = append(params,
			fmt.Sprintf("lamin=%g", bbox[1]),
			fmt.Sprintf("lamax=%g", bbox[3]),
			fmt.Sprintf("lomin=%g", bbox[0]),
			fmt.Sprintf("lomax=%g", bbox[2]),
		)
	}
	if icao24Filter != "" {
		params = append(params, "icao24="+strings.ToLower(strings.TrimSpace(icao24Filter)))
	}
	if len(params) > 0 {
		u += "?" + strings.Join(params, "&")
	}

	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	if c.user != "" {
		req.SetBasicAuth(c.user, c.pass)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		// Tronquer le body en cas d'erreur (peut être HTML)
		max := 200
		if len(body) < max {
			max = len(body)
		}
		return nil, fmt.Errorf("opensky %d: %s", resp.StatusCode, body[:max])
	}

	var raw struct {
		Time   int64           `json:"time"`
		States [][]interface{} `json:"states"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("opensky decode: %w", err)
	}

	out := make([]State, 0, len(raw.States))
	csUpper := strings.ToUpper(strings.TrimSpace(callsignFilter))
	for _, arr := range raw.States {
		s := parseStateArr(arr)
		if csUpper != "" && !strings.Contains(strings.ToUpper(s.Callsign), csUpper) {
			continue
		}
		out = append(out, s)
	}
	return out, nil
}

func parseStateArr(a []interface{}) State {
	var s State
	s.ICAO24 = getStr(a, 0)
	s.Callsign = strings.TrimSpace(getStr(a, 1))
	s.OriginCountry = getStr(a, 2)
	s.TimePosition = int64(getFloat(a, 3))
	s.LastContact = int64(getFloat(a, 4))
	s.Lon = getFloat(a, 5)
	s.Lat = getFloat(a, 6)
	s.BaroAltM = getFloat(a, 7)
	s.OnGround = getBool(a, 8)
	s.VelocityMs = getFloat(a, 9)
	s.TrueTrack = getFloat(a, 10)
	s.VerticalRateMs = getFloat(a, 11)
	s.GeoAltM = getFloat(a, 13)
	s.Squawk = getStr(a, 14)

	s.GsKt = s.VelocityMs * 1.94384
	s.BaroAltFt = s.BaroAltM * 3.28084
	s.FL = int(s.BaroAltFt / 100)
	if s.TimePosition > 0 {
		s.TimeISO = time.Unix(s.TimePosition, 0).UTC().Format(time.RFC3339)
	}
	return s
}

func getStr(a []interface{}, i int) string {
	if i >= len(a) || a[i] == nil {
		return ""
	}
	if v, ok := a[i].(string); ok {
		return v
	}
	return ""
}

func getFloat(a []interface{}, i int) float64 {
	if i >= len(a) || a[i] == nil {
		return 0
	}
	if v, ok := a[i].(float64); ok {
		return v
	}
	return 0
}

func getBool(a []interface{}, i int) bool {
	if i >= len(a) || a[i] == nil {
		return false
	}
	if v, ok := a[i].(bool); ok {
		return v
	}
	return false
}
