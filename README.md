# MetGate Portal

Portail météo pour les services ATM — agrège [MetGate](https://metgate.meteo.fr) (Météo-France), [OpenSky Network](https://opensky-network.org) (ADS-B) et [EUMETSAT MTG](https://www.eumetsat.int) dans une interface web unifiée.

![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript)
![MapLibre](https://img.shields.io/badge/MapLibre-5-396CB2)
[![Licence EUPL-1.2](https://img.shields.io/badge/Licence-EUPL--1.2-blue)](LICENSE)

---

## Fonctionnalités

### Carte interactive (MapLibre)
- **METAR / TAF / SIGMET / AIRMET / MAA** — flux WFS MetGate convertis GML → GeoJSON, décodés en français
- **Produits plats** SA_last / FT_last / FC_last (fallback stations non IWXXM : ED*, K*, UNOO…)
- **Popup enrichie** : T / Td / QNH / vent / visibilité / nuages pour METAR et TAF
- **Vent** — overlay particules animées (WIND 850 hPa / JET stream), WCS NetCDF-4
- **Tropopause** — canvas overlay altitude (m) avec upscale bilinéaire
- **Cendres volcaniques** (QVACIS) — concentration mg/m³, déterministe ou probabiliste
- **Cloud Top Height** (EUMETSAT MTG-FCI CTTH) — PNG colorisé par FL, cache stale-while-revalidate
- **Foudre** (EUMETSAT MTG-LI) — flashes GeoJSON dernière fenêtre 10 min
- **Satellite** FCI IR / RGB Convection — proxy tuiles EUMETView WMS
- **Slider temporel** — navigation dans les fenêtres de validité SIGMET / RDT / CAT

### Suivi ADS-B
- Recherche par callsign / immatriculation via OpenSky Network
- Suivi temps réel avec historique en mémoire (trace passée D3)
- Plan de vol projeté depuis la position courante : grand cercle, profil FL, événements WFS croisés
- Profil vent waypoint par waypoint (head / tail / cross wind)

### Vue Tour 3D
- Globe Three.js centré sur un aérodrome ICAO
- Pistes OurAirports, trafic ADS-B dans un rayon configurable
- Mât vent animé, cellules convectives RDT / OPIC_GTD

### Profil de route
- Plan de vol synthétique DEP → ARR : grand cercle, montée / croisière / descente
- Météo le long de la route : SIGMET, AIRMET, MAA, CAT actifs

### Navigation Display (EFIS ND)
- Radar météo canvas style phosphore vert, heading-up, 40/80/160/320 NM
- **Mode SIM** : route DEP → ARR avec heure de départ UTC, slider play/pause ×1–×30
- **Mode LIVE** : suivi ADS-B temps réel (polling OpenSky 15 s), données FL / GS / TRK / V/S / LAT / LON
- Phénomènes météo calés sur l'ETA de l'avion : RDT T+0…T+60, SIGMET par fenêtre de validité, flashes MTG-LI avec fade temporel (blanc → rouge → masqué sur 10 min)
- Contours pulsants alternés (cycle cos² par type), popup au survol
- Mini-carte géographique (Natural Earth 110m + FIR VATSIM 1038 zones)
- Indicateur de mise à jour météo (heure + compteurs cellules / flashes)

---

## Architecture

```
cmd/portal/          point d'entrée (HTTP server, graceful shutdown)
internal/
  catalog/           client MetGate WFS/WCS/RAW, cache TTL + singleflight, GML→GeoJSON, NetCDF
  decoder/           traducteur TAC français (METAR, TAF, SIGMET, AIRMET, MAA)
  aircraft/          client OpenSky (OAuth2 + Basic), ring buffer historique ADS-B
  airports/          base OurAirports embarquée CSV → lookup map ICAO
  cloudtop/          EUMETSAT MTG-FCI CTTH, stale-while-revalidate, pré-chargement boot
  lightning/         EUMETSAT MTG-LI LFL, cache par product ID
  eumetsat/          client OAuth2 EUMETSAT (token cache)
  satellite/         proxy tuiles EUMETView WMS (cache 60 s / tuile)
  fir/               FIR/UIR mondiaux embarqués (VATSIM, 1038 zones, GeoJSON)
  geo/               pays Natural Earth 110m embarqués (GeoJSON)
  http/              routes HTTP, handlers, spec OpenAPI embarquée
  web/               go:embed du frontend buildé (dist/)
web/src/             React 19 + TypeScript + MapLibre 5 + Three.js / R3F
```

Le frontend est embarqué dans le binaire via `go:embed` — **un seul fichier à déployer** (~30 MB).

---

## Prérequis

- Go ≥ 1.26
- Node.js ≥ 20 + npm
- Token applicatif MetGate (Météo-France)
- *(optionnel)* Credentials OpenSky pour le suivi ADS-B
- *(optionnel)* Credentials EUMETSAT pour CTH / foudre / satellite

---

## Installation

```bash
git clone https://github.com/benedictemarty/metgate
cd metgate

# Copier et remplir le fichier de configuration
cp .env.example .env
$EDITOR .env

# Dépendances frontend
cd web && npm install && cd ..

# Build complet (frontend embarqué dans le binaire)
make build

# Lancer
./bin/portal
```

Ouvrir [http://localhost:8080](http://localhost:8080).

---

## Configuration (`.env`)

| Variable | Req. | Description |
|---|---|---|
| `METGATE_BASE_URL` | ✓ | `https://metgate-mf.meteo.fr` (PROD) ou `https://metgate-int.meteo.fr` (INT) |
| `METGATE_TOKEN` | ✓ | Token applicatif MetGate |
| `PORT` | | Port d'écoute (défaut : `8080`) |
| `METGATE_CACHE_TTL_SECONDS` | | TTL cache MetGate en secondes (défaut : `60`) |
| `OPENSKY_CLIENT_ID` | | OAuth2 client ID OpenSky (recommandé) |
| `OPENSKY_CLIENT_SECRET` | | OAuth2 client secret OpenSky |
| `OPENSKY_USER` | | Basic auth OpenSky (legacy) |
| `OPENSKY_PASS` | | Basic auth OpenSky (legacy) |
| `EUMETSAT_CONSUMER_KEY` | | Clé EUMETSAT Data Store (CTH / foudre / satellite) |
| `EUMETSAT_CONSUMER_SECRET` | | Secret EUMETSAT |

Sans credentials OpenSky, `/api/aircraft/*` renvoie 503. Sans credentials EUMETSAT, CTH / foudre / satellite sont désactivés.

---

## Développement

```bash
# Deux terminaux
make run        # backend Go sur :8080
make web-dev    # Vite sur :5173 avec proxy /api → :8080

# Qualité
make test       # go test ./...
make lint       # golangci-lint (nécessite golangci-lint v2)
make tidy       # go mod tidy
```

---

## API

Documentation interactive : [`/api/docs`](http://localhost:8080/api/docs) (Swagger UI)  
Spec OpenAPI : [`/api/openapi.yaml`](http://localhost:8080/api/openapi.yaml)

| Endpoint | Description |
|---|---|
| `GET /healthz` | Santé du service |
| `GET /api/products` | Catalogue produits MetGate (RAW + WFS + WCS) |
| `GET /api/feature?type=METAR_last` | Features WFS → GeoJSON + décodage FR |
| `GET /api/wind?bbox=...&level=85000` | Grille vent u/v depuis WCS NetCDF |
| `GET /api/tropo?bbox=...` | Grille altitude tropopause |
| `GET /api/qvacis?fl=325` | Grille concentration cendres volcaniques |
| `GET /api/route?dep=LFPG&arr=LFBO` | Plan de vol synthétique + météo route |
| `GET /api/aircraft/search?cs=AFR123` | Recherche ADS-B via OpenSky |
| `GET /api/aircraft/{icao24}` | État ADS-B courant (200 toujours, stale si hors couverture) |
| `GET /api/cloudtop?bbox=...&minfl=200` | PNG sommets nuageux MTG-FCI CTTH |
| `GET /api/lightning?bbox=...` | Flashes foudre MTG-LI (GeoJSON) |
| `GET /api/airports/search?q=LFPG` | Recherche aérodromes OurAirports |
| `GET /api/airport/{icao}` | Fiche aérodrome + pistes |

---

## Déploiement

```bash
make build
scp bin/portal user@server:/opt/metgate/portal
```

Exemple systemd :

```ini
[Unit]
Description=MetGate Portal
After=network.target

[Service]
WorkingDirectory=/opt/metgate
ExecStart=/opt/metgate/portal
EnvironmentFile=/opt/metgate/.env
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

---

## Sources de données

| Source | Usage |
|---|---|
| [MetGate — Météo-France](https://metgate.meteo.fr) | METAR, TAF, SIGMET, AIRMET, MAA, vent, tropopause, cendres |
| [OpenSky Network](https://opensky-network.org) | Suivi ADS-B temps réel |
| [EUMETSAT Data Store](https://data.eumetsat.int) | MTG-FCI CTTH (sommets nuageux), MTG-LI (foudre) |
| [EUMETView WMS](https://view.eumetsat.int) | Tuiles satellite FCI IR / RGB Convection |
| [OurAirports](https://ourairports.com/data/) | Aérodromes, pistes, coordonnées (CC0) |
| [VATSIM vatspy-data-project](https://github.com/vatsimnetwork/vatspy-data-project) | FIR/UIR mondiaux 1038 zones (MIT) |
| [Natural Earth](https://www.naturalearthdata.com) | Polygones pays 110m (domaine public) |

> **Note EUMETSAT** : CTH, foudre et satellite MTG sont des données situationnelles **non OPMET**. Elles complètent la vision opérationnelle mais ne remplacent pas les produits OPMET officiels.

---

## Limites connues

- **Auth locale** : le portail n'a pas de gestion d'utilisateurs. Avant exposition publique, ajouter login/JWT.
- **OpenSky history** : in-memory uniquement, perdu au redémarrage.
- **WFS pagination** : count=2000 ; MetGate peut en avoir davantage (non critique pour la visu).

---

## Licence

[European Union Public Licence v. 1.2 (EUPL-1.2)](LICENSE)

Licence officielle de l'Union Européenne — copyleft compatible AGPL/LGPL/MPL. Toute modification distribuée ou déployée en service doit être publiée sous EUPL-1.2 ou licence compatible.

Les données tierces conservent leur licence d'origine : VATSIM Boundaries (MIT), Natural Earth (domaine public), OurAirports (CC0).
