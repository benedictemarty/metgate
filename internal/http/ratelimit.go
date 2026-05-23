package httpapi

import (
	"net"
	"net/http"
	"sync"
	"time"
)

// ipRateLimiter applique un délai minimum entre deux requêtes successives
// par adresse IP. Simple "fixed-interval" per-IP : une requête autorisée
// toutes les interval secondes. Les entrées inactives sont purgées toutes
// les 10 minutes pour éviter une croissance illimitée de la map.
type ipRateLimiter struct {
	mu       sync.Mutex
	last     map[string]time.Time
	interval time.Duration
}

func newIPRateLimiter(interval time.Duration) *ipRateLimiter {
	rl := &ipRateLimiter{
		last:     make(map[string]time.Time),
		interval: interval,
	}
	go rl.cleanup()
	return rl
}

// Allow retourne true si la requête est autorisée et met à jour le timer IP.
func (rl *ipRateLimiter) Allow(r *http.Request) bool {
	ip := clientIP(r)
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	if last, ok := rl.last[ip]; ok && now.Sub(last) < rl.interval {
		return false
	}
	rl.last[ip] = now
	return true
}

// cleanup purge les entrées expirées toutes les 10 minutes.
func (rl *ipRateLimiter) cleanup() {
	tick := time.NewTicker(10 * time.Minute)
	defer tick.Stop()
	for range tick.C {
		cutoff := time.Now().Add(-rl.interval * 2)
		rl.mu.Lock()
		for ip, t := range rl.last {
			if t.Before(cutoff) {
				delete(rl.last, ip)
			}
		}
		rl.mu.Unlock()
	}
}

// clientIP extrait l'adresse IP réelle du client (supporte X-Forwarded-For).
func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		// Le premier élément est l'IP d'origine.
		if ip, _, err := net.SplitHostPort(fwd); err == nil {
			return ip
		}
		return fwd
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
