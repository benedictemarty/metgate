// Package lightning interroge EUMETSAT Data Store pour les produits MTG-LI
// (Meteosat Third Generation — Lightning Imager) afin d'exposer les impacts
// foudre récents au portail. Source à titre situationnel uniquement
// (non-OPMET, voir bandeau UI).
package lightning

import (
	"context"

	"github.com/bmarty/metgate/internal/eumetsat"
)

// Lightning Flashes (LFL), cadence 10 min — points individuels.
const collectionLFL = "EO:EUM:DAT:0691"

// Client est un wrapper autour du client EUMETSAT générique, spécialisé sur
// la collection LFL.
type Client struct {
	eu *eumetsat.Client
}

func New(consumerKey, consumerSecret string) *Client {
	return &Client{eu: eumetsat.New(consumerKey, consumerSecret)}
}

// NewFromEUMETSAT permet de partager un *eumetsat.Client déjà construit.
func NewFromEUMETSAT(c *eumetsat.Client) *Client {
	return &Client{eu: c}
}

func (c *Client) Authenticated() bool {
	return c.eu.Authenticated()
}

// LatestProduct retourne l'identifiant et l'URL de download du produit le
// plus récent de la collection LFL.
func (c *Client) LatestProduct(ctx context.Context) (id, dlURL string, err error) {
	return c.eu.LatestProduct(ctx, collectionLFL)
}

// Download récupère le ZIP du produit (bytes en mémoire).
func (c *Client) Download(ctx context.Context, dlURL string) ([]byte, error) {
	return c.eu.Download(ctx, dlURL)
}
