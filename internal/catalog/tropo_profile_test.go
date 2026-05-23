package catalog

import (
	"math"
	"testing"
)

// grille synthétique 4×4 avec une valeur constante (sauf un pixel NaN au coin).
func makeTropoGrid(val float32, nanCorner bool) *TropoGrid {
	w, h := 4, 4
	alt := make([]float32, w*h)
	for i := range alt {
		alt[i] = val
	}
	if nanCorner {
		alt[0] = float32(math.NaN()) // coin top-left
	}
	steps := []TropoStep{
		{TimeISO: "2025-01-01T00:00:00Z", AltMin: float64(val), AltMax: float64(val), Alt: alt},
	}
	return &TropoGrid{
		Bbox:   [4]float64{-10, -10, 10, 10},
		Width:  w,
		Height: h,
		Steps:  steps,
	}
}

func TestSampleTropoStep_uniform(t *testing.T) {
	grid := makeTropoGrid(10000, false)
	got, ok := sampleTropoStep(grid, 0, 0, 0) // centre de la bbox
	if !ok {
		t.Fatal("sampleTropoStep: attendu ok=true, got false")
	}
	if math.Abs(got-10000) > 1 {
		t.Errorf("valeur attendue 10000, got %v", got)
	}
}

func TestSampleTropoStep_outOfBbox(t *testing.T) {
	grid := makeTropoGrid(10000, false)
	_, ok := sampleTropoStep(grid, 0, 50, 0) // lat=50 hors bbox[-10,10]
	if ok {
		t.Fatal("attendu ok=false pour point hors bbox")
	}
}

func TestSampleTropoStep_nanCorner(t *testing.T) {
	// Pixel top-left NaN, les 3 autres voisins valides → doit quand même retourner une valeur.
	grid := makeTropoGrid(10000, true)
	// On sample proche du coin top-left (lon=-9, lat=9 dans bbox [-10,-10,10,10])
	got, ok := sampleTropoStep(grid, 0, 8.5, -8.5)
	if !ok {
		t.Fatal("sampleTropoStep: NaN en v00 ne doit pas annuler le résultat si wsum >= 0.25")
	}
	if math.IsNaN(got) || got <= 0 {
		t.Errorf("valeur inattendue %v", got)
	}
}

func makeTwoStepGrid() (*TropoGrid, []int64) {
	w, h := 4, 4
	alt0 := make([]float32, w*h)
	alt1 := make([]float32, w*h)
	for i := range alt0 {
		alt0[i] = 8000
		alt1[i] = 12000
	}
	steps := []TropoStep{
		{TimeISO: "2025-01-01T00:00:00Z", AltMin: 8000, AltMax: 8000, Alt: alt0},
		{TimeISO: "2025-01-01T06:00:00Z", AltMin: 12000, AltMax: 12000, Alt: alt1},
	}
	grid := &TropoGrid{
		Bbox:   [4]float64{-10, -10, 10, 10},
		Width:  w,
		Height: h,
		Steps:  steps,
	}
	// T=0 : 0 ms, T+6h : 6*3600*1000 ms
	times := []int64{0, 6 * 3600 * 1000}
	return grid, times
}

func TestSampleInterpolatedTropo_midpoint(t *testing.T) {
	grid, times := makeTwoStepGrid()
	// A mi-chemin (T+3h = 3*3600*1000 ms) on attend (8000+12000)/2 = 10000
	target := int64(3 * 3600 * 1000)
	got, ok := sampleInterpolatedTropo(grid, times, target, 0, 0)
	if !ok {
		t.Fatal("attendu ok=true")
	}
	if math.Abs(got-10000) > 1 {
		t.Errorf("interpolation mi-chemin: attendu 10000, got %v", got)
	}
}

func TestSampleInterpolatedTropo_clampBefore(t *testing.T) {
	grid, times := makeTwoStepGrid()
	// Target avant le premier step → step 0 (8000)
	got, ok := sampleInterpolatedTropo(grid, times, -1000, 0, 0)
	if !ok {
		t.Fatal("attendu ok=true")
	}
	if math.Abs(got-8000) > 1 {
		t.Errorf("clamp avant: attendu 8000, got %v", got)
	}
}

func TestSampleInterpolatedTropo_clampAfter(t *testing.T) {
	grid, times := makeTwoStepGrid()
	// Target après le dernier step → step 1 (12000)
	target := int64(10 * 3600 * 1000)
	got, ok := sampleInterpolatedTropo(grid, times, target, 0, 0)
	if !ok {
		t.Fatal("attendu ok=true")
	}
	if math.Abs(got-12000) > 1 {
		t.Errorf("clamp après: attendu 12000, got %v", got)
	}
}
