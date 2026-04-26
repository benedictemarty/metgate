package catalog

import (
	"context"
	"net/url"
	"sync"
	"time"

	"github.com/bmarty/metgate/internal/metgate"
	"golang.org/x/sync/singleflight"
)

// responseCache mémorise les réponses brutes MetGate (bytes + content-type)
// par couple (path, query) avec un TTL fixe. singleflight déduplique les
// fetches concurrents sur la même clé, ce qui évite les rafales lors d'un
// rechargement avec plusieurs couches actives ou pendant l'animation play.
type responseCache struct {
	ttl     time.Duration
	mu      sync.RWMutex
	entries map[string]cacheEntry
	sf      singleflight.Group
}

type cacheEntry struct {
	resp      *metgate.Response
	expiresAt time.Time
}

func newResponseCache(ttl time.Duration) *responseCache {
	return &responseCache{
		ttl:     ttl,
		entries: make(map[string]cacheEntry),
	}
}

func cacheKey(path string, query url.Values) string {
	return path + "?" + query.Encode()
}

// get retourne la réponse cachée si encore valide, sinon délègue à fetch
// (en garantissant qu'au plus une fetch concurrente est en cours par clé)
// puis stocke en cache pour les statuts 200.
func (c *responseCache) get(
	ctx context.Context,
	path string,
	query url.Values,
	fetch func(ctx context.Context) (*metgate.Response, error),
) (*metgate.Response, error) {
	if c.ttl <= 0 {
		return fetch(ctx)
	}

	key := cacheKey(path, query)

	c.mu.RLock()
	e, ok := c.entries[key]
	c.mu.RUnlock()
	if ok && time.Now().Before(e.expiresAt) {
		hit := *e.resp // copie pour set FromCache sans toucher l'entrée partagée
		hit.FromCache = true
		return &hit, nil
	}

	v, err, _ := c.sf.Do(key, func() (any, error) {
		// Nouvelle vérification au cas où une fetch parallèle a déjà repeuplé
		// le cache pendant qu'on attendait notre tour dans singleflight.
		c.mu.RLock()
		e2, ok2 := c.entries[key]
		c.mu.RUnlock()
		if ok2 && time.Now().Before(e2.expiresAt) {
			return e2.resp, nil
		}

		resp, err := fetch(ctx)
		if err != nil {
			return nil, err
		}
		if resp.Status == 200 {
			c.mu.Lock()
			c.entries[key] = cacheEntry{
				resp:      resp,
				expiresAt: time.Now().Add(c.ttl),
			}
			c.mu.Unlock()
		}
		return resp, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*metgate.Response), nil
}
