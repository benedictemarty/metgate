package aircraft

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"time"
)

// History est un ring buffer en mémoire des positions ADS-B vues, indexées
// par icao24. À chaque appel à Append (typiquement depuis QueryStates), on
// stocke un snapshot ; les états plus vieux que maxAge sont évincés. Plafond
// par icao24 pour éviter une fuite si un avion poll très souvent.
//
// Éviction LRU : si le nombre d'icao24 distincts dépasse maxKeys, les entrées
// les plus anciennes (last seen) sont supprimées pour éviter une croissance
// illimitée de la map (risque OOM sur longue durée).
type History struct {
	mu       sync.Mutex
	buffers  map[string][]State
	lastSeen map[string]int64 // unix timestamp du dernier Append par icao24
	maxAge   time.Duration
	capacity int // max states par icao24
	maxKeys  int // max icao24 distincts dans la map
}

func NewHistory(maxAge time.Duration) *History {
	return &History{
		buffers:  make(map[string][]State),
		lastSeen: make(map[string]int64),
		maxAge:   maxAge,
		capacity: 200,
		maxKeys:  1000,
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

	now := time.Now().Unix()
	cutoff := now - int64(h.maxAge.Seconds())

	buf := h.buffers[s.ICAO24]
	out := buf[:0]
	for _, x := range buf {
		if x.TimePosition < cutoff {
			continue
		}
		if x.TimePosition == s.TimePosition {
			continue
		}
		out = append(out, x)
	}
	out = append(out, s)
	if len(out) > h.capacity {
		out = out[len(out)-h.capacity:]
	}
	h.buffers[s.ICAO24] = out
	h.lastSeen[s.ICAO24] = now

	// Éviction LRU : si trop d'icao24 distincts, supprimer les plus anciens.
	if len(h.buffers) > h.maxKeys {
		h.evictOldest()
	}
}

// evictOldest supprime l'icao24 avec le lastSeen le plus ancien.
// Doit être appelé sous h.mu.
func (h *History) evictOldest() {
	var oldest string
	var oldestTime int64 = 1<<63 - 1
	for icao, t := range h.lastSeen {
		if t < oldestTime {
			oldestTime = t
			oldest = icao
		}
	}
	if oldest != "" {
		delete(h.buffers, oldest)
		delete(h.lastSeen, oldest)
	}
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

// Len retourne le nombre d'icao24 distincts actuellement suivis.
func (h *History) Len() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.buffers)
}

// dumpPayload est la structure JSON serialisée sur disque.
type dumpPayload struct {
	DumpedAt string            `json:"dumped_at"`
	Buffers  map[string][]State `json:"buffers"`
}

// Dump sérialise l'historique courant dans path (JSON gzip). Appelé au
// shutdown pour permettre la restauration au redémarrage suivant.
func (h *History) Dump(path string) error {
	h.mu.Lock()
	snapshot := make(map[string][]State, len(h.buffers))
	for k, v := range h.buffers {
		cp := make([]State, len(v))
		copy(cp, v)
		snapshot[k] = cp
	}
	h.mu.Unlock()

	f, err := os.CreateTemp(fmt.Sprintf("%s", os.TempDir()), "ads-b-history-*.json.gz")
	if err != nil {
		return fmt.Errorf("dump: create temp: %w", err)
	}
	tmpName := f.Name()

	gz := gzip.NewWriter(f)
	enc := json.NewEncoder(gz)
	if err := enc.Encode(dumpPayload{
		DumpedAt: time.Now().UTC().Format(time.RFC3339),
		Buffers:  snapshot,
	}); err != nil {
		f.Close()
		os.Remove(tmpName)
		return fmt.Errorf("dump: encode: %w", err)
	}
	if err := gz.Close(); err != nil {
		f.Close()
		os.Remove(tmpName)
		return fmt.Errorf("dump: gzip close: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("dump: file close: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("dump: rename: %w", err)
	}
	return nil
}

// Restore charge l'historique depuis path (JSON gzip). Les entrées expirées
// (plus anciennes que maxAge) sont filtrées à la restauration.
func (h *History) Restore(path string) error {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // pas d'historique sauvegardé, ignoré silencieusement
		}
		return fmt.Errorf("restore: open: %w", err)
	}
	defer f.Close() //nolint:errcheck

	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("restore: gzip: %w", err)
	}
	defer gz.Close() //nolint:errcheck

	raw, err := io.ReadAll(gz)
	if err != nil {
		return fmt.Errorf("restore: read: %w", err)
	}
	var payload dumpPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Errorf("restore: decode: %w", err)
	}

	cutoff := time.Now().Add(-h.maxAge).Unix()
	h.mu.Lock()
	defer h.mu.Unlock()
	total, kept := 0, 0
	for icao, states := range payload.Buffers {
		var valid []State
		for _, s := range states {
			total++
			if s.TimePosition >= cutoff {
				valid = append(valid, s)
				kept++
			}
		}
		if len(valid) > 0 {
			if len(h.buffers) >= h.maxKeys {
				break // capacité LRU déjà atteinte
			}
			if len(valid) > h.capacity {
				valid = valid[len(valid)-h.capacity:]
			}
			h.buffers[icao] = valid
			h.lastSeen[icao] = valid[len(valid)-1].TimePosition
		}
	}
	slog.Info("ADS-B history restauré", "dumped_at", payload.DumpedAt, "total", total, "kept", kept, "icao24", len(h.buffers))
	return nil
}
