package aircraft

import (
	"sync"
	"time"
)

// History est un ring buffer en mémoire des positions ADS-B vues, indexées
// par icao24. À chaque appel à Append (typiquement depuis QueryStates), on
// stocke un snapshot ; les états plus vieux que maxAge sont évincés. Plafond
// par icao24 pour éviter une fuite si un avion poll très souvent.
type History struct {
	mu       sync.Mutex
	buffers  map[string][]State
	maxAge   time.Duration
	capacity int
}

func NewHistory(maxAge time.Duration) *History {
	return &History{
		buffers:  make(map[string][]State),
		maxAge:   maxAge,
		capacity: 200,
	}
}

// Append stocke un état si time_position est positif. Évince les positions
// expirées (> maxAge) et déduplique : un état avec le même TimePosition
// remplace le précédent (cas du polling qui retombe sur la même position).
func (h *History) Append(s State) {
	if s.ICAO24 == "" || s.TimePosition <= 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	cutoff := time.Now().Add(-h.maxAge).Unix()
	buf := h.buffers[s.ICAO24]
	out := buf[:0]
	for _, x := range buf {
		if x.TimePosition < cutoff {
			continue
		}
		if x.TimePosition == s.TimePosition {
			continue // remplacé par le nouvel état
		}
		out = append(out, x)
	}
	out = append(out, s)
	if len(out) > h.capacity {
		out = out[len(out)-h.capacity:]
	}
	h.buffers[s.ICAO24] = out
}

// Get retourne une copie triée chronologiquement de l'historique stocké.
func (h *History) Get(icao24 string) []State {
	h.mu.Lock()
	defer h.mu.Unlock()
	src := h.buffers[icao24]
	out := make([]State, len(src))
	copy(out, src)
	return out
}
