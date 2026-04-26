package catalog

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/batchatco/go-native-netcdf/netcdf"
	"github.com/batchatco/go-native-netcdf/netcdf/api"
)

// WindGrid est la donnée vent extraite d'un GetCoverage WCS pour un timestep,
// un niveau de pression, et une bbox donnés. U et V sont en m/s, row-major
// avec latitude en lignes (varie lentement) et longitude en colonnes.
type WindGrid struct {
	CoverageID string     `json:"coverage_id"`
	TimeISO    string     `json:"time"`     // YYYY-MM-DDTHH:MM:SSZ du timestep retenu
	LevelPa    float64    `json:"level_pa"` // pression en Pa
	Bbox       [4]float64 `json:"bbox"`     // [lonMin, latMin, lonMax, latMax]
	Width      int        `json:"width"`    // nb longitudes
	Height     int        `json:"height"`   // nb latitudes
	SpeedMax   float64    `json:"speed_max_ms"`
	U          []float32  `json:"u"` // size = width*height
	V          []float32  `json:"v"`
}

// WindGrid récupère la dernière covering WIND, fait un GetCoverage subsetté
// (niveau + bbox), décode le NetCDF, et renvoie la grille u,v au dernier
// timestep disponible.
func (s *Service) WindGrid(
	ctx context.Context,
	levelPa float64,
	bbox [4]float64,
) (*WindGrid, error) {
	if levelPa <= 0 {
		levelPa = 85000
	}

	coverageID, err := s.latestCoverageID(ctx, "WIND")
	if err != nil {
		return nil, fmt.Errorf("find latest WIND: %w", err)
	}

	q := url.Values{}
	q.Set("service", "WCS")
	q.Set("version", "2.0.1")
	q.Set("request", "GetCoverage")
	q.Set("coverageId", coverageID)
	q.Add("subset", fmt.Sprintf("level(%g)", levelPa))
	q.Add("subset", fmt.Sprintf("longitude(%g,%g)", bbox[0], bbox[2]))
	q.Add("subset", fmt.Sprintf("latitude(%g,%g)", bbox[1], bbox[3]))

	resp, err := s.fetchCached(ctx, "/broker_service/WCS", q)
	if err != nil {
		return nil, err
	}
	if resp.Status != 200 {
		return nil, fmt.Errorf("WCS GetCoverage %s: status %d (%q)",
			coverageID, resp.Status, truncate(resp.Body, 200))
	}

	return decodeWindNetCDF(coverageID, levelPa, bbox, resp.Body)
}

// latestCoverageID lit les Capabilities WCS et retourne le CoverageId le
// plus récent (par tri lexico, ce qui correspond au tri chronologique vu le
// format _AAAAMMJJHHMMSS) commençant par le préfixe donné.
func (s *Service) latestCoverageID(ctx context.Context, prefix string) (string, error) {
	resp, err := s.fetchCapabilities(ctx, "WCS", "2.0.1")
	if err != nil {
		return "", err
	}
	if resp.Status != 200 {
		return "", fmt.Errorf("WCS Capabilities: status %d", resp.Status)
	}

	var doc struct {
		Sums []struct {
			ID string `xml:"CoverageId"`
		} `xml:"Contents>CoverageSummary"`
	}
	if err := xml.Unmarshal(resp.Body, &doc); err != nil {
		return "", fmt.Errorf("WCS Capabilities xml: %w", err)
	}

	candidates := make([]string, 0, len(doc.Sums))
	for _, s := range doc.Sums {
		id := trimSpaces(s.ID)
		if id == "" {
			continue
		}
		// MetGate liste aussi des aliases pseudo-coverages "WIND_last (TS)" :
		// après trim ils deviennent "WIND_last(TS)" qui n'est pas un
		// CoverageId addressable. On les rejette.
		if strings.Contains(id, "_last") || strings.ContainsAny(id, "()") {
			continue
		}
		if len(id) > len(prefix) && id[:len(prefix)] == prefix && id[len(prefix)] == '_' {
			candidates = append(candidates, id)
		}
	}
	if len(candidates) == 0 {
		return "", fmt.Errorf("no coverage matching %s_*", prefix)
	}
	sort.Strings(candidates)
	return candidates[len(candidates)-1], nil
}

func trimSpaces(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == ' ' || c == '\n' || c == '\t' || c == '\r' {
			continue
		}
		out = append(out, c)
	}
	return string(out)
}

// decodeWindNetCDF parse un NetCDF-4 (HDF5) MetGate et extrait u/v au dernier
// timestep. Les variables var33 et var34 contiennent respectivement le vent
// zonal (u, m/s) et méridien (v, m/s) sur une grille [time][level][lat][lon].
func decodeWindNetCDF(coverageID string, level float64, bbox [4]float64, body []byte) (*WindGrid, error) {
	// La lib batchatco/go-native-netcdf veut un fichier sur disque (pas un
	// reader). On écrit le body dans un fichier temporaire.
	tmp, err := os.CreateTemp("", "metgate-wind-*.nc")
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := io.Copy(tmp, bytes.NewReader(body)); err != nil {
		_ = tmp.Close()
		return nil, err
	}
	_ = tmp.Close()

	nc, err := netcdf.Open(tmp.Name())
	if err != nil {
		return nil, fmt.Errorf("netcdf open: %w", err)
	}
	defer nc.Close()

	timeAxis, err := readFloat64Var(nc, "time")
	if err != nil {
		return nil, err
	}
	lats, err := readFloat64Var(nc, "latitude")
	if err != nil {
		return nil, err
	}
	lons, err := readFloat64Var(nc, "longitude")
	if err != nil {
		return nil, err
	}

	uVar, err := nc.GetVariable("var33")
	if err != nil {
		return nil, fmt.Errorf("var33 (u-component): %w", err)
	}
	vVar, err := nc.GetVariable("var34")
	if err != nil {
		return nil, fmt.Errorf("var34 (v-component): %w", err)
	}

	uAll, ok := uVar.Values.([][][][]float32)
	if !ok {
		return nil, fmt.Errorf("var33 unexpected type %T", uVar.Values)
	}
	vAll, ok := vVar.Values.([][][][]float32)
	if !ok {
		return nil, fmt.Errorf("var34 unexpected type %T", vVar.Values)
	}

	// Dernier timestep, premier (et seul après subset) niveau.
	tIdx := len(uAll) - 1
	if tIdx < 0 || len(uAll[tIdx]) == 0 {
		return nil, fmt.Errorf("var33 empty")
	}
	uLat := uAll[tIdx][0]
	vLat := vAll[tIdx][0]
	height := len(uLat)
	if height == 0 {
		return nil, fmt.Errorf("var33 zero rows")
	}
	width := len(uLat[0])

	// Aplatir en row-major. On veut : du nord au sud (lat décroissante en
	// lignes, ce qui convient à un canvas top→bottom) et d'ouest à est
	// (lon croissante en colonnes). On vérifie l'ordre des axes en lisant
	// lats/lons et on inverse au besoin pour l'orientation canvas.
	flipLat := len(lats) >= 2 && lats[0] < lats[len(lats)-1]
	flipLon := len(lons) >= 2 && lons[0] > lons[len(lons)-1]

	u := make([]float32, width*height)
	v := make([]float32, width*height)
	var maxSpeed float64
	for j := 0; j < height; j++ {
		jr := j
		if flipLat {
			jr = height - 1 - j
		}
		for i := 0; i < width; i++ {
			ir := i
			if flipLon {
				ir = width - 1 - i
			}
			uv := uLat[jr][ir]
			vv := vLat[jr][ir]
			u[j*width+i] = uv
			v[j*width+i] = vv
			s := math.Hypot(float64(uv), float64(vv))
			if s > maxSpeed {
				maxSpeed = s
			}
		}
	}

	// Conversion timestep en ISO.
	timeISO := ""
	if tIdx < len(timeAxis) {
		timeISO = hoursSince1900ToISO(timeAxis[tIdx])
	}

	return &WindGrid{
		CoverageID: coverageID,
		TimeISO:    timeISO,
		LevelPa:    level,
		Bbox:       bbox,
		Width:      width,
		Height:     height,
		SpeedMax:   maxSpeed,
		U:          u,
		V:          v,
	}, nil
}

func readFloat64Var(nc api.Group, name string) ([]float64, error) {
	v, err := nc.GetVariable(name)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	switch xs := v.Values.(type) {
	case []float64:
		return xs, nil
	case []float32:
		out := make([]float64, len(xs))
		for i, x := range xs {
			out[i] = float64(x)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("%s: unexpected type %T", name, v.Values)
	}
}

// hoursSince1900ToISO convertit "hours since 1900-01-01 00:00:00" en ISO.
func hoursSince1900ToISO(h float64) string {
	epoch := time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)
	t := epoch.Add(time.Duration(h * float64(time.Hour)))
	return t.UTC().Format("2006-01-02T15:04:05Z")
}
