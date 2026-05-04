// Package ncutil regroupe les helpers communs autour de la lib
// batchatco/go-native-netcdf : ouverture d'un NetCDF reçu en bytes via un
// fichier temporaire (la lib n'accepte qu'un path), conversion d'attributs
// CF-1.x (scale_factor / add_offset / _FillValue) en flottants exploitables.
package ncutil

import (
	"bytes"
	"fmt"
	"io"
	"math"
	"os"

	"github.com/batchatco/go-native-netcdf/netcdf"
	"github.com/batchatco/go-native-netcdf/netcdf/api"
)

// OpenBytes écrit body dans un fichier temporaire, l'ouvre comme NetCDF-4
// et retourne le groupe racine + une fonction de cleanup. Le caller doit
// systématiquement appeler cleanup() (idéalement via defer) pour fermer le
// handle ET supprimer le fichier ; cleanup est sûre à appeler même si
// l'erreur retournée est non-nil (no-op).
func OpenBytes(body []byte) (api.Group, func(), error) {
	tmp, err := os.CreateTemp("", "metgate-nc-*.nc")
	if err != nil {
		return nil, func() {}, fmt.Errorf("tempfile: %w", err)
	}
	path := tmp.Name()
	cleanupFile := func() { _ = os.Remove(path) }

	if _, err := io.Copy(tmp, bytes.NewReader(body)); err != nil {
		_ = tmp.Close()
		cleanupFile()
		return nil, func() {}, fmt.Errorf("write tempfile: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanupFile()
		return nil, func() {}, fmt.Errorf("close tempfile: %w", err)
	}

	nc, err := netcdf.Open(path)
	if err != nil {
		cleanupFile()
		return nil, func() {}, fmt.Errorf("netcdf open: %w", err)
	}
	cleanup := func() {
		nc.Close()
		cleanupFile()
	}
	return nc, cleanup, nil
}

// UnpackParams extrait scale_factor, add_offset et _FillValue d'une variable
// NetCDF (convention CF-1.x). Valeurs par défaut : scale=1, offset=0,
// fill=NaN (= « pas de transformation »).
func UnpackParams(v *api.Variable) (scale, offset, fill float64) {
	scale, offset, fill = 1, 0, math.NaN()
	if v == nil || v.Attributes == nil {
		return
	}
	if a, ok := v.Attributes.Get("scale_factor"); ok {
		scale = AnyToFloat(a)
	}
	if a, ok := v.Attributes.Get("add_offset"); ok {
		offset = AnyToFloat(a)
	}
	if a, ok := v.Attributes.Get("_FillValue"); ok {
		fill = AnyToFloat(a)
	}
	return
}

// AnyToFloat convertit un attribut NetCDF (qui peut être typé int8..float64)
// en float64. Retourne NaN si le type est inattendu.
func AnyToFloat(v interface{}) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int64:
		return float64(x)
	case int32:
		return float64(x)
	case int16:
		return float64(x)
	case uint16:
		return float64(x)
	case int8:
		return float64(x)
	case uint8:
		return float64(x)
	}
	return math.NaN()
}
