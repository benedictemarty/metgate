# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Vue d'ensemble

Portail web Go qui consomme l'API **MetGate** de Météo-France et expose aux services ATM une vue catalogue + une carte interactive (METAR/TAF/SIGMET/MAA, particules de vent, tropopause, cendres volcaniques) ainsi qu'un module de suivi ADS-B (OpenSky) avec plan de route synthétique et météo le long de la trajectoire. Frontend SPA React/TypeScript embarqué dans le binaire Go (`go:embed`).

- Spec OpenAPI MetGate : `api/openapi.json` (~30k lignes, export Apidog — non utilisée par `oapi-codegen` à cause d'extensions `x-apidog` mal placées).
- Auth : token applicatif unique côté serveur, jamais exposé au navigateur. Le portail est **multi-utilisateurs locaux** prévus, mais l'auth interne (login/JWT) **n'est pas encore implémentée**.
- Environnements : `https://metgate-mf.meteo.fr` (PROD), `https://metgate-int.meteo.fr` (INT, utilisé en dev).

## Lancement

```bash
# Une fois (récupère deps frontend)
cd web && npm install

# Build complet (frontend → embedded → binaire)
make build && ./bin/portal

# Mode dev (deux terminaux)
make run        # backend Go sur :8080
make web-dev    # vite sur :5173 avec proxy /api → :8080
```

Le `.env` (à la racine, gitignored, mode 0600) doit contenir :
```
METGATE_BASE_URL=https://metgate-int.meteo.fr
METGATE_TOKEN=<token applicatif>
PORT=8080
METGATE_CACHE_TTL_SECONDS=60

# OpenSky (suivi ADS-B). Optionnel : sans credentials, /api/aircraft/* renvoie 503.
# OAuth2 client_credentials (méthode actuelle, fin 2024+) — JSON téléchargé depuis
# Personal Account Settings → Download credentials.
OPENSKY_CLIENT_ID=
OPENSKY_CLIENT_SECRET=
# Auth Basic (legacy, anciens comptes uniquement)
OPENSKY_USER=
OPENSKY_PASS=
```

Tests : `make test` (= `go test ./...`).

## Architecture backend (Go)

```
cmd/portal/main.go          point d'entrée, charge .env, démarre HTTP server avec graceful shutdown
internal/metgate/client.go  client HTTP vers MetGate (Bearer token, GET, GetCapabilities)
internal/catalog/
  cache.go                  cache TTL en mémoire + singleflight (clé = path+query)
  service.go                couche service (cache wrappé), expose RawProducts, Capabilities, Proxy, FeatureGeoJSON
  aggregate.go              /api/products : 3 fetches WCS/WFS/RAW en parallèle, regroupe par famille
  gml.go                    parser GML 3.2 → GeoJSON (Point, Polygon, MultiPolygon) ; extrait IWXXM TAC
  wind.go                   WCS WIND/JET → NetCDF-4 → grille u,v multi-step
  tropo.go                  WCS TROPO → NetCDF-4 → grille altitude tropopause
  qvacis.go                 WCS QVACIS det/proba → NetCDF-4 → grille concentration cendres
  route.go                  plan de route ICAO→ICAO synthétique : grand cercle, profil FL climb/cruise/descent, projection d'événements WFS (SIGMET/AIRMET/MAA/RDT/CAT) le long de la trajectoire
  wind_profile.go           profil vent waypoint-par-waypoint le long d'une route (subset WCS WIND, niveau pression dérivé du FL, head/tail/cross wind)
internal/aircraft/
  opensky.go                client OpenSky : auth OAuth2 client_credentials (token cache) ou Basic legacy, GetStates, FlightsByAircraft
  history.go                ring buffer en mémoire (par icao24) des State observés ; permet de tracer le passé même quand on n'a pas reçu OpenSky en continu
  service.go                wrap client + history ; Search, State (pousse en history), FlightsByAircraft, History
internal/http/handlers.go   routes HTTP, middleware logs, X-Cache header
internal/web/
  embed.go                  go:embed du frontend buildé (dist/) + handler SPA fallback
  dist/                     généré par vite, gitignored sauf .gitkeep
```

## Endpoints HTTP

| Endpoint | Description |
|---|---|
| `GET /healthz` | sanity check |
| `GET /api/products` | catalogue 3-services agrégé par famille |
| `GET /api/catalog?service=RAW\|WFS\|WCS` | passthrough Capabilities (RAW = CSV, WFS/WCS = XML) |
| `GET /api/feature?type=METAR_last&count=N` | WFS GetFeature → GML → GeoJSON, parser-maison |
| `GET /api/wind?dataset=WIND\|JET&level=Pa&bbox=...&allSteps=1` | grille u,v décodée du WCS NetCDF |
| `GET /api/tropo?bbox=...` | grille altitude tropopause (m) |
| `GET /api/qvacis?dataset=DETERMINISTIC\|PROBABILISTIC&fl=325&bbox=...` | grille concentration cendres (mg/m³) |
| `GET /api/route?dep=LFPG&arr=LFBO&fl=350&speed=420&events=1&wind=1&...` | plan synthétique + waypoints + events WFS croisés + profil vent optionnel |
| `GET /api/aircraft/search?q=AFR123\|F-...` | recherche par callsign/registration via OpenSky |
| `GET /api/aircraft/{icao24}` | dernier State (et alimente le history en mémoire) |
| `GET /api/aircraft/{icao24}/route` | plan synthétique projeté autour de la position courante + events WFS |
| `GET /api/wfs\|wcs\|raw?...` | proxy brut (token côté serveur) |
| `GET /` | SPA React |

Header `X-Cache: HIT|MISS` sur les endpoints qui utilisent le cache. TTL configurable via `METGATE_CACHE_TTL_SECONDS`. `singleflight` déduplique les fetches concurrents.

## Architecture frontend

```
web/src/
  App.tsx                   layout + nav Catalog / Carte (lazy-load MapView)
  pages/
    Catalog.tsx             cards par famille de produit (RAW/WFS/WCS)
    MapView.tsx             carte MapLibre, sidebar WFS, slider temporel
  components/
    WindLayer.tsx           overlay canvas particules animées (WIND/JET)
    TropoLayer.tsx          MapLibre image source (PNG canvas) altitude tropopause
    QvacisLayer.tsx         idem QVACIS (concentration cendres)
    AircraftTracker.tsx     panneau recherche callsign + suivi temps réel (poll OpenSky), passé accumulé en mémoire (D3) + slider full-range
    FlightPlan.tsx          rendu route : grand cercle, waypoints, événements météo croisés, profil vent
  index.css                 Tailwind v4 + style maplibregl-popup dark
```

Stack : React 19 + TS 6 + Vite 8 + Tailwind v4 + Lucide + MapLibre 5 + react-map-gl 8.

## Conventions et pièges (à connaître impérativement)

### MetGate WCS

- **Coverages** : pas de `_last` adressable (les CoverageId `WIND_last (TS)` sont des aliases pseudo non interrogeables → filtrer dans `latestCoverageID`).
- **NetCDF-4 (HDF5)** uniquement, pas de NetCDF-classic.
- **Time axis** : convention différente selon le coverage :
  - WIND, JET, TROPO : `hours since 1900-01-01`
  - QVACIS : `minutes since 1970-01-01` (Unix epoch en minutes)
- **Variables** : `var33` = u-component (eastward, m/s), `var34` = v-component (northward, m/s), `var5` selon coverage (TROPO = altitude tropopause en m), `ash_concentration` (mg/m³).
- **Fill values** : présentes pour les pixels hors-domaine (~2.5e+34 observé sur JET). Filtrer dans le décodage (`> 200 m/s` traité comme 0 pour vent ; `> 1e10` pour TROPO).
- **Toujours subset** spatial + niveau (et flight_level pour QVACIS), sinon timeout (le coverage WIND complet fait 720 MB).
- **Subset time accepte des valeurs numériques** (heures/minutes selon convention), pas l'ISO directement → on prend tous les timesteps puis on filtre côté Go.
- **Timestep par défaut** : choisir le plus proche de **maintenant** (`nearestTimeIndex`), pas le dernier (qui peut être T+33h). Validé par confrontation METAR (Δdir médiane 33° quand bien aligné, vs 67° avec le dernier).

### MetGate WFS

- **GML uniquement**, pas de GeoJSON natif (`'application/json' is not a permitted output format`). Conversion GML→GeoJSON faite dans `internal/catalog/gml.go`.
- **Convention axe-order EPSG:4326** : `lat lon` → swap en `[lon, lat]` pour GeoJSON RFC 7946.
- **typeName** : utiliser le `family.latest` retourné par `/api/products` (`METAR_last`, etc.), pas le nom de famille.
- **`opmet_msg`** : CDATA IWXXM volumineux (souvent > 10 KB). On extrait sélectivement le TAC (attribut `translatedFailedTAC` IWXXM 2021-2) ou on reconstruit un TAC depuis les champs IWXXM 3.0 (T/Td/QNH/wind/CAVOK).

### Aircraft / OpenSky

- **Auth** : OAuth2 `client_credentials` (priorité) avec cache du token, fallback Basic pour les vieux comptes. Si aucun credential n'est fourni, `Service.Authenticated()` est faux et les handlers `/api/aircraft/*` renvoient 503 — c'est volontaire, pas un bug.
- **Throttling OpenSky** : compte gratuit limité, on s'appuie donc sur le `History` en mémoire (par icao24) pour reconstruire la trace passée plutôt que de réinterroger. Le buffer est alimenté à chaque appel `/api/aircraft/{icao24}` côté frontend (poll régulier).
- **Plan synthétique** (`/api/route`, `/api/aircraft/{icao24}/route`) : grand cercle DEP→ARR (ou projection vers l'avant depuis l'avion réel), profil FL trapézoïdal climb/cruise/descent, ETA waypoint par interpolation linéaire du temps total. Les events WFS sont matchés par `effectiveValidityWindow` (fenêtre temporelle) puis intersection géo (point dans polygone, ou plus proche waypoint).
- **Profil vent route** (`wind_profile.go`) : `flToNearestPressurePa` mappe FL → niveau de pression du WCS WIND (le WCS n'a pas tous les FL ; on prend le plus proche). Sample u,v au step temporel le plus proche de l'ETA waypoint, projeté en head/tail/cross via le bearing du segment. Le commit `fix(wind): caler le niveau de pression Wind sur le FL de l'avion suivi` impose : utiliser le FL réel de l'avion, pas le cruise FL planifié.

### Frontend / MapLibre

- **Slider temporel** : basé sur `validitystarttime` ; `isValidAt(slot)` filtre les features dont la fenêtre `[start, end)` contient l'instant choisi (permet de cumuler couches RDT 15 min + CAT 3 h).
- **Toggle-off d'une couche WFS purge `loaded[name]`** dans MapView pour que `collectSlots` voie immédiatement la disparition (sinon des slots zombies persistent).
- **Halo trajectoire RDT** : decorate les features avec `_fillOp`, `_lineOp`, `_lineW` calculés en JS, MapLibre lit `['get', '_fillOp']` (les expressions `interpolate`/`case` sur des strings ont posé problème).
- **Particules WindLayer** : canvas overlay avec `mix-blend-mode: screen`, advection en deg/s avec compensation `cos(lat)`. Les couches TROPO/QVACIS utilisent `image source` MapLibre (PNG canvas en data URL).
- **Filtre `interactiveLayerIds`** : `${name}-circle` ET `${name}-fill` (Points et Polygons cliquables).

## Limites connues (TODO)

- **Auth locale** : le portail est ouvert en `localhost`. Avant exposition extérieure, ajouter login/JWT + Postgres pour les comptes/sessions.
- **Cache stats** : pas d'endpoint `/api/cache/stats` — utile pour tuner le TTL.
- **Erreur 4xx du cache** : on ne cache que les 200, mais on ne fait pas de back-off sur les erreurs transitoires.
- **WFS pagination** : count=2000 récupère beaucoup de RDT_MSG, mais MetGate peut en avoir plus → on perd les surplus. Pas critique pour la visu.
- **Bbox QVACIS** : figée Atlantique/Sahara `[-33, 21, 36, 34]` car le coverage est régional ; ne suit pas la viewport.
- **Index ICAO aérodromes** : `ICAOIndex` lit le RAW de MetGate ; pas de fallback statique, donc `/api/route` dépend de la disponibilité MetGate côté DEP/ARR.
- **OpenSky history** : in-memory uniquement, perdu au redémarrage. Pas de persistance Postgres / fichier.

## Style et instructions globales utilisateur

Le `~/.claude/CLAUDE.md` global mentionne CHANGELOG, ROADMAP, fichiers `CIRRUS_OS`, `VERSION_TRAKING`, émulateur villegly, workspace à 3 git, identité `bmarty / bmarty@mailo.com`, méthode agile. **Aucun de ces artefacts n'est dans ce repo** ; c'est un projet isolé. L'identité git est configurée localement au repo (`bmarty / bmarty@mailo.com`). Avant d'agir sur ces consignes (créer CHANGELOG/ROADMAP, etc.), demander confirmation à l'utilisateur — elles correspondent à un autre workspace.
