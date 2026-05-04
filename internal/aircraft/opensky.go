// Package aircraft est un client minimal pour OpenSky Network
// (opensky-network.org). Permet d'interroger les états ADS-B en live.
package aircraft

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
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

// Client interroge OpenSky.
//
// Authentification supportée :
//   - OAuth2 client credentials (clientID / clientSecret) — méthode actuelle
//     OpenSky depuis fin 2024. Nécessite l'auth des appels API via Bearer
//     access_token ; le client gère le cache et le refresh.
//   - Basic auth (user / pass) — méthode legacy, encore acceptée.
//   - Anonyme (rien) — limité à ~100 req/jour.
type Client struct {
	baseURL      string
	authURL      string
	user         string
	pass         string
	clientID     string
	clientSecret string

	tokenMu      sync.Mutex
	tokenStr     string
	tokenExpires time.Time

	http *http.Client
}

func New(user, pass, clientID, clientSecret string) *Client {
	return &Client{
		baseURL:      "https://opensky-network.org",
		authURL:      "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
		user:         user,
		pass:         pass,
		clientID:     clientID,
		clientSecret: clientSecret,
		http:         &http.Client{Timeout: 30 * time.Second},
	}
}

// Authenticated retourne true si des credentials sont fournis (OAuth2 ou Basic).
func (c *Client) Authenticated() bool {
	return c.clientID != "" || c.user != ""
}

// fetchToken récupère ou rafraîchit le Bearer OAuth2 (cache local).
func (c *Client) fetchToken(ctx context.Context) (string, error) {
	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()
	if c.tokenStr != "" && time.Now().Before(c.tokenExpires) {
		return c.tokenStr, nil
	}
	if c.clientID == "" {
		return "", fmt.Errorf("no OAuth2 client_id configured")
	}
	form := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {c.clientID},
		"client_secret": {c.clientSecret},
	}.Encode()
	req, err := http.NewRequestWithContext(ctx, "POST", c.authURL, strings.NewReader(form))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		max := 200
		if len(body) < max {
			max = len(body)
		}
		return "", fmt.Errorf("opensky auth %d: %s", resp.StatusCode, body[:max])
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		TokenType   string `json:"token_type"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return "", fmt.Errorf("opensky auth decode: %w", err)
	}
	c.tokenStr = tok.AccessToken
	// Marge de 30 s avant l'expiration pour éviter les requêtes 401
	if tok.ExpiresIn > 30 {
		c.tokenExpires = time.Now().Add(time.Duration(tok.ExpiresIn-30) * time.Second)
	} else {
		c.tokenExpires = time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
	}
	return c.tokenStr, nil
}

// authorize pose le bon header sur la requête (Bearer si OAuth2 sinon Basic).
func (c *Client) authorize(ctx context.Context, req *http.Request) error {
	if c.clientID != "" {
		token, err := c.fetchToken(ctx)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		return nil
	}
	if c.user != "" {
		req.SetBasicAuth(c.user, c.pass)
	}
	return nil
}

// FlightSegment est un segment de vol vu par OpenSky : les estimations
// d'aéroports de départ et d'arrivée pour un icao24 sur une fenêtre temporelle.
type FlightSegment struct {
	ICAO24                          string `json:"icao24"`
	FirstSeen                       int64  `json:"first_seen"`
	LastSeen                        int64  `json:"last_seen"`
	Callsign                        string `json:"callsign"`
	EstDepartureAirport             string `json:"est_departure_airport"`
	EstArrivalAirport               string `json:"est_arrival_airport"`
	DepartureAirportCandidatesCount int    `json:"departure_candidates"`
	ArrivalAirportCandidatesCount   int    `json:"arrival_candidates"`
}

// FlightsByAircraft interroge /api/flights/aircraft pour récupérer les
// segments de vol d'un icao24 dans la fenêtre [begin, end] (Unix s).
// Endpoint authenticated only en pratique (anonymous = limité ou refusé).
// Retourne un tableau (peut être vide).
func (c *Client) FlightsByAircraft(
	ctx context.Context,
	icao24 string, begin, end time.Time,
) ([]FlightSegment, error) {
	if icao24 == "" {
		return nil, fmt.Errorf("icao24 vide")
	}
	u := fmt.Sprintf(
		"%s/api/flights/aircraft?icao24=%s&begin=%d&end=%d",
		c.baseURL, strings.ToLower(strings.TrimSpace(icao24)),
		begin.Unix(), end.Unix(),
	)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	if err := c.authorize(ctx, req); err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		max := 200
		if len(body) < max {
			max = len(body)
		}
		return nil, fmt.Errorf("opensky flights %d: %s", resp.StatusCode, body[:max])
	}
	// Format brut OpenSky : {icao24, firstSeen, estDepartureAirport, ...}
	var raw []struct {
		ICAO24                          string `json:"icao24"`
		FirstSeen                       int64  `json:"firstSeen"`
		LastSeen                        int64  `json:"lastSeen"`
		Callsign                        string `json:"callsign"`
		EstDepartureAirport             any    `json:"estDepartureAirport"`
		EstArrivalAirport               any    `json:"estArrivalAirport"`
		DepartureAirportCandidatesCount int    `json:"departureAirportCandidatesCount"`
		ArrivalAirportCandidatesCount   int    `json:"arrivalAirportCandidatesCount"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("opensky flights decode: %w", err)
	}
	out := make([]FlightSegment, 0, len(raw))
	for _, f := range raw {
		out = append(out, FlightSegment{
			ICAO24:                          f.ICAO24,
			FirstSeen:                       f.FirstSeen,
			LastSeen:                        f.LastSeen,
			Callsign:                        strings.TrimSpace(f.Callsign),
			EstDepartureAirport:             optStr(f.EstDepartureAirport),
			EstArrivalAirport:               optStr(f.EstArrivalAirport),
			DepartureAirportCandidatesCount: f.DepartureAirportCandidatesCount,
			ArrivalAirportCandidatesCount:   f.ArrivalAirportCandidatesCount,
		})
	}
	return out, nil
}

func optStr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
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
	if err := c.authorize(ctx, req); err != nil {
		return nil, err
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
