package catalog

import (
	"math"
	"testing"
)

// approx vérifie qu'on est à eps près (utilitaire pour les tests géo).
func approx(t *testing.T, got, want, eps float64, name string) {
	t.Helper()
	if math.Abs(got-want) > eps {
		t.Errorf("%s: got %v, want %v ±%v", name, got, want, eps)
	}
}

// TestGcDistance vérifie quelques grandes distances connues.
// Référence : great-circle calculator (mi → NM × 0.868976).
func TestGcDistance(t *testing.T) {
	cases := []struct {
		name           string
		lat1, lon1     float64
		lat2, lon2     float64
		wantNM         float64
		toleranceNM    float64
	}{
		// LFPG (Paris CDG) → KJFK (New York JFK) ≈ 3148 NM grand cercle
		{"LFPG→KJFK", 49.0097, 2.5479, 40.6413, -73.7781, 3148, 5},
		// LFPG → LFBO (Toulouse Blagnac) ≈ 327 NM grand cercle
		{"LFPG→LFBO", 49.0097, 2.5479, 43.6293, 1.3637, 327, 2},
		// Identité : distance d'un point à lui-même = 0
		{"identité", 48.8566, 2.3522, 48.8566, 2.3522, 0, 0.001},
		// Antipode (Paris ↔ approx Pacifique sud) ~ demi-circonférence ~ 10800 NM
		{"antipode_paris", 48.8566, 2.3522, -48.8566, -177.6478, 10800, 10},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := gcDistance(c.lat1, c.lon1, c.lat2, c.lon2)
			approx(t, got, c.wantNM, c.toleranceNM, "distance")
		})
	}
}

// TestGcInterpolate : f=0 et f=1 doivent restituer les extrémités, et le
// milieu doit être sur le grand cercle (distance d/2 de chaque extrémité).
func TestGcInterpolate(t *testing.T) {
	lat1, lon1 := 49.0097, 2.5479    // Paris CDG
	lat2, lon2 := 40.6413, -73.7781  // New York JFK
	d := gcDistance(lat1, lon1, lat2, lon2)

	t.Run("f=0", func(t *testing.T) {
		la, lo := gcInterpolate(lat1, lon1, lat2, lon2, 0)
		approx(t, la, lat1, 1e-6, "lat")
		approx(t, lo, lon1, 1e-6, "lon")
	})
	t.Run("f=1", func(t *testing.T) {
		la, lo := gcInterpolate(lat1, lon1, lat2, lon2, 1)
		approx(t, la, lat2, 1e-6, "lat")
		approx(t, lo, lon2, 1e-6, "lon")
	})
	t.Run("milieu_sur_grand_cercle", func(t *testing.T) {
		la, lo := gcInterpolate(lat1, lon1, lat2, lon2, 0.5)
		d1 := gcDistance(lat1, lon1, la, lo)
		d2 := gcDistance(la, lo, lat2, lon2)
		approx(t, d1, d/2, 0.5, "d/2 from start")
		approx(t, d2, d/2, 0.5, "d/2 to end")
	})
}

// TestPointInRing valide le ray-casting sur des polygones simples.
func TestPointInRing(t *testing.T) {
	// Carré [0..10] × [0..10]
	square := [][]float64{{0, 0}, {10, 0}, {10, 10}, {0, 10}, {0, 0}}
	cases := []struct {
		name string
		lon  float64
		lat  float64
		want bool
	}{
		{"centre", 5, 5, true},
		// Note : un sommet est un cas indéterminé en ray-casting (selon
		// l'orientation du rayon). On ne teste pas ce cas.
		{"hors_droite", 11, 5, false},
		{"hors_gauche", -1, 5, false},
		{"hors_haut", 5, 11, false},
		{"hors_bas", 5, -1, false},
		{"très_proche_intérieur", 0.5, 0.5, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := pointInRing(c.lon, c.lat, square)
			if got != c.want {
				t.Errorf("got %v, want %v", got, c.want)
			}
		})
	}

	// Polygone concave en U : on ne doit PAS inclure le creux.
	uShape := [][]float64{
		{0, 0}, {10, 0}, {10, 10}, {7, 10}, {7, 3}, {3, 3}, {3, 10}, {0, 10}, {0, 0},
	}
	t.Run("U_inside_jambe", func(t *testing.T) {
		if !pointInRing(1, 5, uShape) {
			t.Error("(1,5) doit être dans la jambe gauche du U")
		}
	})
	t.Run("U_creux", func(t *testing.T) {
		if pointInRing(5, 7, uShape) {
			t.Error("(5,7) est dans le creux du U, ne doit pas être inclus")
		}
	})
}

// TestProjectAtBearing : 60 NM cap 90 (est) à l'équateur ≈ 1° de longitude.
// 60 NM cap 0 (nord) ≈ 1° de latitude (par construction NM = 1 minute d'arc).
func TestProjectAtBearing(t *testing.T) {
	cases := []struct {
		name             string
		lat0, lon0       float64
		bearing, distNM  float64
		wantLat, wantLon float64
		eps              float64
	}{
		{"nord_60NM_équateur", 0, 0, 0, 60, 1.0, 0, 0.01},
		{"sud_60NM_équateur", 0, 0, 180, 60, -1.0, 0, 0.01},
		{"est_60NM_équateur", 0, 0, 90, 60, 0, 1.0, 0.01},
		{"ouest_60NM_équateur", 0, 0, 270, 60, 0, -1.0, 0.01},
		// Au pôle nord, dist=0 → on reste au point de départ
		{"dist_zero", 60, 10, 45, 0, 60, 10, 1e-6},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			la, lo := projectAtBearing(c.lat0, c.lon0, c.bearing, c.distNM)
			approx(t, la, c.wantLat, c.eps, "lat")
			approx(t, lo, c.wantLon, c.eps, "lon")
		})
	}
}

// TestNearestWaypoint : sur un plan synthétique, le point le plus proche
// d'une coordonnée donnée est bien retourné.
func TestNearestWaypoint(t *testing.T) {
	plan := &RoutePlan{
		Waypoints: []RouteWaypoint{
			{Lon: 0, Lat: 0},
			{Lon: 1, Lat: 0},
			{Lon: 2, Lat: 0},
			{Lon: 3, Lat: 0},
		},
	}
	idx, dist := nearestWaypoint(plan, 0.1, 1.6)
	if idx != 2 {
		t.Errorf("waypoint le plus proche de (1.6, 0.1) doit être idx=2, got %d", idx)
	}
	if dist <= 0 || dist > 100 {
		t.Errorf("distance attendue petite et positive, got %v", dist)
	}
}

// TestProfileFL : profil trapézoïdal et triangulaire.
func TestProfileFL(t *testing.T) {
	// Vol long : trapèze montée 20 / cruise 50 / descente 25 = 95 min
	const cruise = 350.0
	const climbMin = 20.0
	const descentMin = 25.0
	totalMin := 95.0

	cases := []struct {
		name string
		t    float64
		want int
	}{
		{"décollage", 0, 0},
		{"milieu_montée", 10, 175},     // 350 * 10/20
		{"top_climb", 20, 350},
		{"croisière", 50, 350},
		{"top_descent", 70, 350},        // dernier point de cruise (juste avant t=70)
		{"milieu_descente", 82.5, 175},  // 350 * (95-82.5)/25 = 175
		{"atterrissage", 95, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := profileFL(c.t, totalMin, cruise, climbMin, descentMin)
			if math.Abs(float64(got-c.want)) > 1 {
				t.Errorf("got FL%d, want FL%d", got, c.want)
			}
		})
	}
}

// TestProfileFL_VolCourt : si total < climb+descent, profil triangulaire.
func TestProfileFL_VolCourt(t *testing.T) {
	// Total = 30 min, climb 20, descent 25 → triangulaire, sommet à
	// climb/(climb+descent) = 20/45 du temps total.
	totalMin := 30.0
	const cruise = 350.0
	peakFracRef := 20.0 / 45.0
	peakFLRef := cruise * peakFracRef // ≈ 155

	got := profileFL(totalMin*peakFracRef, totalMin, cruise, 20, 25)
	if math.Abs(float64(got)-peakFLRef) > 2 {
		t.Errorf("sommet du profil triangulaire: got FL%d, want ~FL%d", got, int(peakFLRef))
	}
}

// TestRingCentroid : carré centré sur (5, 5) → centroïde = (5, 5).
func TestRingCentroid(t *testing.T) {
	square := [][]float64{{0, 0}, {10, 0}, {10, 10}, {0, 10}, {0, 0}}
	lon, lat := ringCentroid(square)
	approx(t, lon, 5, 1e-6, "lon centroide")
	approx(t, lat, 5, 1e-6, "lat centroide")
}

// TestIsInValidity teste le fenêtrage temporel des events.
func TestIsInValidity(t *testing.T) {
	cases := []struct {
		name                          string
		waypointTime, start, end string
		want                          bool
	}{
		{"sans_start_ouvert", "2026-05-01T12:00:00Z", "", "", true},
		{"avant_début", "2026-05-01T10:00:00Z", "2026-05-01T12:00:00Z", "2026-05-01T14:00:00Z", false},
		{"dans_fenêtre", "2026-05-01T13:00:00Z", "2026-05-01T12:00:00Z", "2026-05-01T14:00:00Z", true},
		{"sur_début", "2026-05-01T12:00:00Z", "2026-05-01T12:00:00Z", "2026-05-01T14:00:00Z", true},
		{"après_fin", "2026-05-01T15:00:00Z", "2026-05-01T12:00:00Z", "2026-05-01T14:00:00Z", false},
		{"end_ouverte", "2026-05-01T15:00:00Z", "2026-05-01T12:00:00Z", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := isInValidity(c.waypointTime, c.start, c.end)
			if got != c.want {
				t.Errorf("got %v, want %v", got, c.want)
			}
		})
	}
}

// TestEffectiveValidityWindow vérifie la dérivation de fenêtre OACI selon la
// famille WFS, quand pas de bornes explicites.
func TestEffectiveValidityWindow(t *testing.T) {
	cases := []struct {
		name      string
		family    string
		props     map[string]any
		wantStart string
		wantEnd   string
	}{
		{
			name:      "explicite_validitystart",
			family:    "SIGMET_last",
			props:     map[string]any{"validitystarttime": "2026-05-01T10:00:00Z", "validityendtime": "2026-05-01T16:00:00Z"},
			wantStart: "2026-05-01T10:00:00Z",
			wantEnd:   "2026-05-01T16:00:00Z",
		},
		{
			name:      "metar_obs_plus_90min",
			family:    "METAR_last",
			props:     map[string]any{"observationTime": "2026-05-01T10:00:00Z"},
			wantStart: "2026-05-01T10:00:00Z",
			wantEnd:   "2026-05-01T11:30:00Z",
		},
		{
			name:      "taf_issue_plus_24h",
			family:    "TAF_last",
			props:     map[string]any{"issueTime": "2026-05-01T10:00:00Z"},
			wantStart: "2026-05-01T10:00:00Z",
			wantEnd:   "2026-05-02T10:00:00Z",
		},
		{
			name:      "sigmet_issue_plus_6h",
			family:    "SIGMET_last",
			props:     map[string]any{"issueTime": "2026-05-01T10:00:00Z"},
			wantStart: "2026-05-01T10:00:00Z",
			wantEnd:   "2026-05-01T16:00:00Z",
		},
		{
			name:      "wl_analysis_plus_12h",
			family:    "WL_last",
			props:     map[string]any{"analysis_time": "2026-05-01T10:00:00Z"},
			wantStart: "2026-05-01T10:00:00Z",
			wantEnd:   "2026-05-01T22:00:00Z",
		},
		{
			name:      "famille_inconnue",
			family:    "RDT_MSG_last",
			props:     map[string]any{"issueTime": "2026-05-01T10:00:00Z"},
			wantStart: "",
			wantEnd:   "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gotS, gotE := effectiveValidityWindow(c.props, c.family)
			if gotS != c.wantStart {
				t.Errorf("start: got %q, want %q", gotS, c.wantStart)
			}
			if gotE != c.wantEnd {
				t.Errorf("end: got %q, want %q", gotE, c.wantEnd)
			}
		})
	}
}

// TestAddMinutesToISO vérifie l'arithmétique sur les ISO time strings.
func TestAddMinutesToISO(t *testing.T) {
	cases := []struct {
		in   string
		mins int
		want string
	}{
		{"2026-05-01T12:00:00Z", 90, "2026-05-01T13:30:00Z"},
		{"2026-05-01T23:30:00Z", 60, "2026-05-02T00:30:00Z"},
		{"2026-05-01T10:00:00Z", -120, "2026-05-01T08:00:00Z"},
		{"non-iso", 60, "non-iso"}, // tolérance : on retourne tel quel
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			got := addMinutesToISO(c.in, c.mins)
			if got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
		})
	}
}
