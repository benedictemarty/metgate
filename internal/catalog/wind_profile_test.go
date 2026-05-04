package catalog

import (
	"math"
	"testing"
)

func TestFlToNearestPressurePa(t *testing.T) {
	cases := []struct {
		fl   int
		want int
	}{
		{0, 100000},   // surface → 1000 hPa
		{50, 85000},   // FL050 → 850 hPa
		{100, 70000},  // FL100 → 700 hPa
		{200, 45000},  // FL200 entre {180,50000} et {208,45000} → plus proche de 208
		{350, 25000},  // FL350 → 250 hPa
		{400, 20000},  // FL400 → 200 hPa
		{50000, 1000}, // hors plage → plus haute pression dispo (mini Pa)
	}
	for _, c := range cases {
		got := flToNearestPressurePa(c.fl)
		if got != c.want {
			t.Errorf("FL%d: got %d Pa, want %d Pa", c.fl, got, c.want)
		}
	}
}

func TestBearingDegRoute(t *testing.T) {
	cases := []struct {
		name             string
		lat1, lon1       float64
		lat2, lon2       float64
		want             float64
		eps              float64
	}{
		{"nord_équateur", 0, 0, 1, 0, 0, 0.5},
		{"sud_équateur", 1, 0, 0, 0, 180, 0.5},
		{"est_équateur", 0, 0, 0, 1, 90, 0.5},
		{"ouest_équateur", 0, 1, 0, 0, 270, 0.5},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := bearingDegRoute(c.lat1, c.lon1, c.lat2, c.lon2)
			if math.Abs(got-c.want) > c.eps {
				t.Errorf("got %v°, want %v° ±%v", got, c.want, c.eps)
			}
		})
	}
}

// TestSampleStepUV : sur une grille synthétique 4x4 où u=v=10 partout,
// l'interpolation bilinéaire au centre doit retourner (10, 10).
func TestSampleStepUV(t *testing.T) {
	w, h := 4, 4
	u := make([]float32, w*h)
	v := make([]float32, w*h)
	for i := range u {
		u[i] = 10
		v[i] = 10
	}
	grid := &WindGrid{
		Bbox:   [4]float64{0, 0, 10, 10},
		Width:  w,
		Height: h,
	}
	step := WindStep{U: u, V: v}

	t.Run("centre_grille", func(t *testing.T) {
		uu, vv, ok := sampleStepUV(grid, step, 5, 5)
		if !ok {
			t.Fatal("sampling au centre doit réussir")
		}
		if math.Abs(uu-10) > 0.01 || math.Abs(vv-10) > 0.01 {
			t.Errorf("got u=%v v=%v, want (10, 10)", uu, vv)
		}
	})
	t.Run("hors_bbox", func(t *testing.T) {
		_, _, ok := sampleStepUV(grid, step, 50, 50)
		if ok {
			t.Error("sampling hors bbox doit retourner ok=false")
		}
	})
}

// TestSampleStepUV_Gradient : vérifie le bilinéaire avec un gradient simple
// (u croît linéairement avec x).
func TestSampleStepUV_Gradient(t *testing.T) {
	// Grille 3x3 sur bbox [0,0,2,2]. u(x,y) = x.
	w, h := 3, 3
	u := []float32{
		0, 1, 2,
		0, 1, 2,
		0, 1, 2,
	}
	v := make([]float32, w*h)
	grid := &WindGrid{
		Bbox:   [4]float64{0, 0, 2, 2},
		Width:  w,
		Height: h,
	}
	step := WindStep{U: u, V: v}

	uu, _, ok := sampleStepUV(grid, step, 1.0, 0.5)
	if !ok {
		t.Fatal("sampling intérieur doit réussir")
	}
	// À lon=0.5 (entre col 0 et col 1) on attend u ≈ 0.5.
	if math.Abs(uu-0.5) > 0.05 {
		t.Errorf("u(0.5) = %v, attendu ≈ 0.5", uu)
	}
}

func TestParseISOToUnixMs(t *testing.T) {
	cases := []struct {
		name string
		in   string
		ok   bool
	}{
		{"compact", "2026-05-01T10:00:00Z", true},
		{"avec_ms", "2026-05-01T10:00:00.000Z", true},
		{"rfc3339_offset", "2026-05-01T12:00:00+02:00", true},
		{"vide", "", false},
		{"non_iso", "not a date", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, ok := parseISOToUnixMs(c.in)
			if ok != c.ok {
				t.Errorf("got ok=%v, want %v", ok, c.ok)
			}
		})
	}
}

func TestNearestUnixIndex(t *testing.T) {
	times := []int64{1000, 2000, 3000, 4000}
	cases := []struct {
		target int64
		want   int
	}{
		{500, 0},
		{1100, 0},
		{1600, 1}, // 1600 vs 1000 = 600, vs 2000 = 400 → 1
		{3500, 2}, // 3500 vs 3000 = 500, vs 4000 = 500 → first wins → 2
		{9999, 3},
	}
	for _, c := range cases {
		got := nearestUnixIndex(times, c.target)
		if got != c.want {
			t.Errorf("target %d: got %d, want %d", c.target, got, c.want)
		}
	}
}
