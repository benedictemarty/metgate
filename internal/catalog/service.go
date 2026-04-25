package catalog

import (
	"context"
	"encoding/csv"
	"fmt"
	"strconv"
	"strings"

	"github.com/bmarty/metgate/internal/metgate"
)

// RawProduct est une ligne du catalogue RAW de MetGate (ex: COMPOSITE radar).
type RawProduct struct {
	Name         string `json:"name"`
	Type         string `json:"type"`
	DateInstance string `json:"date_instance"`
	InsertDate   string `json:"insert_date"`
	Size         int64  `json:"size"`
	Checksum     string `json:"checksum"`
}

type Service struct {
	mg *metgate.Client
}

func New(mg *metgate.Client) *Service {
	return &Service{mg: mg}
}

// RawProducts interroge MetGate (service=RAW) et parse le CSV en objets typés.
func (s *Service) RawProducts(ctx context.Context) ([]RawProduct, error) {
	body, status, err := s.mg.GetCapabilities(ctx, "RAW", "1.0.0")
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("metgate RAW: status %d", status)
	}

	r := csv.NewReader(strings.NewReader(string(body)))
	rows, err := r.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("csv parse: %w", err)
	}
	if len(rows) < 2 {
		return nil, nil
	}

	out := make([]RawProduct, 0, len(rows)-1)
	for _, row := range rows[1:] {
		if len(row) < 6 {
			continue
		}
		size, _ := strconv.ParseInt(row[4], 10, 64)
		out = append(out, RawProduct{
			Name:         row[0],
			Type:         row[1],
			DateInstance: row[2],
			InsertDate:   row[3],
			Size:         size,
			Checksum:     row[5],
		})
	}
	return out, nil
}

// Capabilities renvoie la réponse brute de MetGate (utile pour WFS/WCS en XML).
func (s *Service) Capabilities(ctx context.Context, service, version string) ([]byte, int, error) {
	return s.mg.GetCapabilities(ctx, service, version)
}
