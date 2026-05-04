package catalog

import (
	"context"
	"fmt"
	"math"
	"net/url"

	"github.com/bmarty/metgate/internal/ncutil"
)

// TropoStep est un timestep d'un coverage TROPO. Alt est l'altitude de la
// tropopause en mètres (row-major, lat top→bottom, lon west→east).
type TropoStep struct {
	TimeISO string    `json:"time"`
	AltMin  float64   `json:"alt_min_m"`
	AltMax  float64   `json:"alt_max_m"`
	Alt     []float32 `json:"alt"`
}

// TropoGrid est la donnée tropopause extraite du coverage WCS TROPO sur une
// bbox. La grille (width, height, bbox) est commune à tous les timesteps.
type TropoGrid struct {
	CoverageID string      `json:"coverage_id"`
	Bbox       [4]float64  `json:"bbox"`
	Width      int         `json:"width"`
	Height     int         `json:"height"`
	Steps      []TropoStep `json:"steps"`
	CurrentIdx int         `json:"current_idx"`
}

func (s *Service) TropoGrid(ctx context.Context, bbox [4]float64) (*TropoGrid, error) {
	coverageID, err := s.latestCoverageID(ctx, "TROPO")
	if err != nil {
		return nil, fmt.Errorf("find latest TROPO: %w", err)
	}

	q := url.Values{}
	q.Set("service", "WCS")
	q.Set("version", "2.0.1")
	q.Set("request", "GetCoverage")
	q.Set("coverageId", coverageID)
	q.Add("subset", fmt.Sprintf("longitude(%g,%g)", bbox[0], bbox[2]))
	q.Add("subset", fmt.Sprintf("latitude(%g,%g)", bbox[1], bbox[3]))

	resp, err := s.fetchCached(ctx, "/broker_service/WCS", q)
	if err != nil {
		return nil, err
	}
	if resp.Status != 200 {
		return nil, fmt.Errorf("WCS GetCoverage TROPO: status %d (%q)",
			resp.Status, truncate(resp.Body, 200))
	}
	return decodeTropoNetCDF(coverageID, bbox, resp.Body)
}

func decodeTropoNetCDF(coverageID string, bbox [4]float64, body []byte) (*TropoGrid, error) {
	nc, cleanup, err := ncutil.OpenBytes(body)
	if err != nil {
		return nil, err
	}
	defer cleanup()

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

	v, err := nc.GetVariable("var5")
	if err != nil {
		return nil, fmt.Errorf("var5 (tropopause altitude): %w", err)
	}
	all, ok := v.Values.([][][]float32)
	if !ok {
		return nil, fmt.Errorf("var5 unexpected type %T", v.Values)
	}

	if len(all) == 0 || len(all[0]) == 0 {
		return nil, fmt.Errorf("var5 empty grid")
	}
	height := len(all[0])
	width := len(all[0][0])
	if height == 0 || width == 0 {
		return nil, fmt.Errorf("var5 zero dimension")
	}

	flipLat := len(lats) >= 2 && lats[0] < lats[len(lats)-1]
	flipLon := len(lons) >= 2 && lons[0] > lons[len(lons)-1]

	flatten := func(t int) (alt []float32, mn, mx float64) {
		src := all[t]
		alt = make([]float32, width*height)
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
				if math.IsNaN(float64(x)) || float64(x) > 1e10 || float64(x) < -1e6 {
					alt[j*width+i] = float32(math.NaN())
					continue
				}
				alt[j*width+i] = x
				f := float64(x)
				if f < mn {
					mn = f
				}
				if f > mx {
					mx = f
				}
			}
		}
		return alt, mn, mx
	}

	steps := make([]TropoStep, 0, len(all))
	for t := 0; t < len(all); t++ {
		a, mn, mx := flatten(t)
		ts := ""
		if t < len(timeAxis) {
			ts = hoursSince1900ToISO(timeAxis[t])
		}
		steps = append(steps, TropoStep{
			TimeISO: ts,
			AltMin:  mn,
			AltMax:  mx,
			Alt:     a,
		})
	}

	currentIdx := nearestTimeIndex(timeAxis, nowHoursSince1900())
	if currentIdx < 0 {
		currentIdx = 0
	}

	return &TropoGrid{
		CoverageID: coverageID,
		Bbox:       bbox,
		Width:      width,
		Height:     height,
		Steps:      steps,
		CurrentIdx: currentIdx,
	}, nil
}
