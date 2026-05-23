package catalog

import (
	"context"
	"net/url"
	"sync"
	"sync/atomic"
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

	hits   atomic.Int64
	misses atomic.Int64
}

type cacheEntry struct {
	resp      *metgate.Response
	expiresAt time.Time
	cachedAt  time.Time
}

// CacheStats contient les métriques courantes du cache.
type CacheStats struct {
	Hits    int64       `json:"hits"`
	Misses  int64       `json:"misses"`
	Entries []CacheEntry `json:"entries"`
}

// CacheEntry décrit une entrée active du cache.
type CacheEntry struct {
	Key       string `json:"key"`
	AgeS      int    `json:"age_s"`      // secondes depuis mise en cache
	TTLLeftS  int    `json:"ttl_left_s"` // secondes avant expiration
	SizeBytes int    `json:"size_bytes"`
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
		c.hits.Add(1)
		hit := *e.resp
		hit.FromCache = true
		hit.CacheAge = int(time.Since(e.cachedAt).Seconds())
		return &hit, nil
	}

	c.misses.Add(1)
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
			now := time.Now()
			c.mu.Lock()
			c.entries[key] = cacheEntry{
				resp:      resp,
				expiresAt: now.Add(c.ttl),
				cachedAt:  now,
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

// Stats retourne un snapshot des métriques du cache (hits, misses, entrées actives).
func (c *responseCache) Stats() CacheStats {
	now := time.Now()
	c.mu.RLock()
	entries := make([]CacheEntry, 0, len(c.entries))
	for k, e := range c.entries {
		if now.Before(e.expiresAt) {
			entries = append(entries, CacheEntry{
				Key:       k,
				AgeS:      int(now.Sub(e.cachedAt).Seconds()),
				TTLLeftS:  int(e.expiresAt.Sub(now).Seconds()),
				SizeBytes: len(e.resp.Body),
			})
		}
	}
	c.mu.RUnlock()
	return CacheStats{
		Hits:    c.hits.Load(),
		Misses:  c.misses.Load(),
		Entries: entries,
	}
}
