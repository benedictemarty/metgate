package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"
)

// Aerodrome est un point d'aérodrome identifié par son code OACI.
type Aerodrome struct {
	ICAO string  `json:"icao"`
	Lon  float64 `json:"lon"`
	Lat  float64 `json:"lat"`
}

// RouteWaypoint est un point de la trajectoire grand cercle.
type RouteWaypoint struct {
	Lon     float64 `json:"lon"`
	Lat     float64 `json:"lat"`
	FL      int     `json:"fl"`
	TimeISO string  `json:"time"`
	DistNM  float64 `json:"dist_nm"`
}

// RoutePlan est le résultat d'un plan de vol simple : trajectoire grand
// cercle DEP→ARR à FL constant, GS constant.
type RoutePlan struct {
	Dep       Aerodrome       `json:"dep"`
	Arr       Aerodrome       `json:"arr"`
	FL        int             `json:"fl"`
	GSkt      float64         `json:"gs_kt"`
	DepTime   string          `json:"dep_time"`
	ArrTime   string          `json:"arr_time"`
	DistNM    float64         `json:"distance_nm"`
	DurMin    float64         `json:"duration_min"`
	Waypoints []RouteWaypoint `json:"waypoints"`
}

const earthRadiusNM = 3440.065

// ICAOIndex construit ICAO → (lon, lat) depuis les METAR_last + TAF_last +
// SPECI_last en cache. Sources concaténées : si un même ICAO apparaît dans
// plusieurs feed, on garde la 1ère position rencontrée (METAR > TAF > SPECI).
func (s *Service) ICAOIndex(ctx context.Context) (map[string][2]float64, error) {
	idx := make(map[string][2]float64)
	for _, t := range []string{"METAR_last", "TAF_last", "SPECI_last"} {
		geo, _, err := s.FeatureGeoJSON(ctx, t, 2000)
		if err != nil {
			continue
		}
		var fc struct {
			Features []struct {
				Properties map[string]any `json:"properties"`
				Geometry   struct {
					Type        string    `json:"type"`
					Coordinates []float64 `json:"coordinates"`
				} `json:"geometry"`
			} `json:"features"`
		}
		if err := json.Unmarshal(geo, &fc); err != nil {
			continue
		}
		for _, f := range fc.Features {
			if f.Geometry.Type != "Point" || len(f.Geometry.Coordinates) < 2 {
				continue
			}
			icao, _ := f.Properties["locationIndicatorICAO"].(string)
			if icao == "" {
				continue
			}
			icao = strings.ToUpper(strings.TrimSpace(icao))
			if _, exists := idx[icao]; exists {
				continue
			}
			idx[icao] = [2]float64{f.Geometry.Coordinates[0], f.Geometry.Coordinates[1]}
		}
	}
	return idx, nil
}

// PlanRoute calcule un plan de vol grand cercle entre deux ICAO.
// gsKt par défaut 450 si <= 0, fl par défaut 350, nWaypoints 80.
func (s *Service) PlanRoute(
	ctx context.Context,
	depICAO, arrICAO string,
	fl int,
	gsKt float64,
	depTime time.Time,
	nWaypoints int,
) (*RoutePlan, error) {
	idx, err := s.ICAOIndex(ctx)
	if err != nil {
		return nil, err
	}
	dep := strings.ToUpper(strings.TrimSpace(depICAO))
	arr := strings.ToUpper(strings.TrimSpace(arrICAO))
	depPos, ok1 := idx[dep]
	arrPos, ok2 := idx[arr]
	if !ok1 {
		return nil, fmt.Errorf("ICAO %s introuvable dans le cache METAR/TAF/SPECI", dep)
	}
	if !ok2 {
		return nil, fmt.Errorf("ICAO %s introuvable dans le cache METAR/TAF/SPECI", arr)
	}
	if gsKt <= 0 {
		gsKt = 450
	}
	if fl <= 0 {
		fl = 350
	}
	if nWaypoints < 2 {
		nWaypoints = 80
	}
	if depTime.IsZero() {
		depTime = time.Now().UTC()
	}

	dist := gcDistance(depPos[1], depPos[0], arrPos[1], arrPos[0])
	durMin := dist / gsKt * 60

	wps := make([]RouteWaypoint, nWaypoints)
	for i := 0; i < nWaypoints; i++ {
		f := float64(i) / float64(nWaypoints-1)
		la, lo := gcInterpolate(depPos[1], depPos[0], arrPos[1], arrPos[0], f)
		ts := depTime.Add(time.Duration(f*durMin*float64(time.Minute))).UTC()
		wps[i] = RouteWaypoint{
			Lon:     lo,
			Lat:     la,
			FL:      fl,
			TimeISO: ts.Format("2006-01-02T15:04:05Z"),
			DistNM:  f * dist,
		}
	}

	return &RoutePlan{
		Dep:       Aerodrome{ICAO: dep, Lon: depPos[0], Lat: depPos[1]},
		Arr:       Aerodrome{ICAO: arr, Lon: arrPos[0], Lat: arrPos[1]},
		FL:        fl,
		GSkt:      gsKt,
		DepTime:   wps[0].TimeISO,
		ArrTime:   wps[nWaypoints-1].TimeISO,
		DistNM:    dist,
		DurMin:    durMin,
		Waypoints: wps,
	}, nil
}

// gcDistance retourne la distance grand cercle (NM) entre deux points en deg.
func gcDistance(lat1, lon1, lat2, lon2 float64) float64 {
	p1 := lat1 * math.Pi / 180
	p2 := lat2 * math.Pi / 180
	dp := (lat2 - lat1) * math.Pi / 180
	dl := (lon2 - lon1) * math.Pi / 180
	a := math.Sin(dp/2)*math.Sin(dp/2) +
		math.Cos(p1)*math.Cos(p2)*math.Sin(dl/2)*math.Sin(dl/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return earthRadiusNM * c
}

// gcInterpolate interpole sur le grand cercle entre deux points (slerp).
func gcInterpolate(lat1, lon1, lat2, lon2, f float64) (lat, lon float64) {
	d := gcDistance(lat1, lon1, lat2, lon2) / earthRadiusNM
	if d == 0 {
		return lat1, lon1
	}
	p1 := lat1 * math.Pi / 180
	p2 := lat2 * math.Pi / 180
	l1 := lon1 * math.Pi / 180
	l2 := lon2 * math.Pi / 180
	a := math.Sin((1-f)*d) / math.Sin(d)
	b := math.Sin(f*d) / math.Sin(d)
	x := a*math.Cos(p1)*math.Cos(l1) + b*math.Cos(p2)*math.Cos(l2)
	y := a*math.Cos(p1)*math.Sin(l1) + b*math.Cos(p2)*math.Sin(l2)
	z := a*math.Sin(p1) + b*math.Sin(p2)
	return math.Atan2(z, math.Sqrt(x*x+y*y)) * 180 / math.Pi,
		math.Atan2(y, x) * 180 / math.Pi
}
