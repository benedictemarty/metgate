// Package airports embarque la base OurAirports (CSV) pour fournir position
// et géométrie des pistes des aéroports. Les CSV sont chargés en mémoire au
// démarrage et servis via une lookup map par code ICAO.
//
// Source : https://ourairports.com/data/ (domaine public CC0).
package airports

import (
	"embed"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync"
)

// maxRejectRatio borne la part de lignes CSV rejetées (ICAO invalide,
// coordonnées manquantes, ligne corrompue) tolérée avant de considérer le
// fichier comme cassé. Au-delà, New() retourne une erreur plutôt que de
// laisser le binaire tourner avec une base partielle silencieusement.
const maxRejectRatio = 0.20

//go:embed data/airports.csv data/runways.csv
var csvFS embed.FS

type Airport struct {
	ICAO         string
	IATA         string
	Name         string
	Lat          float64
	Lon          float64
	ElevationFt  int
	Country      string
	Municipality string
	Type         string // small_airport / medium_airport / large_airport / heliport
}

type Runway struct {
	AirportICAO string
	LengthFt    int
	WidthFt     int
	Surface     string
	Lighted     bool
	Closed      bool
	LeIdent     string  // identifiant du seuil bas (ex: "08L")
	LeLat       float64 // peut être 0 si non renseigné
	LeLon       float64
	LeHeading   float64 // degT
	HeIdent     string // ex: "26R"
	HeLat       float64
	HeLon       float64
	HeHeading   float64
}

type Store struct {
	mu       sync.RWMutex
	airports map[string]*Airport
	runways  map[string][]Runway // clé = ICAO de l'aéroport

	// Métriques de chargement (lignes CSV ignorées par cause). Renseignées
	// au boot, exposées par Stats() pour log opérationnel.
	rejectedAirports loadStats
	rejectedRunways  loadStats
}

// loadStats tient les compteurs par cause de rejet pendant un parsing CSV.
type loadStats struct {
	totalRows  int // hors header
	parseErr   int // ligne illisible (csv corrompu)
	badICAO    int // ICAO absent ou pas 4 lettres
	noGeometry int // pour pistes : pas de coordonnées exploitables
	closed     int // pour pistes : fermée
	kept       int
}


func New() (*Store, error) {
	s := &Store{
		airports: map[string]*Airport{},
		runways:  map[string][]Runway{},
	}
	if err := s.loadAirports(); err != nil {
		return nil, err
	}
	if err := s.loadRunways(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) loadAirports() error {
	f, err := csvFS.Open("data/airports.csv")
	if err != nil {
		return err
	}
	defer f.Close() //nolint:errcheck
	r := csv.NewReader(f)
	r.FieldsPerRecord = -1
	headers, err := r.Read()
	if err != nil {
		return fmt.Errorf("airports header: %w", err)
	}
	idx := indexOf(headers)
	var st loadStats
	for {
		row, err := r.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			st.parseErr++
			st.totalRows++
			// On ne stoppe pas : le csv encoding/csv resync au record
			// suivant, et on logge les lignes qu'on perd via Stats().
			continue
		}
		st.totalRows++
		icao := strings.TrimSpace(row[idx("icao_code")])
		if icao == "" {
			icao = strings.TrimSpace(row[idx("gps_code")])
		}
		if icao == "" {
			icao = strings.TrimSpace(row[idx("ident")])
		}
		if len(icao) != 4 {
			st.badICAO++
			continue
		}
		lat, _ := strconv.ParseFloat(row[idx("latitude_deg")], 64)
		lon, _ := strconv.ParseFloat(row[idx("longitude_deg")], 64)
		elev, _ := strconv.Atoi(row[idx("elevation_ft")])
		s.airports[icao] = &Airport{
			ICAO:         icao,
			IATA:         row[idx("iata_code")],
			Name:         row[idx("name")],
			Lat:          lat,
			Lon:          lon,
			ElevationFt:  elev,
			Country:      row[idx("iso_country")],
			Municipality: row[idx("municipality")],
			Type:         row[idx("type")],
		}
		st.kept++
	}
	s.rejectedAirports = st
	// Seuil sur parseErr seulement : badICAO est un filtre métier (heliports
	// 3-lettres, codes locaux non-OACI, etc.) qui rejette légitimement >40%
	// des lignes OurAirports. Une corruption CSV se manifeste par parseErr.
	if st.totalRows > 0 && float64(st.parseErr)/float64(st.totalRows) > maxRejectRatio {
		return fmt.Errorf("airports.csv: %d/%d lignes corrompues (parseErr) — fichier suspect",
			st.parseErr, st.totalRows)
	}
	return nil
}

func (s *Store) loadRunways() error {
	f, err := csvFS.Open("data/runways.csv")
	if err != nil {
		return err
	}
	defer f.Close() //nolint:errcheck
	r := csv.NewReader(f)
	r.FieldsPerRecord = -1
	headers, err := r.Read()
	if err != nil {
		return fmt.Errorf("runways header: %w", err)
	}
	idx := indexOf(headers)
	var st loadStats
	for {
		row, err := r.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			st.parseErr++
			st.totalRows++
			continue
		}
		st.totalRows++
		icao := strings.TrimSpace(row[idx("airport_ident")])
		if icao == "" || len(icao) != 4 {
			st.badICAO++
			continue
		}
		closed, _ := strconv.Atoi(row[idx("closed")])
		if closed == 1 {
			st.closed++
			continue
		}
		length, _ := strconv.Atoi(row[idx("length_ft")])
		width, _ := strconv.Atoi(row[idx("width_ft")])
		lit, _ := strconv.Atoi(row[idx("lighted")])
		leLat, _ := strconv.ParseFloat(row[idx("le_latitude_deg")], 64)
		leLon, _ := strconv.ParseFloat(row[idx("le_longitude_deg")], 64)
		leHdg, _ := strconv.ParseFloat(row[idx("le_heading_degT")], 64)
		heLat, _ := strconv.ParseFloat(row[idx("he_latitude_deg")], 64)
		heLon, _ := strconv.ParseFloat(row[idx("he_longitude_deg")], 64)
		heHdg, _ := strconv.ParseFloat(row[idx("he_heading_degT")], 64)
		// Les pistes sans coordonnées ne sont pas exploitables en 3D.
		if leLat == 0 && leLon == 0 && heLat == 0 && heLon == 0 {
			st.noGeometry++
			continue
		}
		s.runways[icao] = append(s.runways[icao], Runway{
			AirportICAO: icao,
			LengthFt:    length,
			WidthFt:     width,
			Surface:     row[idx("surface")],
			Lighted:     lit == 1,
			Closed:      false,
			LeIdent:     row[idx("le_ident")],
			LeLat:       leLat,
			LeLon:       leLon,
			LeHeading:   leHdg,
			HeIdent:     row[idx("he_ident")],
			HeLat:       heLat,
			HeLon:       heLon,
			HeHeading:   heHdg,
		})
		st.kept++
	}
	s.rejectedRunways = st
	// Seuil sur parseErr uniquement (cf. loadAirports) : badICAO,
	// noGeometry et closed sont des filtres métier attendus.
	if st.totalRows > 0 && float64(st.parseErr)/float64(st.totalRows) > maxRejectRatio {
		return fmt.Errorf("runways.csv: %d/%d lignes corrompues (parseErr)",
			st.parseErr, st.totalRows)
	}
	return nil
}

// LogStats émet un log opérationnel des compteurs de chargement. À appeler au
// boot après New() pour signaler les rejets sans noyer la sortie standard
// quand tout va bien.
func (s *Store) LogStats() {
	a, ra := s.rejectedAirports, s.rejectedRunways
	slog.Info("airports OurAirports",
		"aerodromes", a.kept, "total", a.totalRows, "icao_invalide", a.badICAO, "csv_corrompu", a.parseErr)
	slog.Info("runways OurAirports",
		"pistes", ra.kept, "total", ra.totalRows, "sans_geo", ra.noGeometry, "closed", ra.closed,
		"icao_invalide", ra.badICAO, "csv_corrompu", ra.parseErr)
}

// InBbox retourne les aérodromes situés dans la bbox [lonMin, latMin, lonMax, latMax].
// Quand mediumLargeOnly est vrai, les small_airport sont exclus (utile pour les alertes
// sur grande zone afin de ne pas retourner des milliers d'aérodromes).
func (s *Store) InBbox(bbox [4]float64, mediumLargeOnly bool) []*Airport {
	lonMin, latMin, lonMax, latMax := bbox[0], bbox[1], bbox[2], bbox[3]
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Airport
	for _, a := range s.airports {
		switch a.Type {
		case "heliport", "balloonport", "closed", "seaplane_base":
			continue
		case "small_airport":
			if mediumLargeOnly {
				continue
			}
		}
		if a.Lon >= lonMin && a.Lon <= lonMax && a.Lat >= latMin && a.Lat <= latMax {
			out = append(out, a)
		}
	}
	return out
}

func (s *Store) Airport(icao string) *Airport {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.airports[icao]
}

func (s *Store) Runways(icao string) []Runway {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Runway, len(s.runways[icao]))
	copy(out, s.runways[icao])
	return out
}

// Stats expose le nombre d'aéroports et pistes chargés (pour log au boot).
func (s *Store) Stats() (nAirports, nRunways int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, r := range s.runways {
		nRunways += len(r)
	}
	return len(s.airports), nRunways
}

// Search retourne les aéroports correspondant à la requête (ICAO, IATA, nom
// ou ville), triés par pertinence (matches exacts en premier). Filtre les
// heliports / closed / balloonport pour limiter le bruit. Limit borne le
// nombre de résultats retournés.
func (s *Store) Search(q string, limit int) []*Airport {
	q = strings.TrimSpace(strings.ToUpper(q))
	if q == "" {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	type ranked struct {
		a    *Airport
		rank int // plus bas = plus pertinent
	}
	var hits []ranked
	for _, a := range s.airports {
		if a.Type == "heliport" || a.Type == "balloonport" || a.Type == "closed" || a.Type == "seaplane_base" {
			continue
		}
		nameU := strings.ToUpper(a.Name)
		muniU := strings.ToUpper(a.Municipality)
		iataU := strings.ToUpper(a.IATA)
		var r int
		switch {
		case a.ICAO == q:
			r = 0
		case iataU == q:
			r = 1
		case strings.HasPrefix(a.ICAO, q):
			r = 2
		case strings.HasPrefix(iataU, q):
			r = 3
		case strings.HasPrefix(muniU, q):
			r = 4
		case strings.Contains(nameU, q):
			r = 5
		case strings.Contains(muniU, q):
			r = 6
		default:
			continue
		}
		// On privilégie les large_airport / medium_airport qui sont les plus
		// pertinents pour usage ATM tactique.
		if a.Type == "small_airport" {
			r += 10
		}
		hits = append(hits, ranked{a, r})
	}
	// Tri par rank ascendant
	for i := 1; i < len(hits); i++ {
		for j := i; j > 0 && hits[j].rank < hits[j-1].rank; j-- {
			hits[j], hits[j-1] = hits[j-1], hits[j]
		}
	}
	if limit > 0 && len(hits) > limit {
		hits = hits[:limit]
	}
	out := make([]*Airport, len(hits))
	for i, h := range hits {
		out[i] = h.a
	}
	return out
}

func indexOf(headers []string) func(string) int {
	m := map[string]int{}
	for i, h := range headers {
		m[strings.ToLower(strings.TrimSpace(h))] = i
	}
	return func(name string) int {
		if i, ok := m[strings.ToLower(name)]; ok {
			return i
		}
		return -1
	}
}
