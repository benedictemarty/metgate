package lightning

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/batchatco/go-native-netcdf/netcdf/api"
	"github.com/bmarty/metgate/internal/ncutil"
)

// Flash représente un impact foudre extrait du produit MTG-LI LFL.
type Flash struct {
	Time       time.Time
	Lat        float64
	Lon        float64
	Radiance   float64 // mW.m-2.sr-1
	Duration   float64 // ms
	Confidence float64 // 0..1
}

// Service met en cache le dernier produit téléchargé pour éviter les
// re-téléchargements à chaque requête (les produits sortent toutes les 10 min).
type Service struct {
	client *Client

	mu       sync.Mutex
	cacheKey string
	cacheAt  time.Time
	flashes  []Flash
}

func NewService(client *Client) *Service {
	return &Service{client: client}
}

func (s *Service) Authenticated() bool {
	return s.client != nil && s.client.Authenticated()
}

// Latest charge (ou récupère du cache) la liste des flashes du dernier
// produit MTG-LI LFL. cacheTTL borne la fraîcheur ; passe 0 pour forcer.
func (s *Service) Latest(ctx context.Context, cacheTTL time.Duration) ([]Flash, time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if cacheTTL > 0 && len(s.flashes) > 0 && time.Since(s.cacheAt) < cacheTTL {
		return s.flashes, s.cacheAt, nil
	}

	id, dlURL, err := s.client.LatestProduct(ctx)
	if err != nil {
		return nil, time.Time{}, err
	}
	if id == s.cacheKey && len(s.flashes) > 0 {
		// Même produit qu'au tour précédent : on ne re-télécharge pas.
		s.cacheAt = time.Now()
		return s.flashes, s.cacheAt, nil
	}

	zipBytes, err := s.client.Download(ctx, dlURL)
	if err != nil {
		return nil, time.Time{}, err
	}
	flashes, err := parseLFLZip(zipBytes)
	if err != nil {
		return nil, time.Time{}, err
	}
	s.cacheKey = id
	s.cacheAt = time.Now()
	s.flashes = flashes
	return flashes, s.cacheAt, nil
}

// parseLFLZip ouvre le ZIP renvoyé par EUMETSAT, trouve le NetCDF *BODY*.nc
// et extrait les flashes (latitude, longitude, time, radiance, ...).
func parseLFLZip(zipBytes []byte) ([]Flash, error) {
	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		return nil, fmt.Errorf("zip open: %w", err)
	}
	var ncBytes []byte
	for _, f := range zr.File {
		if strings.Contains(f.Name, "BODY") && strings.HasSuffix(f.Name, ".nc") {
			r, err := f.Open()
			if err != nil {
				return nil, err
			}
			ncBytes, err = io.ReadAll(r)
			r.Close() //nolint:errcheck
			if err != nil {
				return nil, err
			}
			break
		}
	}
	if ncBytes == nil {
		return nil, fmt.Errorf("no BODY .nc found in archive")
	}
	nc, cleanup, err := ncutil.OpenBytes(ncBytes)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	lat, err := readFloat64Var(nc, "latitude")
	if err != nil {
		return nil, err
	}
	lon, err := readFloat64Var(nc, "longitude")
	if err != nil {
		return nil, err
	}
	t, err := readFloat64Var(nc, "flash_time")
	if err != nil {
		return nil, err
	}
	rad, _ := readFloat64Var(nc, "radiance")
	dur, _ := readFloat64Var(nc, "flash_duration")
	conf, _ := readFloat64Var(nc, "flash_filter_confidence")

	n := len(lat)
	if len(lon) < n {
		n = len(lon)
	}
	if len(t) < n {
		n = len(t)
	}

	// Epoch MTG-LI : "seconds since 2000-01-01 00:00:00.0" UTC.
	epoch := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	out := make([]Flash, 0, n)
	for i := 0; i < n; i++ {
		if isFill(lat[i]) || isFill(lon[i]) {
			continue
		}
		f := Flash{
			Time: epoch.Add(time.Duration(t[i] * float64(time.Second))),
			Lat:  lat[i],
			Lon:  lon[i],
		}
		if i < len(rad) {
			f.Radiance = rad[i]
		}
		if i < len(dur) {
			f.Duration = dur[i]
		}
		if i < len(conf) {
			f.Confidence = conf[i]
		}
		out = append(out, f)
	}
	return out, nil
}

func isFill(v float64) bool {
	// MTG-LI utilise des _FillValue très grandes (~9.96921e+36) ou NaN.
	return v != v || v > 1e30 || v < -1e30
}

// readFloat64Var lit une variable NetCDF 1D et la convertit en []float64.
// Gère les types packed (int16/uint16) avec convention CF-1.x :
// real_value = packed_value * scale_factor + add_offset
// Les _FillValue sont remplacées par NaN (filtrées plus loin par isFill).
func readFloat64Var(nc api.Group, name string) ([]float64, error) {
	v, err := nc.GetVariable(name)
	if err != nil {
		return nil, fmt.Errorf("var %s: %w", name, err)
	}
	scale, offset, fill := ncutil.UnpackParams(v)

	apply := func(x float64) float64 {
		if !math.IsNaN(fill) && x == fill {
			return math.NaN()
		}
		return x*scale + offset
	}

	switch arr := v.Values.(type) {
	case []float64:
		out := make([]float64, len(arr))
		for i, x := range arr {
			out[i] = apply(x)
		}
		return out, nil
	case []float32:
		out := make([]float64, len(arr))
		for i, x := range arr {
			out[i] = apply(float64(x))
		}
		return out, nil
	case []int64:
		out := make([]float64, len(arr))
		for i, x := range arr {
			out[i] = apply(float64(x))
		}
		return out, nil
	case []int32:
		out := make([]float64, len(arr))
		for i, x := range arr {
			out[i] = apply(float64(x))
		}
		return out, nil
	case []int16:
		out := make([]float64, len(arr))
		for i, x := range arr {
			out[i] = apply(float64(x))
		}
		return out, nil
	case []uint16:
		out := make([]float64, len(arr))
		for i, x := range arr {
			out[i] = apply(float64(x))
		}
		return out, nil
	case []int8:
		out := make([]float64, len(arr))
		for i, x := range arr {
			out[i] = apply(float64(x))
		}
		return out, nil
	case []uint8:
		out := make([]float64, len(arr))
		for i, x := range arr {
			out[i] = apply(float64(x))
		}
		return out, nil
	}
	return nil, fmt.Errorf("var %s: unsupported value type %T", name, v.Values)
}

