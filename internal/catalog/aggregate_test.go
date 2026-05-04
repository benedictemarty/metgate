package catalog

import "testing"

func TestFamilyOf(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"WIND_20260425220000", "WIND"},
		{"METAR_last", "METAR"},
		{"SIGMET_last (TS)", "SIGMET"},     // alias WCS avec parenthèses
		{"WIND_last = 20260425220000", "WIND"}, // alias RAW avec timestamp pointé
		{"  TROPO_20260425000000  ", "TROPO"},  // tolérance whitespace
		{"NO_SUFFIX", "NO_SUFFIX"},
		{"", ""},
	}
	for _, c := range cases {
		got := familyOf(c.in)
		if got != c.want {
			t.Errorf("familyOf(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestAggregateRaw(t *testing.T) {
	products := []RawProduct{
		{Name: "WIND_20260101000000", Type: "GRIB", DateInstance: "2026-01-01"},
		{Name: "WIND_20260102000000", Type: "GRIB", DateInstance: "2026-01-02"},
		{Name: "WIND_20260103000000", Type: "GRIB", DateInstance: "2026-01-03"},
		{Name: "TROPO_20260101000000", Type: "NetCDF", DateInstance: "2026-01-01"},
	}
	fams := aggregateRaw(products)
	// Tri par count desc puis nom : WIND (3) doit être avant TROPO (1)
	if len(fams) != 2 {
		t.Fatalf("got %d families, want 2", len(fams))
	}
	if fams[0].Name != "WIND" || fams[0].Count != 3 {
		t.Errorf("famille[0] = %+v, want WIND/3", fams[0])
	}
	if fams[0].Latest != "2026-01-03" {
		t.Errorf("WIND.Latest = %q, want 2026-01-03", fams[0].Latest)
	}
	if fams[1].Name != "TROPO" || fams[1].Count != 1 {
		t.Errorf("famille[1] = %+v, want TROPO/1", fams[1])
	}
}

func TestGroupByFamily(t *testing.T) {
	names := []string{
		"METAR_last",
		"METAR_20260101120000",
		"METAR_20260101130000",
		"TAF_last",
	}
	fams := groupByFamily(names)
	if len(fams) != 2 {
		t.Fatalf("got %d, want 2 (METAR, TAF)", len(fams))
	}
	// METAR doit avoir Count=3 (3 versions) et Latest = la chaîne
	// lexicographiquement la plus grande.
	var metar *Family
	for i := range fams {
		if fams[i].Name == "METAR" {
			metar = &fams[i]
		}
	}
	if metar == nil {
		t.Fatal("famille METAR introuvable")
	}
	if metar.Count != 3 {
		t.Errorf("METAR.Count = %d, want 3", metar.Count)
	}
	// "METAR_last" < "METAR_20260101130000" en ordre lexico ASCII (chiffres < lettres)
	// → en réalité l < 2 : 'l' = 0x6C, '2' = 0x32 → '2' < 'l', donc "METAR_2..." < "METAR_last"
	if metar.Latest != "METAR_last" {
		t.Errorf("METAR.Latest = %q, want METAR_last (max lexico)", metar.Latest)
	}
}
