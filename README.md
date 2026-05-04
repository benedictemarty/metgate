# MetGate Portal

Portail web Go qui consomme l'API **MetGate** de Météo-France et expose aux
services ATM :

- Catalogue des produits OPMET (METAR / TAF / SIGMET / AIRMET / WL / advisories) ;
- Carte interactive : particules vent, tropopause, cendres volcaniques, foudre, sommets nuageux, satellite ;
- Suivi ADS-B (OpenSky) avec plan de route synthétique et météo le long de la trajectoire.

Frontend SPA React/TypeScript embarqué dans le binaire Go (`go:embed`).

> Spec OpenAPI MetGate : `api/openapi.json`.
> Auth : token applicatif unique côté serveur, jamais exposé au navigateur.

---

## Prérequis

- **Go 1.24** ou plus récent (cf. `go.mod`)
- **Node 22** + npm pour la build du frontend
- Accès réseau aux endpoints MetGate (par défaut INT : `metgate-int.meteo.fr`)
- *(optionnel)* credentials OpenSky pour le suivi ADS-B
- *(optionnel)* credentials EUMETSAT pour foudre / sommets nuageux

## Lancement rapide

```bash
# Une fois (récupère les deps frontend)
cd web && npm install && cd ..

# Build complet (frontend → embed → binaire)
make build && ./bin/portal
```

Ouvrir `http://localhost:8080`.

## Mode développement

Deux terminaux :

```bash
make run        # backend Go sur :8080
make web-dev    # vite sur :5173 avec proxy /api → :8080
```

Hot-reload côté frontend.

## Configuration `.env`

À placer à la racine, mode `0600` (gitignored) :

```ini
# OBLIGATOIRE
METGATE_BASE_URL=https://metgate-int.meteo.fr
METGATE_TOKEN=<token applicatif>

# OPTIONNEL — tuning serveur
PORT=8080
METGATE_CACHE_TTL_SECONDS=60

# OPTIONNEL — OpenSky (suivi ADS-B). Sans creds, /api/aircraft/* renvoie 503.
# Méthode actuelle : OAuth2 client_credentials (JSON depuis Personal Account
# Settings → Download credentials).
OPENSKY_CLIENT_ID=
OPENSKY_CLIENT_SECRET=
# Méthode legacy (anciens comptes uniquement)
OPENSKY_USER=
OPENSKY_PASS=

# OPTIONNEL — EUMETSAT Data Store (foudre MTG-LI, sommets nuageux MTG-CTTH).
# Sans creds, /api/lightning et /api/cloudtop renvoient 503.
EUMETSAT_CONSUMER_KEY=
EUMETSAT_CONSUMER_SECRET=
```

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /healthz` | Sanity check |
| `GET /api/products` | Catalogue 3-services agrégé par famille |
| `GET /api/catalog?service=RAW\|WFS\|WCS` | Capabilities passthrough |
| `GET /api/feature?type=METAR_last&count=N` | WFS GetFeature → GeoJSON |
| `GET /api/wind?dataset=WIND\|JET&level=Pa&bbox=...&allSteps=1` | Grille u/v décodée NetCDF |
| `GET /api/tropo?bbox=...` | Grille altitude tropopause (m) |
| `GET /api/qvacis?dataset=DETERMINISTIC\|PROBABILISTIC&fl=325&bbox=...` | Concentration cendres (mg/m³) |
| `GET /api/route?dep=LFPG&arr=LFBO&fl=350&gs=420&events=1&wind=1&tropo=1` | Plan synthétique + waypoints + events + profil vent |
| `GET /api/aircraft/search?cs=AFR123` | Recherche par callsign / bbox |
| `GET /api/aircraft/{icao24}` | État courant + alimente le history |
| `GET /api/aircraft/{icao24}/route` | Plan synthétique projeté |
| `GET /api/lightning?bbox=...` | Flashes MTG-LI (10 min) |
| `GET /api/cloudtop?bbox=...&minfl=N&w=PX&h=PX` | PNG sommets nuageux |
| `GET /api/satellite/tile?layer=...&z=...&x=...&y=...` | Tuile EUMETView |
| `GET /api/airport/{icao}` | Fiche aéroport + pistes (OurAirports) |
| `GET /api/airports/search?q=...&limit=N` | Recherche aérodromes |
| `GET /api/wfs\|wcs\|raw?...` | Proxy brut MetGate (token côté serveur) |

Header `X-Cache: HIT|MISS` sur les endpoints qui cachent.
Header `X-Partial-Errors: WFS,WCS` quand une agrégation a partiellement échoué.

## Tests

```bash
make test           # = go test ./...
go test -race ./... # détecteur de course
go vet ./...        # vet
```

Couverture : décodeurs OPMET (METAR/SIGMET/WL), géométrie route, cache +
singleflight, agrégation, parsing paramètres HTTP, OpenSky auth.

## Troubleshooting

| Symptôme | Diagnostic |
|---|---|
| `403 Forbidden` sur MetGate | Token invalide / expiré → vérifier `.env` |
| `503` sur `/api/aircraft/*` | Pas de creds OpenSky configurés (volontaire) |
| `429 Too Many Requests` OpenSky | Compte gratuit rate-limité ; le frontend a un back-off |
| `503` sur `/api/lightning` ou `/api/cloudtop` | EUMETSAT_CONSUMER_KEY/SECRET non configurés |
| Boot "X% lignes corrompues" airports.csv | Fichier `internal/airports/data/*.csv` corrompu |
| Pas de wind / tropo affiché | WCS coverage indisponible (cf. logs) |
| Particules vent saccadées | `allSteps=1` non passé, ou un seul step récupéré |

Logs côté serveur :

- `RouteEvents LFPG→LFBO FL350: WFS SIGMET_last a échoué: …` → famille WFS perdue (le plan reste affiché sans cet event)
- `AggregateProducts WFS: …` → un service MetGate KO (succès partiel remonté côté HTTP via `X-Partial-Errors`)

## Architecture

```
cmd/portal/main.go      Point d'entrée, .env, graceful shutdown
internal/metgate/       Client HTTP MetGate (Bearer token)
internal/catalog/       Cache TTL + singleflight, services métier
                        (cache, aggregate, gml→GeoJSON, wind, tropo, qvacis,
                         route planning, wind profile)
internal/aircraft/      Client OpenSky + history en mémoire
internal/airports/      OurAirports CSV embarqué
internal/eumetsat/      Client OAuth2 EUMETSAT Data Store
internal/lightning/     Service foudre (MTG-LI LFL)
internal/cloudtop/      Service sommets nuageux (MTG-CTTH)
internal/satellite/     Proxy WMS EUMETView (whitelist layers)
internal/decoder/       TAC OACI → français (METAR/TAF/SIGMET/AIRMET/WL/IWXXM)
internal/ncutil/        Helpers NetCDF (open from bytes, CF-1.x unpack)
internal/http/          Routes HTTP, parsing strict des paramètres
internal/web/           go:embed du frontend Vite
```

Détails des conventions et pièges domaine : voir `CLAUDE.md` à la racine.

## Limites connues

Cf. `CLAUDE.md` section « Limites connues » :

- Pas d'auth utilisateur (portail ouvert sur `localhost`).
- Cache stats non exposées sur HTTP.
- Pas de back-off sur erreurs transitoires côté cache.
- WFS pagination : `count=2000` peut tronquer les flux très volumineux.
- OpenSky history : in-memory (perdu au redémarrage).
- Index ICAO `/api/route` dépend de la disponibilité MetGate (METAR/TAF/SPECI).

## Licence

Privé Météo-France / DSNA. Données OurAirports en CC0.
