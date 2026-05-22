package httpapi

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// clampBBox réduit la bbox à maxLonSpan × maxLatSpan degrés centrée sur son
// milieu. Évite des requêtes WCS trop larges → NetCDF gigantesque / timeout.
func clampBBox(bb [4]float64, maxLonSpan, maxLatSpan float64) [4]float64 {
	midLon := (bb[0] + bb[2]) / 2
	midLat := (bb[1] + bb[3]) / 2
	half := maxLonSpan / 2
	if bb[2]-bb[0] > maxLonSpan {
		bb[0] = midLon - half
		bb[2] = midLon + half
	}
	half = maxLatSpan / 2
	if bb[3]-bb[1] > maxLatSpan {
		bb[1] = midLat - half
		bb[3] = midLat + half
	}
	return bb
}

// parseIntParam lit un entier depuis ?name=. Si la query est vide, retourne
// def. Si la valeur est non vide mais invalide ou hors [min, max], écrit
// 400 sur w et retourne ok=false : le caller doit return immédiatement.
func parseIntParam(w http.ResponseWriter, r *http.Request, name string, def, minVal, maxVal int) (int, bool) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def, true
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		http.Error(w, fmt.Sprintf("%s: entier attendu, reçu %q", name, v), http.StatusBadRequest)
		return 0, false
	}
	if n < minVal || n > maxVal {
		http.Error(w, fmt.Sprintf("%s=%d hors plage [%d..%d]", name, n, minVal, maxVal), http.StatusBadRequest)
		return 0, false
	}
	return n, true
}

// parseFloatParam : idem pour un float. Pas de borne (la plupart des cas
// d'usage — bearings, vitesses, niveaux Pa — ont des plages naturelles
// qu'on ne re-valide pas ici).
func parseFloatParam(w http.ResponseWriter, r *http.Request, name string, def float64) (float64, bool) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def, true
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		http.Error(w, fmt.Sprintf("%s: réel attendu, reçu %q", name, v), http.StatusBadRequest)
		return 0, false
	}
	return f, true
}

// parseBBoxParam lit ?name=lonMin,latMin,lonMax,latMax. Si vide, retourne
// def. Sur erreur de format, écrit 400 et retourne ok=false.
func parseBBoxParam(w http.ResponseWriter, r *http.Request, name string, def [4]float64) ([4]float64, bool) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def, true
	}
	parts := strings.Split(v, ",")
	if len(parts) != 4 {
		http.Error(w, fmt.Sprintf("%s: attend lonMin,latMin,lonMax,latMax (4 valeurs, reçu %d)", name, len(parts)), http.StatusBadRequest)
		return [4]float64{}, false
	}
	var bb [4]float64
	for i, p := range parts {
		f, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			http.Error(w, fmt.Sprintf("%s: composante %d non numérique (%q)", name, i, p), http.StatusBadRequest)
			return [4]float64{}, false
		}
		bb[i] = f
	}
	if bb[0] >= bb[2] || bb[1] >= bb[3] {
		http.Error(w, fmt.Sprintf("%s: bbox dégénérée (lonMin >= lonMax ou latMin >= latMax)", name), http.StatusBadRequest)
		return [4]float64{}, false
	}
	return bb, true
}
