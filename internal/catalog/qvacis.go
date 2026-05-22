package catalog

import (
	"context"
	"fmt"
	"math"
	"net/url"
	"strings"
	"time"

	"github.com/bmarty/metgate/internal/ncutil"
)

// QvacisStep est un timestep d'un coverage QVACIS pour un FL donné. Conc est
// la concentration de cendres en mg/m³, row-major (lat top→bottom, lon w→e).
type QvacisStep struct {
	TimeISO  string    `json:"time"`
	ConcMin  float64   `json:"conc_min_mg_m3"`
	ConcMax  float64   `json:"conc_max_mg_m3"`
	Conc     []float32 `json:"conc"`
	HasAsh   bool      `json:"has_ash"` // au moins 1 pixel >= 0.001 mg/m³
}

type QvacisGrid struct {
	CoverageID  string       `json:"coverage_id"`
	Dataset     string       `json:"dataset"`      // DETERMINISTIC | PROBABILISTIC
	FlightLevel int          `json:"flight_level"` // 25..575 par pas de 50
	Bbox        [4]float64   `json:"bbox"`         // bbox effective renvoyée
	Width       int          `json:"width"`
	Height      int          `json:"height"`
	Steps       []QvacisStep `json:"steps"`
	CurrentIdx  int          `json:"current_idx"`
}

// QVACISFlightLevels est la liste des FL disponibles dans les coverages
// QVACIS (centre de couches de 50FL d'épaisseur, en centaines de pieds).
var QVACISFlightLevels = []int{25, 75, 125, 175, 225, 275, 325, 375, 425, 475, 525, 575}

// nearestQvacisFL retourne le FL valide le plus proche du FL demandé.
func nearestQvacisFL(fl int) int {
	best := QVACISFlightLevels[0]
	bestDiff := abs(fl - best)
	for _, v := range QVACISFlightLevels[1:] {
		d := abs(fl - v)
		if d < bestDiff {
			best = v
			bestDiff = d
		}
	}
	return best
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// QvacisGrid récupère le coverage QVACIS le plus récent (dataset = DETERMINISTIC
// ou PROBABILISTIC) au flight_level demandé (rabat sur le plus proche valide).
func (s *Service) QvacisGrid(
	ctx context.Context,
	dataset string,
	flightLevel int,
	bbox [4]float64,
) (*QvacisGrid, error) {
	prefix := "QVACISDETERMINISTIC"
	if strings.EqualFold(dataset, "PROBABILISTIC") {
		prefix = "QVACISPROBABILISTIC"
	}
	fl := nearestQvacisFL(flightLevel)

	coverageID, err := s.latestCoverageID(ctx, prefix)
	if err != nil {
		return nil, fmt.Errorf("find latest %s: %w", prefix, err)
	}

	q := url.Values{}
	q.Set("service", "WCS")
	q.Set("version", "2.0.1")
	q.Set("request", "GetCoverage")
	q.Set("coverageId", coverageID)
	q.Add("subset", fmt.Sprintf("flight_level(%d)", fl))
	q.Add("subset", fmt.Sprintf("longitude(%g,%g)", bbox[0], bbox[2]))
	q.Add("subset", fmt.Sprintf("latitude(%g,%g)", bbox[1], bbox[3]))

	wcsCtx, wcsCancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer wcsCancel()
	resp, err := s.fetchCached(wcsCtx, "/broker_service/WCS", q)
	if err != nil {
		return nil, err
	}
	if resp.Status != 200 {
		return nil, fmt.Errorf("WCS GetCoverage %s: status %d (%q)",
			coverageID, resp.Status, truncate(resp.Body, 200))
	}

	return decodeQvacisNetCDF(coverageID, prefix, fl, bbox, resp.Body)
}

func decodeQvacisNetCDF(
	coverageID string,
	dataset string,
	fl int,
	bbox [4]float64,
	body []byte,
) (*QvacisGrid, error) {
	nc, cleanup, err := ncutil.OpenBytes(body)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	// time est en minutes since 1970-01-01 (Unix epoch minutes), int32.
	tv, err := nc.GetVariable("time")
	if err != nil {
		return nil, err
	}
	timeMin, err := asInt64Slice(tv.Values)
	if err != nil {
		return nil, fmt.Errorf("time: %w", err)
	}

	lats, err := readFloat64Var(nc, "latitude")
	if err != nil {
		return nil, err
	}
	lons, err := readFloat64Var(nc, "longitude")
	if err != nil {
		return nil, err
	}

	v, err := nc.GetVariable("ash_concentration")
	if err != nil {
		return nil, fmt.Errorf("ash_concentration: %w", err)
	}
	all, ok := v.Values.([][][][]float32)
	if !ok {
		return nil, fmt.Errorf("ash_concentration unexpected type %T", v.Values)
	}

	if len(all) == 0 || len(all[0]) == 0 || len(all[0][0]) == 0 {
		return nil, fmt.Errorf("ash_concentration empty")
	}
	height := len(all[0][0])
	width := len(all[0][0][0])

	flipLat := len(lats) >= 2 && lats[0] < lats[len(lats)-1]
	flipLon := len(lons) >= 2 && lons[0] > lons[len(lons)-1]

	flatten := func(t int) (conc []float32, mn, mx float64, hasAsh bool) {
		src := all[t][0] // 1 seul flight_level après subset
		conc = make([]float32, width*height)
		mn, mx = math.Inf(1), math.Inf(-1)
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
				x := src[jr][ir]
				if math.IsNaN(float64(x)) || float64(x) > 1e10 {
					conc[j*width+i] = 0
					continue
				}
				if x < 0 {
					x = 0
				}
				conc[j*width+i] = x
				f := float64(x)
				if f < mn {
					mn = f
				}
				if f > mx {
					mx = f
				}
				if f >= 0.001 {
					hasAsh = true
				}
			}
		}
		if math.IsInf(mn, 1) {
			mn = 0
		}
		return conc, mn, mx, hasAsh
	}

	steps := make([]QvacisStep, 0, len(all))
	for t := 0; t < len(all); t++ {
		c, mn, mx, hasAsh := flatten(t)
		ts := ""
		if t < len(timeMin) {
			ts = unixMinutesToISO(timeMin[t])
		}
		steps = append(steps, QvacisStep{
			TimeISO: ts,
			ConcMin: mn,
			ConcMax: mx,
			Conc:    c,
			HasAsh:  hasAsh,
		})
	}

	// Pas de "now" exact dans QVACIS time-axis : on prend le step dont la
	// minute Unix est la plus proche de l'actuelle.
	nowMin := time.Now().UTC().Unix() / 60
	currentIdx := 0
	bestDiff := int64(math.MaxInt64)
	for i, m := range timeMin {
		d := abs64(m - nowMin)
		if d < bestDiff {
			currentIdx = i
			bestDiff = d
		}
	}

	return &QvacisGrid{
		CoverageID:  coverageID,
		Dataset:     dataset,
		FlightLevel: fl,
		Bbox:        bbox,
		Width:       width,
		Height:      height,
		Steps:       steps,
		CurrentIdx:  currentIdx,
	}, nil
}

func abs64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

// asInt64Slice convertit un slice de int32 ou int64 ou float64 en []int64.
func asInt64Slice(v any) ([]int64, error) {
	switch xs := v.(type) {
	case []int32:
		out := make([]int64, len(xs))
		for i, x := range xs {
			out[i] = int64(x)
		}
		return out, nil
	case []int64:
		return xs, nil
	case []float64:
		out := make([]int64, len(xs))
		for i, x := range xs {
			out[i] = int64(x)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("unexpected type %T", v)
	}
}

func unixMinutesToISO(minutes int64) string {
	t := time.Unix(minutes*60, 0).UTC()
	return t.Format("2006-01-02T15:04:05Z")
}
