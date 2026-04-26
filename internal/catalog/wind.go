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

// WindStep est un timestep individuel d'un coverage WIND. U et V sont en m/s,
// row-major (lat top→bottom, lon west→east), de taille width*height.
type WindStep struct {
	TimeISO  string    `json:"time"`         // YYYY-MM-DDTHH:MM:SSZ
	SpeedMax float64   `json:"speed_max_ms"` // max horizontal m/s
	U        []float32 `json:"u"`
	V        []float32 `json:"v"`
}

// WindGrid est la donnée vent extraite d'un GetCoverage WCS pour un niveau
// de pression et une bbox. La grille (width, height, bbox) est commune à
// tous les timesteps. Selon le param allSteps :
//   - false (default) : seul le step proche de now est renvoyé en haut
//     niveau (TimeISO/SpeedMax/U/V), Steps reste nil.
//   - true            : Steps contient tous les timesteps, et CurrentIdx
//     pointe sur celui le plus proche de now.
type WindGrid struct {
	CoverageID string     `json:"coverage_id"`
	LevelPa    float64    `json:"level_pa"`
	Bbox       [4]float64 `json:"bbox"`
	Width      int        `json:"width"`
	Height     int        `json:"height"`

	// Single-step (rétro-compat).
	TimeISO  string    `json:"time,omitempty"`
	SpeedMax float64   `json:"speed_max_ms,omitempty"`
	U        []float32 `json:"u,omitempty"`
	V        []float32 `json:"v,omitempty"`

	// Multi-step.
	Steps      []WindStep `json:"steps,omitempty"`
	CurrentIdx int        `json:"current_idx,omitempty"`
}

// WindGrid récupère le dernier coverage WIND, fait un GetCoverage subsetté
// (niveau + bbox), décode le NetCDF, et renvoie la grille u,v.
//
// Si allSteps==false : seul le pas le plus proche de now est renvoyé.
// Si allSteps==true  : tous les pas du coverage sont renvoyés, plus
// l'index du pas le plus proche de now (CurrentIdx).
func (s *Service) WindGrid(
	ctx context.Context,
	levelPa float64,
	bbox [4]float64,
	allSteps bool,
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

	return decodeWindNetCDF(coverageID, levelPa, bbox, resp.Body, allSteps)
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

// decodeWindNetCDF parse un NetCDF-4 (HDF5) MetGate et extrait u/v.
// Les variables var33 et var34 contiennent respectivement le vent zonal
// (u, m/s) et méridien (v, m/s) sur une grille [time][level][lat][lon].
func decodeWindNetCDF(
	coverageID string,
	level float64,
	bbox [4]float64,
	body []byte,
	allSteps bool,
) (*WindGrid, error) {
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

	if len(uAll) == 0 || len(uAll[0]) == 0 {
		return nil, fmt.Errorf("var33 empty grid")
	}
	height := len(uAll[0][0])
	if height == 0 {
		return nil, fmt.Errorf("var33 zero rows")
	}
	width := len(uAll[0][0][0])

	flipLat := len(lats) >= 2 && lats[0] < lats[len(lats)-1]
	flipLon := len(lons) >= 2 && lons[0] > lons[len(lons)-1]

	flatten := func(t int) (u, v []float32, maxSpeed float64) {
		uLat := uAll[t][0]
		vLat := vAll[t][0]
		u = make([]float32, width*height)
		v = make([]float32, width*height)
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
		return u, v, maxSpeed
	}

	currentIdx := nearestTimeIndex(timeAxis, nowHoursSince1900())
	if currentIdx < 0 {
		currentIdx = 0
	}

	out := &WindGrid{
		CoverageID: coverageID,
		LevelPa:    level,
		Bbox:       bbox,
		Width:      width,
		Height:     height,
	}

	if !allSteps {
		u, v, maxSpeed := flatten(currentIdx)
		out.TimeISO = hoursSince1900ToISO(timeAxis[currentIdx])
		out.SpeedMax = maxSpeed
		out.U = u
		out.V = v
		return out, nil
	}

	steps := make([]WindStep, 0, len(uAll))
	for t := 0; t < len(uAll); t++ {
		u, v, maxSpeed := flatten(t)
		ts := ""
		if t < len(timeAxis) {
			ts = hoursSince1900ToISO(timeAxis[t])
		}
		steps = append(steps, WindStep{
			TimeISO:  ts,
			SpeedMax: maxSpeed,
			U:        u,
			V:        v,
		})
	}
	out.Steps = steps
	out.CurrentIdx = currentIdx
	return out, nil
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

// nowHoursSince1900 retourne l'heure UTC courante exprimée comme "heures depuis
// 1900-01-01 00:00:00" (la convention employée par MetGate dans l'axe time).
func nowHoursSince1900() float64 {
	epoch := time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)
	return time.Since(epoch).Hours()
}

// nearestTimeIndex retourne l'index dans times le plus proche de target.
// times est supposé non vide. En cas d'égalité, retourne le plus petit index.
func nearestTimeIndex(times []float64, target float64) int {
	if len(times) == 0 {
		return -1
	}
	best := 0
	bestDiff := math.Abs(times[0] - target)
	for i := 1; i < len(times); i++ {
		d := math.Abs(times[i] - target)
		if d < bestDiff {
			best = i
			bestDiff = d
		}
	}
	return best
}
