package notam

import (
	"context"
	"sync"
	"time"
)

// Service wraps Client avec un cache TTL par clé de requête.
type Service struct {
	client *Client
	mu     sync.Mutex
	cache  map[string]cacheEntry
}

type cacheEntry struct {
	notams []NOTAM
	at     time.Time
}

// NewService construit un Service.
func NewService(client *Client) *Service {
	return &Service{
		client: client,
		cache:  make(map[string]cacheEntry),
	}
}

// Authenticated délègue au client.
func (s *Service) Authenticated() bool {
	return s.client.Authenticated()
}

// Search retourne les NOTAM en cache si le TTL est respecté, sinon interroge l'API.
func (s *Service) Search(ctx context.Context, q Query, ttl time.Duration) ([]NOTAM, error) {
	key := cacheKey(q)
	s.mu.Lock()
	if e, ok := s.cache[key]; ok && ttl > 0 && time.Since(e.at) < ttl {
		s.mu.Unlock()
		return e.notams, nil
	}
	s.mu.Unlock()

	notams, err := s.client.Search(ctx, q)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	// Purge basique : supprimer toutes les entrées expirées si > 200 clés.
	if len(s.cache) > 200 {
		for k, e := range s.cache {
			if time.Since(e.at) > ttl {
				delete(s.cache, k)
			}
		}
	}
	s.cache[key] = cacheEntry{notams: notams, at: time.Now()}
	s.mu.Unlock()

	return notams, nil
}

func cacheKey(q Query) string {
	return q.ICAOLocation +
		"|" + q.EffectStart.UTC().Format("2006010215") +
		"|" + q.EffectEnd.UTC().Format("2006010215")
}
