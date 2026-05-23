package aircraft

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// AdsbFiClient interroge api.adsb.fi — libre, sans compte requis.
// Les positions ont ~15 s de latence par rapport au broadcast ADS-B brut.
type AdsbFiClient struct {
	http     *http.Client
	mu       sync.Mutex
	cache    map[string]adsbCacheEntry
	cacheTTL time.Duration
}

type adsbCacheEntry struct {
	states []State
	at     time.Time
}

func NewAdsbFi() *AdsbFiClient {
	return &AdsbFiClient{
		http:     &http.Client{Timeout: 15 * time.Second},
		cache:    make(map[string]adsbCacheEntry),
		cacheTTL: 10 * time.Second,
	}
}

// Nearby retourne les avions dans un rayon rangeNm autour de (lat, lon).
// Résultat mis en cache 10 s par clé (lat,lon,range) pour ménager l'API publique.
func (c *AdsbFiClient) Nearby(ctx context.Context, lat, lon, rangeNm float64) ([]State, error) {
	key := fmt.Sprintf("%.3f,%.3f,%.0f", lat, lon, rangeNm)

	c.mu.Lock()
	if e, ok := c.cache[key]; ok && time.Since(e.at) < c.cacheTTL {
		out := e.states
		c.mu.Unlock()
		return out, nil
	}
	c.mu.Unlock()

	u := fmt.Sprintf("https://api.adsb.fi/v1/lat/%.4f/lon/%.4f/dist/%.0f", lat, lon, rangeNm)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "metgate-portal/1.0")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		n := min(200, len(body))
		return nil, fmt.Errorf("adsb.fi %d: %s", resp.StatusCode, body[:n])
	}

	var raw struct {
		AC []struct {
			Hex      string  `json:"hex"`
			Flight   string  `json:"flight"`
			Lat      float64 `json:"lat"`
			Lon      float64 `json:"lon"`
			AltBaro  any     `json:"alt_baro"` // float64 ou "ground"
			GS       float64 `json:"gs"`        // nœuds
			Track    float64 `json:"track"`     // degrés depuis le nord
			BaroRate float64 `json:"baro_rate"` // ft/min
			Squawk   string  `json:"squawk"`
			Seen     float64 `json:"seen"` // s depuis le dernier message reçu
		} `json:"ac"`
		Now float64 `json:"now"` // Unix timestamp en secondes
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("adsb.fi decode: %w", err)
	}

	out := make([]State, 0, len(raw.AC))
	for _, ac := range raw.AC {
		altFt := 0.0
		onGround := false
		switch v := ac.AltBaro.(type) {
		case float64:
			altFt = v
		case string:
			onGround = v == "ground"
		}
		fl := int(altFt / 100)
		altM := altFt * 0.3048
		vrateMs := ac.BaroRate * 0.00508 // ft/min → m/s

		tPos := int64(0)
		if raw.Now > 0 {
			tPos = int64(raw.Now - ac.Seen)
		}
		tISO := ""
		if tPos > 0 {
			tISO = time.Unix(tPos, 0).UTC().Format(time.RFC3339)
		}

		out = append(out, State{
			ICAO24:         strings.ToLower(strings.TrimSpace(ac.Hex)),
			Callsign:       strings.TrimSpace(ac.Flight),
			TimePosition:   tPos,
			LastContact:    tPos,
			Lon:            ac.Lon,
			Lat:            ac.Lat,
			BaroAltM:       altM,
			OnGround:       onGround,
			VelocityMs:     ac.GS * 0.514444,
			TrueTrack:      ac.Track,
			VerticalRateMs: vrateMs,
			GeoAltM:        altM,
			Squawk:         ac.Squawk,
			GsKt:           ac.GS,
			BaroAltFt:      altFt,
			FL:             fl,
			TimeISO:        tISO,
		})
	}

	c.mu.Lock()
	c.cache[key] = adsbCacheEntry{states: out, at: time.Now()}
	c.mu.Unlock()
	return out, nil
}
