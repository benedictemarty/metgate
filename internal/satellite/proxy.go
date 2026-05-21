// Package satellite proxie les tuiles raster d'EUMETView (WMS GeoServer)
// vers MapLibre, qui consomme du z/x/y. Le backend convertit les coordonnées
// de tuile XYZ en bbox EPSG:3857 puis appelle GetMap.
//
// Source : EUMETView (https://view.eumetsat.int/geoserver/wms) — service
// public, pas d'authentification requise. Données satellite à titre
// situationnel ; non OPMET.
package satellite

import (
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

const (
	wmsURL  = "https://view.eumetsat.int/geoserver/wms"
	mercMax = 20037508.342789244
	tilePx  = 256
)

// Layers WMS exposés par EUMETView, autorisés dans le proxy. Limiter la liste
// évite qu'un client utilise notre backend comme proxy ouvert vers EUMETView.
var allowedLayers = map[string]bool{
	"mtg_fd:ir105_hrfi":        true, // FCI IR 10.5 µm (haute résolution)
	"mtg_fd:vis06_hrfi":        true, // FCI VIS 0.6 µm
	"mtg_fd:rgb_truecolour":    true,
	"mtg_fd:rgb_cloudtype":     true,
	"mtg_fd:rgb_cloudphase":    true,
	"msg_fes:cth":              true, // Cloud Top Height
	"msg_fes:rgb_convection":   true,
	"msg_fes:fire":             true,
	"mumi:worldcloudmap_ir108": true,
}

type Proxy struct {
	httpClient *http.Client

	// Cache simple (layer+time+z/x/y) -> bytes PNG, TTL court.
	mu    sync.Mutex
	cache map[string]cacheEntry
}

type cacheEntry struct {
	body []byte
	at   time.Time
}

func NewProxy() *Proxy {
	return &Proxy{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		cache:      map[string]cacheEntry{},
	}
}

// HandleTile : GET /api/satellite/tile?layer=...&z=...&x=...&y=...&time=...&style=...
// Le paramètre `style` est crucial : sans style explicite, GeoServer fait un
// auto-stretch de palette par tuile → bandes de couleurs incohérentes entre
// tuiles voisines. Avec un style nommé (ex: grayscale, msg_cth), la palette
// est fixe et le rendu cohérent à toutes les zooms.
func (p *Proxy) HandleTile(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	layer := q.Get("layer")
	if !allowedLayers[layer] {
		http.Error(w, "layer non autorisé", http.StatusBadRequest)
		return
	}
	z, err1 := strconv.Atoi(q.Get("z"))
	x, err2 := strconv.Atoi(q.Get("x"))
	y, err3 := strconv.Atoi(q.Get("y"))
	if err1 != nil || err2 != nil || err3 != nil || z < 0 || z > 18 {
		http.Error(w, "z/x/y invalides", http.StatusBadRequest)
		return
	}
	timeParam := q.Get("time")
	style := q.Get("style")

	cacheKey := fmt.Sprintf("%s|%s|%s|%d|%d|%d", layer, style, timeParam, z, x, y)
	if body, ok := p.fromCache(cacheKey, 60*time.Second); ok {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("X-Cache", "HIT")
		_, _ = w.Write(body)
		return
	}

	// XYZ → bbox EPSG:3857.
	size := 2 * mercMax / math.Pow(2, float64(z))
	xMin := -mercMax + float64(x)*size
	xMax := xMin + size
	yMax := mercMax - float64(y)*size
	yMin := yMax - size

	wmsQ := url.Values{}
	wmsQ.Set("service", "WMS")
	wmsQ.Set("version", "1.3.0")
	wmsQ.Set("request", "GetMap")
	wmsQ.Set("layers", layer)
	wmsQ.Set("styles", style) // vide = style par défaut du serveur
	wmsQ.Set("crs", "EPSG:3857")
	wmsQ.Set("bbox", fmt.Sprintf("%f,%f,%f,%f", xMin, yMin, xMax, yMax))
	wmsQ.Set("width", strconv.Itoa(tilePx))
	wmsQ.Set("height", strconv.Itoa(tilePx))
	wmsQ.Set("format", "image/png")
	wmsQ.Set("transparent", "true")
	if timeParam != "" {
		wmsQ.Set("time", timeParam)
	}

	resp, err := p.httpClient.Get(wmsURL + "?" + wmsQ.Encode())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close() //nolint:errcheck
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if resp.StatusCode != 200 {
		http.Error(w, fmt.Sprintf("eumetview status %d", resp.StatusCode), http.StatusBadGateway)
		return
	}
	p.toCache(cacheKey, body)
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Cache", "MISS")
	w.Header().Set("Cache-Control", "public, max-age=60")
	_, _ = w.Write(body)
}

func (p *Proxy) fromCache(key string, ttl time.Duration) ([]byte, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.cache[key]
	if !ok || time.Since(e.at) > ttl {
		return nil, false
	}
	return e.body, true
}

func (p *Proxy) toCache(key string, body []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	// Borne grossière : si > 500 entrées, on flush tout (tile cache court).
	if len(p.cache) > 500 {
		p.cache = map[string]cacheEntry{}
	}
	p.cache[key] = cacheEntry{body: body, at: time.Now()}
}
