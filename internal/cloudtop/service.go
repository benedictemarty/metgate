// Package cloudtop télécharge le dernier produit FCI Cloud Top Temperature
// & Height (CTTH) depuis EUMETSAT Data Store et le restitue en PNG colorisé
// par niveau de vol, avec filtrage minfl pour ne montrer que les sommets
// au-dessus d'un seuil donné — usage situationnel ATM (non-OPMET).
package cloudtop

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/batchatco/go-native-netcdf/netcdf/api"
	"github.com/bmarty/metgate/internal/eumetsat"
	"github.com/bmarty/metgate/internal/ncutil"
)

// FCI Cloud Top Temperature and Height (CTTH), MTG-I 0°, cadence 10 min.
const collectionCTTH = "EO:EUM:DAT:0681"

type Service struct {
	client    *eumetsat.Client
	mu        sync.Mutex
	cache     *Snapshot
	refreshing bool // vrai pendant un refresh en arrière-plan
}

// Snapshot contient la grille CTH décodée d'un produit MTG, projetée en
// EPSG:4326 (lat/lon) sur une grille régulière. La résolution choisie ici
// (~0.05° = ~5 km à l'équateur) est suffisante pour le rendu écran et
// permet de garder en mémoire une seule image globale ~7 MB.
type Snapshot struct {
	ProductID string
	FetchedAt time.Time
	// Grille EPSG:4326 sur le disque MTG visible : -70..+70 lat, -70..+70 lon.
	// FL[row][col] = niveau de vol du sommet (0 si pas de nuage).
	BBox   [4]float64 // lonMin, latMin, lonMax, latMax
	Width  int
	Height int
	FL     []int16 // -1 = pas de donnée / hors disque
}

func NewService(client *eumetsat.Client) *Service {
	return &Service{client: client}
}

func (s *Service) Authenticated() bool {
	return s.client != nil && s.client.Authenticated()
}

// StartBackground lance un goroutine qui pré-charge le snapshot au démarrage
// puis le rafraîchit toutes les 10 minutes (cadence MTG-CTTH). Appelé depuis
// main.go uniquement si les credentials EUMETSAT sont présents.
func (s *Service) StartBackground(ctx context.Context) {
	go func() {
		s.refresh(ctx)
		t := time.NewTicker(10 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.refresh(ctx)
			}
		}
	}()
}

// Latest retourne le snapshot courant. Stale-while-revalidate : si le cache
// est périmé mais existe, on le sert immédiatement et on déclenche un refresh
// en arrière-plan. Seul le tout premier appel (cache vide) bloque.
func (s *Service) Latest(ctx context.Context, ttl time.Duration) (*Snapshot, error) {
	s.mu.Lock()
	if s.cache != nil && ttl > 0 && time.Since(s.cache.FetchedAt) < ttl {
		snap := s.cache
		s.mu.Unlock()
		return snap, nil
	}
	// Cache périmé mais présent : servir l'ancien + refresh arrière-plan.
	if s.cache != nil && !s.refreshing {
		snap := s.cache
		s.refreshing = true
		s.mu.Unlock()
		go func() {
			s.refresh(context.Background())
		}()
		return snap, nil
	}
	// Cache vide : bloquer le temps du premier téléchargement (inévitable).
	if s.cache == nil {
		s.mu.Unlock()
		s.refresh(ctx)
		s.mu.Lock()
		snap := s.cache
		s.mu.Unlock()
		if snap == nil {
			return nil, fmt.Errorf("CTH snapshot unavailable")
		}
		return snap, nil
	}
	snap := s.cache
	s.mu.Unlock()
	return snap, nil
}

// refresh télécharge et parse le dernier produit CTTH ; met à jour le cache.
func (s *Service) refresh(ctx context.Context) {
	id, dlURL, err := s.client.LatestProduct(ctx, collectionCTTH)
	if err != nil {
		s.mu.Lock(); s.refreshing = false; s.mu.Unlock()
		return
	}
	s.mu.Lock()
	if s.cache != nil && s.cache.ProductID == id {
		s.cache.FetchedAt = time.Now()
		s.refreshing = false
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()

	zipBytes, err := s.client.Download(ctx, dlURL)
	if err != nil {
		s.mu.Lock(); s.refreshing = false; s.mu.Unlock()
		return
	}
	snap, err := parseCTTHZip(zipBytes)
	if err != nil {
		s.mu.Lock(); s.refreshing = false; s.mu.Unlock()
		return
	}
	snap.ProductID = id
	snap.FetchedAt = time.Now()
	s.mu.Lock()
	s.cache = snap
	s.refreshing = false
	s.mu.Unlock()
}

// PNG génère un PNG colorisé de la zone bbox, ne montrant que les pixels
// dont CTH ≥ minFL. Largeur/hauteur en pixels. Chaque pixel sortie est
// échantillonné depuis la grille snapshot par plus proche voisin.
func (s *Snapshot) PNG(bbox [4]float64, width, height, minFL int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	dLon := (bbox[2] - bbox[0]) / float64(width)
	dLat := (bbox[3] - bbox[1]) / float64(height)

	for py := 0; py < height; py++ {
		// y screen origin top → lat décroît
		lat := bbox[3] - (float64(py)+0.5)*dLat
		gy := s.latToGridY(lat)
		if gy < 0 || gy >= s.Height {
			continue
		}
		for px := 0; px < width; px++ {
			lon := bbox[0] + (float64(px)+0.5)*dLon
			gx := s.lonToGridX(lon)
			if gx < 0 || gx >= s.Width {
				continue
			}
			fl := s.FL[gy*s.Width+gx]
			if fl <= 0 || int(fl) < minFL {
				continue
			}
			img.Set(px, py, colorForFL(int(fl)))
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func (s *Snapshot) lonToGridX(lon float64) int {
	if lon < s.BBox[0] || lon > s.BBox[2] {
		return -1
	}
	return int((lon - s.BBox[0]) / (s.BBox[2] - s.BBox[0]) * float64(s.Width))
}

func (s *Snapshot) latToGridY(lat float64) int {
	if lat < s.BBox[1] || lat > s.BBox[3] {
		return -1
	}
	// Grille rangée du nord au sud : lat haute → ligne 0.
	return int((s.BBox[3] - lat) / (s.BBox[3] - s.BBox[1]) * float64(s.Height))
}

// Palette FL : aviation classique, par tranches.
//
//	FL000-100 : bleu pâle (cumulus bas)
//	FL100-200 : cyan
//	FL200-300 : vert (TCU possibles)
//	FL300-400 : jaune-orange (cellules profondes)
//	FL400+    : rouge (cellules très profondes, danger)
func colorForFL(fl int) color.RGBA {
	switch {
	case fl < 100:
		return color.RGBA{125, 211, 252, 200} // sky-300
	case fl < 200:
		return color.RGBA{56, 189, 248, 220} // sky-400
	case fl < 300:
		return color.RGBA{74, 222, 128, 230} // green-400
	case fl < 350:
		return color.RGBA{250, 204, 21, 240} // yellow-400
	case fl < 400:
		return color.RGBA{249, 115, 22, 245} // orange-500
	case fl < 450:
		return color.RGBA{239, 68, 68, 250} // red-500
	default:
		return color.RGBA{220, 38, 38, 255} // red-600 (FL450+)
	}
}

// parseCTTHZip décompresse le ZIP MTG-CTTH, lit le NetCDF principal, extrait
// `cloud_top_aviation_height` et reprojette en grille lat/lon régulière.
func parseCTTHZip(zipBytes []byte) (*Snapshot, error) {
	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		return nil, fmt.Errorf("zip open: %w", err)
	}
	var ncBytes []byte
	for _, f := range zr.File {
		// Le NC principal est nommé sans suffixe QCK et finit par .nc.
		if strings.HasSuffix(f.Name, ".nc") && !strings.Contains(f.Name, "QCK") {
			r, err := f.Open()
			if err != nil {
				return nil, err
			}
			ncBytes, err = io.ReadAll(r)
			r.Close()
			if err != nil {
				return nil, err
			}
			break
		}
	}
	if ncBytes == nil {
		return nil, fmt.Errorf("no main .nc found in CTTH archive")
	}
	nc, cleanup, err := ncutil.OpenBytes(ncBytes)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	// Lecture des coordonnées GEOS (x, y en mètres dans la projection
	// geostationary à 0°).
	xVar, err := readFloat64Var(nc, "x")
	if err != nil {
		return nil, err
	}
	yVar, err := readFloat64Var(nc, "y")
	if err != nil {
		return nil, err
	}
	flVar, err := nc.GetVariable("cloud_top_aviation_height")
	if err != nil {
		return nil, fmt.Errorf("cloud_top_aviation_height: %w", err)
	}
	flScale, flOffset, flFill := ncutil.UnpackParams(flVar)
	apply := func(v float64) float64 {
		if !math.IsNaN(flFill) && v == flFill {
			return math.NaN()
		}
		return v*flScale + flOffset
	}

	rows := len(yVar)
	cols := len(xVar)

	// Sortie : grille EPSG:4326 régulière, environ 0.05° (~5 km).
	// On limite le domaine au disque visible ±70°.
	const outRes = 0.05
	const minLat, maxLat = -70.0, 70.0
	const minLon, maxLon = -70.0, 70.0
	outW := int((maxLon - minLon) / outRes)
	outH := int((maxLat - minLat) / outRes)
	out := make([]int16, outW*outH)
	for i := range out {
		out[i] = -1
	}

	// Pour chaque pixel sortie (lat,lon), forward project en GEOS (x,y),
	// trouver le row/col le plus proche, lire la valeur FL.
	flValues, err := readGenericFloat64(flVar.Values)
	if err != nil {
		return nil, err
	}

	// Paramètres GEOS MTG-I (0°) : sub_lon=0, h=42164e3, req=6378.137e3,
	// rpol=6356.7523e3. Les coordonnées x/y du NetCDF sont des ANGLES en
	// radians (scan_angle, elevation_angle), pas des mètres. On compare
	// donc directement scanAng/elevAng aux x/y de la grille.
	const (
		subLon = 0.0
		h      = 42164.0e3
		req    = 6378.137e3
		rpol   = 6356.7523e3
		ecc2   = 1 - (rpol*rpol)/(req*req)
	)
	xMin := xVar[0]
	xStep := xVar[1] - xVar[0]
	yMin := yVar[0]
	yStep := yVar[1] - yVar[0]

	for py := 0; py < outH; py++ {
		lat := maxLat - (float64(py)+0.5)*outRes
		latRad := lat * math.Pi / 180
		// latitude géocentrique (corrige aplatissement Terre)
		clat := math.Atan((1 - ecc2) * math.Tan(latRad))
		coscLat := math.Cos(clat)
		sincLat := math.Sin(clat)
		rl := rpol / math.Sqrt(1-ecc2*coscLat*coscLat)
		for px := 0; px < outW; px++ {
			lon := minLon + (float64(px)+0.5)*outRes
			lonDiff := (lon - subLon) * math.Pi / 180

			r1 := h - rl*coscLat*math.Cos(lonDiff)
			r2 := -rl * coscLat * math.Sin(lonDiff)
			r3 := rl * sincLat
			rn := math.Sqrt(r1*r1 + r2*r2 + r3*r3)
			// Test visibilité : (h*r1) > rn*rn sinon le point est derrière
			// la Terre.
			if h*r1-(rn*rn) <= 0 {
				continue
			}
			scanAng := math.Atan(-r2 / r1)
			elevAng := math.Asin(-r3 / rn)

			gx := int((scanAng-xMin)/xStep + 0.5)
			gy := int((elevAng-yMin)/yStep + 0.5)
			if gx < 0 || gx >= cols || gy < 0 || gy >= rows {
				continue
			}
			vraw := flValues[gy*cols+gx]
			vfl := apply(vraw)
			if math.IsNaN(vfl) {
				continue
			}
			// `cloud_top_aviation_height` est un index de niveau FL :
			// valid_range [0, 100] → FL000 à FL1000, donc valeur*10 = FL.
			fl := vfl * 10
			if fl <= 0 || fl > 600 {
				continue
			}
			out[py*outW+px] = int16(fl + 0.5)
		}
	}
	return &Snapshot{
		BBox:   [4]float64{minLon, minLat, maxLon, maxLat},
		Width:  outW,
		Height: outH,
		FL:     out,
	}, nil
}

func readGenericFloat64(v interface{}) ([]float64, error) {
	switch arr := v.(type) {
	case [][]float64:
		out := make([]float64, 0, len(arr)*len(arr[0]))
		for _, row := range arr {
			out = append(out, row...)
		}
		return out, nil
	case [][]float32:
		out := make([]float64, 0, len(arr)*len(arr[0]))
		for _, row := range arr {
			for _, x := range row {
				out = append(out, float64(x))
			}
		}
		return out, nil
	case [][]int16:
		out := make([]float64, 0, len(arr)*len(arr[0]))
		for _, row := range arr {
			for _, x := range row {
				out = append(out, float64(x))
			}
		}
		return out, nil
	case [][]uint16:
		out := make([]float64, 0, len(arr)*len(arr[0]))
		for _, row := range arr {
			for _, x := range row {
				out = append(out, float64(x))
			}
		}
		return out, nil
	case [][]uint8:
		out := make([]float64, 0, len(arr)*len(arr[0]))
		for _, row := range arr {
			for _, x := range row {
				out = append(out, float64(x))
			}
		}
		return out, nil
	case [][]int8:
		out := make([]float64, 0, len(arr)*len(arr[0]))
		for _, row := range arr {
			for _, x := range row {
				out = append(out, float64(x))
			}
		}
		return out, nil
	case [][]int32:
		out := make([]float64, 0, len(arr)*len(arr[0]))
		for _, row := range arr {
			for _, x := range row {
				out = append(out, float64(x))
			}
		}
		return out, nil
	}
	return nil, fmt.Errorf("readGenericFloat64: unsupported %T", v)
}

func readFloat64Var(nc api.Group, name string) ([]float64, error) {
	v, err := nc.GetVariable(name)
	if err != nil {
		return nil, fmt.Errorf("var %s: %w", name, err)
	}
	scale, offset, _ := ncutil.UnpackParams(v)
	apply := func(x float64) float64 { return x*scale + offset }
	switch arr := v.Values.(type) {
	case []float64:
		out := make([]float64, len(arr))
		for i, x := range arr {
			out[i] = apply(x)
		}
		return out, nil
	case []float32:
		out := make([]float64, len(arr))
		for i, x := range arr {
			out[i] = apply(float64(x))
		}
		return out, nil
	case []int16:
		out := make([]float64, len(arr))
		for i, x := range arr {
			out[i] = apply(float64(x))
		}
		return out, nil
	case []uint16:
		out := make([]float64, len(arr))
		for i, x := range arr {
			out[i] = apply(float64(x))
		}
		return out, nil
	case []int32:
		out := make([]float64, len(arr))
		for i, x := range arr {
			out[i] = apply(float64(x))
		}
		return out, nil
	}
	return nil, fmt.Errorf("var %s: unsupported %T", name, v.Values)
}

