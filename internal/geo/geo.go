// Package geo expose les données géographiques de référence embarquées.
package geo

import _ "embed"

//go:embed countries.geojson
var CountriesGeoJSON []byte
