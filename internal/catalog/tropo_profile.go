package catalog

import (
	"context"
	"fmt"
	"math"
)

// EnrichRouteWithTropo échantillonne la tropopause à chaque waypoint d'un
// plan de vol, en interpolant bilinéairement la grille WCS TROPO. Pour
// chaque waypoint, on prend le step temporel le plus proche du waypoint
// (la tropopause évolue lentement, mais la cohérence temporelle compte
// avec le profil vent et les SIGMET croisés). Le résultat est stocké
// directement dans plan.Waypoints[i].TropoAltM (pointeur nil si donnée
// non disponible).
func (s *Service) EnrichRouteWithTropo(ctx context.Context, plan *RoutePlan) error {
	if plan == nil || len(plan.Waypoints) == 0 {
		return fmt.Errorf("plan de vol invalide")
	}
	bbox := routeBbox(plan, 1.0)
	grid, err := s.TropoGrid(ctx, bbox)
	if err != nil {
		return fmt.Errorf("fetch tropo: %w", err)
	}
	if len(grid.Steps) == 0 {
		return fmt.Errorf("aucun step tropo")
	}

	stepTimesUnix := make([]int64, len(grid.Steps))
	for i, st := range grid.Steps {
		t, _ := parseISOToUnixMs(st.TimeISO)
		stepTimesUnix[i] = t
	}

	for i := range plan.Waypoints {
		w := &plan.Waypoints[i]
		wpUnix, _ := parseISOToUnixMs(w.TimeISO)
		alt, ok := sampleInterpolatedTropo(grid, stepTimesUnix, wpUnix, w.Lat, w.Lon)
		if !ok {
			continue
		}
		v := alt
		w.TropoAltM = &v
	}
	return nil
}

// sampleInterpolatedTropo interpole temporellement (linéaire entre les 2 steps
// encadrants) puis spatialement (bilinéaire) l'altitude tropopause. Cohérent
// avec sampleInterpolatedUV dans wind_profile.go.
func sampleInterpolatedTropo(grid *TropoGrid, stepTimesMs []int64, targetMs int64, lat, lon float64) (float64, bool) {
	n := len(stepTimesMs)
	if n == 0 {
		return 0, false
	}
	if n == 1 {
		return sampleTropoStep(grid, 0, lat, lon)
	}

	lo, hi := 0, n-1
	for lo < hi-1 {
		mid := (lo + hi) / 2
		if stepTimesMs[mid] <= targetMs {
			lo = mid
		} else {
			hi = mid
		}
	}
	if targetMs <= stepTimesMs[0] {
		return sampleTropoStep(grid, 0, lat, lon)
	}
	if targetMs >= stepTimesMs[n-1] {
		return sampleTropoStep(grid, n-1, lat, lon)
	}

	dt := float64(stepTimesMs[hi] - stepTimesMs[lo])
	if dt <= 0 {
		return sampleTropoStep(grid, lo, lat, lon)
	}
	alpha := float64(targetMs-stepTimesMs[lo]) / dt

	a0, ok0 := sampleTropoStep(grid, lo, lat, lon)
	a1, ok1 := sampleTropoStep(grid, hi, lat, lon)
	if !ok0 && !ok1 {
		return 0, false
	}
	if !ok0 {
		return a1, true
	}
	if !ok1 {
		return a0, true
	}
	return a0 + (a1-a0)*alpha, true
}

// sampleTropoStep interpole bilinéairement la tropopause à (lat, lon) dans
// le step donné. Les pixels NaN sont ignorés ; si moins de 2 voisins
// valides, on retourne false. La grille est row-major lat top→bottom,
// lon west→east, et `bbox = [lonMin, latMin, lonMax, latMax]`.
func sampleTropoStep(grid *TropoGrid, stepIdx int, lat, lon float64) (float64, bool) {
	if stepIdx < 0 || stepIdx >= len(grid.Steps) {
		return 0, false
	}
	if grid.Width < 2 || grid.Height < 2 {
		return 0, false
	}
	lonMin, latMin, lonMax, latMax := grid.Bbox[0], grid.Bbox[1], grid.Bbox[2], grid.Bbox[3]
	if lon < lonMin || lon > lonMax || lat < latMin || lat > latMax {
		return 0, false
	}

	u := (lon - lonMin) / (lonMax - lonMin) * float64(grid.Width-1)
	v := (latMax - lat) / (latMax - latMin) * float64(grid.Height-1)

	i0 := int(math.Floor(u))
	j0 := int(math.Floor(v))
	if i0 < 0 {
		i0 = 0
	}
	if j0 < 0 {
		j0 = 0
	}
	if i0 > grid.Width-2 {
		i0 = grid.Width - 2
	}
	if j0 > grid.Height-2 {
		j0 = grid.Height - 2
	}
	di := u - float64(i0)
	dj := v - float64(j0)

	alt := grid.Steps[stepIdx].Alt
	idx := func(j, i int) int { return j*grid.Width + i }
	a := float64(alt[idx(j0, i0)])
	b := float64(alt[idx(j0, i0+1)])
	c := float64(alt[idx(j0+1, i0)])
	d := float64(alt[idx(j0+1, i0+1)])

	// Bilinéaire avec gestion NaN : on moyenne les voisins valides.
	pts := [4]struct {
		val float64
		w   float64
	}{
		{a, (1 - di) * (1 - dj)},
		{b, di * (1 - dj)},
		{c, (1 - di) * dj},
		{d, di * dj},
	}
	var sum, wsum float64
	for _, p := range pts {
		if !math.IsNaN(p.val) {
			sum += p.val * p.w
			wsum += p.w
		}
	}
	if wsum < 0.25 {
		return 0, false
	}
	return sum / wsum, true
}
