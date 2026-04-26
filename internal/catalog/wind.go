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

// WindGrid récupère le dernier coverage du dataset (WIND ou JET), fait un
// GetCoverage subsetté (niveau pour WIND, bbox spatial), décode le NetCDF
// et renvoie la grille u,v.
//
// Datasets supportés :
//   - "WIND" (default) : vent par niveau de pression, 29 niveaux dispos
//   - "JET"             : vent à un seul niveau (jet stream), level ignoré
func (s *Service) WindGrid(
	ctx context.Context,
	dataset string,
	levelPa float64,
	bbox [4]float64,
	allSteps bool,
) (*WindGrid, error) {
	prefix := "WIND"
	if dataset == "JET" {
		prefix = "JET"
	}
	if levelPa <= 0 {
		levelPa = 85000
	}

	coverageID, err := s.latestCoverageID(ctx, prefix)
	if err != nil {
		return nil, fmt.Errorf("find latest %s: %w", prefix, err)
	}

	q := url.Values{}
	q.Set("service", "WCS")
	q.Set("version", "2.0.1")
	q.Set("request", "GetCoverage")
	q.Set("coverageId", coverageID)
	if prefix == "WIND" {
		// Le coverage WIND est multi-niveaux ; on subset au niveau demandé.
		// JET est déjà à un seul niveau, level n'est pas un axe à subsetter.
		q.Add("subset", fmt.Sprintf("level(%g)", levelPa))
	}
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

	effectiveLevel := levelPa
	if prefix == "JET" {
		effectiveLevel = 0 // JET = single level, niveau "n/a"
	}
	return decodeWindNetCDF(coverageID, effectiveLevel, bbox, resp.Body, allSteps)
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

// tempNetCDF est un wrapper léger autour d'un fichier temporaire qui contient
// le NetCDF retourné par MetGate. La lib batchatco/go-native-netcdf veut un
// chemin sur disque, pas un reader.
type tempNetCDF struct {
	path string
}

func (t *tempNetCDF) cleanup() {
	if t.path != "" {
		_ = os.Remove(t.path)
	}
}

func writeTempNetCDF(body []byte) (*tempNetCDF, error) {
	tmp, err := os.CreateTemp("", "metgate-nc-*.nc")
	if err != nil {
		return nil, err
	}
	defer tmp.Close()
	if _, err := io.Copy(tmp, bytes.NewReader(body)); err != nil {
		_ = os.Remove(tmp.Name())
		return nil, err
	}
	return &tempNetCDF{path: tmp.Name()}, nil
}

func openNetCDF(path string) (api.Group, error) {
	return netcdf.Open(path)
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

	// Garde-fou : MetGate (cas JET) utilise une "fill value" géante pour les
	// pixels hors-domaine (~2.47e+34 m/s observé). Le record absolu de vent
	// terrestre est ~140 m/s ; on traite comme manquant tout ce qui dépasse
	// un seuil très large (200 m/s ≈ 388 kt) et on les rabat à 0 pour ne
	// pas casser les particules ni gonfler speed_max_ms.
	const maxRealisticWind = 200.0
	clean := func(x float32) float32 {
		ax := x
		if ax < 0 {
			ax = -ax
		}
		if math.IsNaN(float64(x)) || float64(ax) > maxRealisticWind {
			return 0
		}
		return x
	}

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
				uv := clean(uLat[jr][ir])
				vv := clean(vLat[jr][ir])
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
