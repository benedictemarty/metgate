package aircraft

import (
	"context"
	"time"
)

// Service enveloppe le client OpenSky avec un historique en mémoire des
// positions vues par icao24. À chaque hit (search ou state), les states
// retournés sont appendés à l'historique.
type Service struct {
	client  *Client
	history *History
}

// NewService construit un Service avec un historique de durée maxAge.
func NewService(client *Client, maxAge time.Duration) *Service {
	return &Service{
		client:  client,
		history: NewHistory(maxAge),
	}
}

// Authenticated expose le statut auth du client sous-jacent.
func (s *Service) Authenticated() bool {
	return s.client.Authenticated()
}

// Search interroge OpenSky par sous-chaîne de callsign + bbox optionnelle ;
// chaque match alimente l'historique.
func (s *Service) Search(
	ctx context.Context,
	bbox *[4]float64,
	callsign string,
) ([]State, error) {
	out, err := s.client.QueryStates(ctx, bbox, "", callsign)
	if err != nil {
		return nil, err
	}
	for _, st := range out {
		s.history.Append(st)
	}
	return out, nil
}

// State retourne l'état courant d'un avion par icao24, et l'append à
// l'historique. nil si pas d'état trouvé.
func (s *Service) State(ctx context.Context, icao24 string) (*State, error) {
	out, err := s.client.QueryStates(ctx, nil, icao24, "")
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, nil
	}
	s.history.Append(out[0])
	return &out[0], nil
}

// FlightsByAircraft passe-à-travers vers le client (pas d'historique pour
// les segments de vol — ils sont passé/déjà aboutis par OpenSky).
func (s *Service) FlightsByAircraft(
	ctx context.Context,
	icao24 string,
	begin, end time.Time,
) ([]FlightSegment, error) {
	return s.client.FlightsByAircraft(ctx, icao24, begin, end)
}

// History retourne le passé accumulé pour un icao24 (copie).
func (s *Service) History(icao24 string) []State {
	return s.history.Get(icao24)
}

// DumpHistory sérialise l'historique ADS-B dans path (JSON gzip).
func (s *Service) DumpHistory(path string) error {
	return s.history.Dump(path)
}

// RestoreHistory charge l'historique ADS-B depuis path (JSON gzip).
func (s *Service) RestoreHistory(path string) error {
	return s.history.Restore(path)
}
