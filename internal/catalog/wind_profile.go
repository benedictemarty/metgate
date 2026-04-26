package catalog

import (
	"context"
	"fmt"
	"math"
	"time"
)

// WindAtWaypoint est l'état du vent au passage d'un waypoint, projeté sur la
// direction de l'avion (along-track / cross-track) en kt.
type WindAtWaypoint struct {
	SpeedKt    float64 `json:"speed_kt"`
	DirFromDeg float64 `json:"dir_from_deg"` // direction d'origine, 0=N, 90=E
	AlongKt    float64 `json:"along_track_kt"`
	CrossKt    float64 `json:"cross_track_kt"`
}

// WindProfile décrit le vent rencontré le long d'un plan de vol.
type WindProfile struct {
	CoverageID  string           `json:"coverage_id"`
	LevelPa     int              `json:"level_pa"`
	Waypoints   []WindAtWaypoint `json:"waypoints"`
	AlongMeanKt float64          `json:"along_mean_kt"` // moyenne sur la route (positif=gain)
	CrossMeanKt float64          `json:"cross_mean_kt"`
	DeltaMin    float64          `json:"delta_min"`     // signé. >0 = gain, <0 = perte
	GsKt        float64          `json:"gs_kt"`
}

// flLevels mappe FL → niveau de pression MetGate le plus proche (Pa).
var flLevels = []struct {
	fl int
	pa int
}{
	{0, 100000}, {15, 95000}, {25, 92500}, {33, 90000}, {50, 85000},
	{63, 80000}, {80, 75000}, {100, 70000}, {118, 65000}, {138, 60000},
	{160, 55000}, {180, 50000}, {208, 45000}, {235, 40000}, {265, 35000},
	{300, 30000}, {321, 27500}, {340, 25000}, {361, 22500}, {390, 20000},
	{416, 17500}, {447, 15000}, {487, 12500}, {531, 10000}, {620, 7000},
	{690, 5000}, {800, 3000}, {885, 2000}, {1020, 1000},
}

// flToNearestPressurePa retourne le niveau MetGate le plus proche du FL donné.
func flToNearestPressurePa(fl int) int {
	best := flLevels[0]
	bestDiff := abs(fl - best.fl)
	for _, l := range flLevels[1:] {
		d := abs(fl - l.fl)
		if d < bestDiff {
			best = l
			bestDiff = d
		}
	}
	return best.pa
}

// RouteWindProfile calcule le profil de vent rencontré sur une route déjà
// planifiée. Récupère un coverage WIND multi-step au FL cruise (le plus
// pertinent pour le calcul de carburant), sample chaque waypoint au step
// le plus proche temporellement, et calcule along/cross/delta_min.
func (s *Service) RouteWindProfile(ctx context.Context, plan *RoutePlan) (*WindProfile, error) {
	if plan == nil || len(plan.Waypoints) < 2 {
		return nil, fmt.Errorf("plan de vol invalide")
	}

	// 1. Bbox de la route, élargie de 1° pour avoir de la marge bilinéaire.
	bbox := routeBbox(plan, 1.0)
	levelPa := flToNearestPressurePa(plan.FL)

	// 2. Fetch WIND multi-step au FL cruise.
	grid, err := s.WindGrid(ctx, "WIND", float64(levelPa), bbox, true)
	if err != nil {
		return nil, fmt.Errorf("fetch wind: %w", err)
	}
	if len(grid.Steps) == 0 {
		return nil, fmt.Errorf("aucun step wind")
	}

	stepTimesUnix := make([]int64, len(grid.Steps))
	for i, st := range grid.Steps {
		t, _ := parseISOToUnixMs(st.TimeISO)
		stepTimesUnix[i] = t
	}

	// 3. Pour chaque waypoint, calcul track (vers le suivant), sample u/v,
	//    projette en along/cross.
	wps := make([]WindAtWaypoint, len(plan.Waypoints))
	var alongSum, crossSum, totalDist, deltaMin float64
	for i, w := range plan.Waypoints {
		// Track : du waypoint courant vers le suivant. Pour le dernier, on
		// reprend le track du segment précédent.
		trackDeg := 0.0
		if i+1 < len(plan.Waypoints) {
			trackDeg = bearingDegRoute(w.Lat, w.Lon, plan.Waypoints[i+1].Lat, plan.Waypoints[i+1].Lon)
		} else if i > 0 {
			trackDeg = bearingDegRoute(plan.Waypoints[i-1].Lat, plan.Waypoints[i-1].Lon, w.Lat, w.Lon)
		}

		// Step nearest temporellement.
		wpUnix, _ := parseISOToUnixMs(w.TimeISO)
		stepIdx := nearestUnixIndex(stepTimesUnix, wpUnix)
		step := grid.Steps[stepIdx]

		// Sample bilinéaire dans le step.
		uMs, vMs, ok := sampleStepUV(grid, step, w.Lat, w.Lon)
		if !ok {
			continue
		}

		uKt := uMs * 1.94384
		vKt := vMs * 1.94384
		speedKt := math.Hypot(uKt, vKt)
		dirFrom := math.Mod(math.Atan2(-uKt, -vKt)*180/math.Pi+360, 360)

		// Track radians, vecteur unitaire dans le sens de l'avion :
		// vx = sin(track) (est), vy = cos(track) (nord)
		tr := trackDeg * math.Pi / 180
		vx := math.Sin(tr)
		vy := math.Cos(tr)
		// Along-track : projection du vecteur vent sur la direction de
		// l'avion (positif = vent arrière, gain de temps).
		along := uKt*vx + vKt*vy
		// Cross-track convention pilote : positif = vent VENANT de la droite
		// (donc soufflant vers la gauche). Le right-vector pilote est
		// (cos(track), -sin(track)) = (vy, -vx). Le vent VENANT de la droite
		// est un vecteur dirigé vers -right, donc on projette -vent sur
		// right : -(u*vy - v*vx) = v*vx - u*vy.
		cross := vKt*vx - uKt*vy

		wps[i] = WindAtWaypoint{
			SpeedKt:    speedKt,
			DirFromDeg: dirFrom,
			AlongKt:    along,
			CrossKt:    cross,
		}

		// Cumul pondéré par longueur de segment pour la moyenne.
		var segDist float64
		if i+1 < len(plan.Waypoints) {
			segDist = plan.Waypoints[i+1].DistNM - w.DistNM
		}
		if segDist > 0 {
			alongSum += along * segDist
			crossSum += cross * segDist
			totalDist += segDist
			gs := plan.GSkt
			eff := gs + along
			if eff > 0 {
				dt := segDist*(1/gs-1/eff) * 60 // min
				deltaMin += dt
			}
		}
	}

	alongMean := 0.0
	crossMean := 0.0
	if totalDist > 0 {
		alongMean = alongSum / totalDist
		crossMean = crossSum / totalDist
	}

	return &WindProfile{
		CoverageID:  grid.CoverageID,
		LevelPa:     levelPa,
		Waypoints:   wps,
		AlongMeanKt: alongMean,
		CrossMeanKt: crossMean,
		DeltaMin:    deltaMin,
		GsKt:        plan.GSkt,
	}, nil
}

// routeBbox calcule la bbox des waypoints, étendue de pad degrés.
func routeBbox(plan *RoutePlan, pad float64) [4]float64 {
	lonMin, latMin := math.Inf(1), math.Inf(1)
	lonMax, latMax := math.Inf(-1), math.Inf(-1)
	for _, w := range plan.Waypoints {
		if w.Lon < lonMin {
			lonMin = w.Lon
		}
		if w.Lon > lonMax {
			lonMax = w.Lon
		}
		if w.Lat < latMin {
			latMin = w.Lat
		}
		if w.Lat > latMax {
			latMax = w.Lat
		}
	}
	return [4]float64{lonMin - pad, latMin - pad, lonMax + pad, latMax + pad}
}

func bearingDegRoute(lat1, lon1, lat2, lon2 float64) float64 {
	p1 := lat1 * math.Pi / 180
	p2 := lat2 * math.Pi / 180
	dl := (lon2 - lon1) * math.Pi / 180
	y := math.Sin(dl) * math.Cos(p2)
	x := math.Cos(p1)*math.Sin(p2) - math.Sin(p1)*math.Cos(p2)*math.Cos(dl)
	b := math.Atan2(y, x) * 180 / math.Pi
	return math.Mod(b+360, 360)
}

// sampleStepUV interpole bilinéairement (u, v) m/s à la position (lat, lon).
// La grille est row-major lat-top→bottom dans grid.Bbox.
func sampleStepUV(grid *WindGrid, step WindStep, lat, lon float64) (u, v float64, ok bool) {
	bbox := grid.Bbox
	if lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3] {
		return 0, 0, false
	}
	w := grid.Width
	h := grid.Height
	fx := (lon - bbox[0]) / (bbox[2] - bbox[0]) * float64(w-1)
	fy := (bbox[3] - lat) / (bbox[3] - bbox[1]) * float64(h-1)
	x := int(math.Floor(fx))
	y := int(math.Floor(fy))
	if x < 0 || x >= w-1 || y < 0 || y >= h-1 {
		return 0, 0, false
	}
	tx := fx - float64(x)
	ty := fy - float64(y)
	idx := func(j, i int) int { return j*w + i }
	uu := float64(step.U[idx(y, x)])*(1-tx)*(1-ty) +
		float64(step.U[idx(y, x+1)])*tx*(1-ty) +
		float64(step.U[idx(y+1, x)])*(1-tx)*ty +
		float64(step.U[idx(y+1, x+1)])*tx*ty
	vv := float64(step.V[idx(y, x)])*(1-tx)*(1-ty) +
		float64(step.V[idx(y, x+1)])*tx*(1-ty) +
		float64(step.V[idx(y+1, x)])*(1-tx)*ty +
		float64(step.V[idx(y+1, x+1)])*tx*ty
	return uu, vv, true
}

func parseISOToUnixMs(iso string) (int64, bool) {
	for _, f := range []string{"2006-01-02T15:04:05Z", "2006-01-02T15:04:05.000Z"} {
		if t, err := time.Parse(f, iso); err == nil {
			return t.UnixMilli(), true
		}
	}
	if t, err := time.Parse(time.RFC3339, iso); err == nil {
		return t.UnixMilli(), true
	}
	return 0, false
}

func nearestUnixIndex(times []int64, target int64) int {
	if len(times) == 0 {
		return 0
	}
	best := 0
	bestDiff := absI64(times[0] - target)
	for i := 1; i < len(times); i++ {
		d := absI64(times[i] - target)
		if d < bestDiff {
			best = i
			bestDiff = d
		}
	}
	return best
}

func absI64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

