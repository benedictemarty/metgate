package catalog

import (
	"context"
	"encoding/xml"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Family regroupe les versions horodatées d'un même produit MetGate.
type Family struct {
	Name   string `json:"name"`
	Count  int    `json:"count"`
	Latest string `json:"latest,omitempty"`
	Format string `json:"format,omitempty"`
}

type ServiceCatalog struct {
	Count    int      `json:"count"`
	Families []Family `json:"families"`
}

type Aggregate struct {
	FetchedAt time.Time      `json:"fetched_at"`
	RAW       ServiceCatalog `json:"raw"`
	WFS       ServiceCatalog `json:"wfs"`
	WCS       ServiceCatalog `json:"wcs"`
	// PartialFailures liste les services qui ont échoué (RAW/WFS/WCS).
	// Présent (et non vide) en cas de succès partiel ; à exposer via
	// X-Partial-Errors côté handler.
	PartialFailures []string `json:"partial_failures,omitempty"`
}

// versionSuffix matche les suffixes qui distinguent les versions d'un produit.
// Variantes observées dans MetGate :
//   - "_20260425220000" (timestamp)
//   - "_last" (alias vers la dernière version)
//   - "_last = TIMESTAMP" (RAW : alias suivi du timestamp pointé)
//   - "_last (TIMESTAMP)"  (WCS : alias avec timestamp entre parenthèses)
var versionSuffix = regexp.MustCompile(
	`_(?:[0-9]{14}|last)(?:\s*[=(][^)]*\)?)?\s*$`,
)

func familyOf(s string) string {
	return versionSuffix.ReplaceAllString(strings.TrimSpace(s), "")
}

// AggregateProducts interroge RAW + WFS + WCS en parallèle et agrège par
// famille. Les échecs partiels (un service KO sur trois) sont remontés via
// `Aggregate.PartialFailures` et loggés ; on ne renvoie une erreur que si
// les trois services ont échoué (le frontend n'a alors rien à afficher).
func (s *Service) AggregateProducts(ctx context.Context) (*Aggregate, error) {
	var (
		wg                   sync.WaitGroup
		rawFams              []Family
		wfsFams              []Family
		wcsFams              []Family
		rawErr, wfsErr, wcsE error
	)

	wg.Add(3)

	go func() {
		defer wg.Done()
		products, err := s.RawProducts(ctx)
		if err != nil {
			rawErr = fmt.Errorf("raw: %w", err)
			return
		}
		rawFams = aggregateRaw(products)
	}()

	go func() {
		defer wg.Done()
		body, status, err := s.Capabilities(ctx, "WFS", "2.0.0")
		if err != nil {
			wfsErr = fmt.Errorf("wfs: %w", err)
			return
		}
		if status != 200 {
			wfsErr = fmt.Errorf("wfs: status %d", status)
			return
		}
		wfsFams, wfsErr = parseWFSFamilies(body)
	}()

	go func() {
		defer wg.Done()
		body, status, err := s.Capabilities(ctx, "WCS", "2.0.1")
		if err != nil {
			wcsE = fmt.Errorf("wcs: %w", err)
			return
		}
		if status != 200 {
			wcsE = fmt.Errorf("wcs: status %d", status)
			return
		}
		wcsFams, wcsE = parseWCSFamilies(body)
	}()

	wg.Wait()

	var failures []string
	if rawErr != nil {
		slog.Warn("AggregateProducts", "service", "RAW", "err", rawErr)
		failures = append(failures, "RAW")
	}
	if wfsErr != nil {
		slog.Warn("AggregateProducts", "service", "WFS", "err", wfsErr)
		failures = append(failures, "WFS")
	}
	if wcsE != nil {
		slog.Warn("AggregateProducts", "service", "WCS", "err", wcsE)
		failures = append(failures, "WCS")
	}
	// Trois services KO → catalogue vide, on remonte une erreur claire.
	if len(failures) == 3 {
		return nil, fmt.Errorf("metgate indisponible: %v / %v / %v", rawErr, wfsErr, wcsE)
	}

	return &Aggregate{
		FetchedAt:       time.Now().UTC(),
		RAW:             ServiceCatalog{Count: len(rawFams), Families: rawFams},
		WFS:             ServiceCatalog{Count: len(wfsFams), Families: wfsFams},
		WCS:             ServiceCatalog{Count: len(wcsFams), Families: wcsFams},
		PartialFailures: failures,
	}, nil
}

func aggregateRaw(products []RawProduct) []Family {
	type acc struct {
		count  int
		latest string
		format string
	}
	by := make(map[string]*acc)
	for _, p := range products {
		fam := familyOf(p.Name)
		a, ok := by[fam]
		if !ok {
			a = &acc{format: p.Type}
			by[fam] = a
		}
		a.count++
		if p.DateInstance > a.latest {
			a.latest = p.DateInstance
		}
	}
	out := make([]Family, 0, len(by))
	for name, a := range by {
		out = append(out, Family{
			Name:   name,
			Count:  a.count,
			Latest: a.latest,
			Format: a.format,
		})
	}
	sortFamilies(out)
	return out
}

func parseWFSFamilies(body []byte) ([]Family, error) {
	var doc struct {
		Types []struct {
			Name string `xml:"Name"`
		} `xml:"FeatureTypeList>FeatureType"`
	}
	if err := xml.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("wfs xml: %w", err)
	}
	names := make([]string, 0, len(doc.Types))
	for _, t := range doc.Types {
		if t.Name != "" {
			names = append(names, t.Name)
		}
	}
	return groupByFamily(names), nil
}

func parseWCSFamilies(body []byte) ([]Family, error) {
	var doc struct {
		Sums []struct {
			ID string `xml:"CoverageId"`
		} `xml:"Contents>CoverageSummary"`
	}
	if err := xml.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("wcs xml: %w", err)
	}
	names := make([]string, 0, len(doc.Sums))
	for _, s := range doc.Sums {
		if s.ID != "" {
			names = append(names, s.ID)
		}
	}
	return groupByFamily(names), nil
}

func groupByFamily(names []string) []Family {
	type acc struct {
		count  int
		latest string
	}
	by := make(map[string]*acc)
	for _, n := range names {
		n = strings.TrimSpace(n)
		fam := familyOf(n)
		a, ok := by[fam]
		if !ok {
			a = &acc{}
			by[fam] = a
		}
		a.count++
		if n > a.latest {
			a.latest = n
		}
	}
	out := make([]Family, 0, len(by))
	for name, a := range by {
		out = append(out, Family{Name: name, Count: a.count, Latest: a.latest})
	}
	sortFamilies(out)
	return out
}

func sortFamilies(f []Family) {
	sort.Slice(f, func(i, j int) bool {
		if f[i].Count != f[j].Count {
			return f[i].Count > f[j].Count
		}
		return f[i].Name < f[j].Name
	})
}
