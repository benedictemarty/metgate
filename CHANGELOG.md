# CHANGELOG

Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Versionnage : [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `web/src/pages/TowerGlobe.tsx` : suppression de l'extrapolation côté client
  des positions avions. Le composant `AnimatedPlane` est remplacé par un
  composant `Plane` simple qui rend l'avion à la position OpenSky reçue,
  sans `useFrame`, sans interpolation, sans dead-reckoning. Choix produit :
  l'utilisateur préfère voir la position réelle ADS-B (au prix d'un saut
  toutes les 30 s) plutôt qu'une animation qui « reboote » ou diverge de la
  trajectoire réelle.
- `web/src/pages/TowerGlobe.tsx` (`Plane`) : géométrie d'avion explicite —
  fuselage cone 12 segments, ailes, empennage horizontal, **dérive
  verticale** (repère arrière non ambigu). Remplace l'ancienne pyramide à
  4 segments visuellement symétrique avant/arrière selon l'angle de caméra. Le pattern à 2 groupes
  (groupRef = ancre absolue, innerRef = offset extrapolé) provoquait un
  « reboot » visible toutes les 30 s : à l'arrivée du fetch, `groupRef`
  sautait à la nouvelle ancre tandis que `innerRef` gardait ~30 s
  d'extrapolation accumulée → l'avion bondissait loin devant puis « reculait »
  progressivement. Le useEffect ajuste désormais `innerRef.position` du
  delta inverse pour que la position visuelle reste continue.

## [0.2.0] — 2026-05-04 — Sprint « Durcissement avant exposition »

### Added

- `internal/ncutil` : helpers communs autour de `batchatco/go-native-netcdf`
  (ouverture depuis bytes via fichier temporaire, unpack CF-1.x, anyToFloat).
- `internal/http/params.go` : helpers `parseIntParam`, `parseFloatParam`,
  `parseBBoxParam` qui valident strictement les paramètres HTTP et
  retournent 400 sur format invalide.
- Header HTTP `X-Partial-Errors` sur `/api/products`, `/api/route`,
  `/api/aircraft/{icao24}/route` quand une partie des sources MetGate a
  échoué (le client peut afficher un bandeau dégradé).
- `RoutePlan.PartialFailures()` : familles WFS qui ont échoué pendant
  `RouteEvents` (le plan reste exploitable).
- `Aggregate.PartialFailures` : services KO (`RAW`/`WFS`/`WCS`) en cas de
  succès partiel.
- `airports.Store.LogStats()` : log au boot avec compteurs par cause de rejet
  (badICAO, parseErr, noGeometry, closed) pour détecter une corruption CSV.
- Documentation : `README.md` (lancement, env, endpoints, troubleshooting).
- Tests :
  - `internal/aircraft/opensky_test.go` : 5 cas de secrets exotiques + cache
    token + propagation 401.
  - `internal/catalog/route_test.go` : `gcDistance`, `gcInterpolate`,
    `pointInRing`, `projectAtBearing`, `nearestWaypoint`, `profileFL`,
    `ringCentroid`, `isInValidity`, `effectiveValidityWindow`,
    `addMinutesToISO`.
  - `internal/catalog/wind_profile_test.go` : `flToNearestPressurePa`,
    `bearingDegRoute`, `sampleStepUV` (centre + gradient bilinéaire),
    `parseISOToUnixMs`, `nearestUnixIndex`.
  - `internal/catalog/aggregate_test.go` : `familyOf`, `aggregateRaw`,
    `groupByFamily`.
  - `internal/catalog/cache_test.go` : hit/miss, expiration TTL, singleflight
    dédup (100 goroutines = 1 fetch), statut 500 non caché, clés distinctes,
    TTL=0, copie défensive de l'entrée.

### Changed

- `internal/aircraft/opensky.go` : `fetchToken` utilise `url.Values{}.Encode()`
  au lieu de `fmt.Sprintf` pour le form-urlencoded — corrige le 401 silencieux
  quand le `client_secret` contient `+`, `=`, `/`, `%`.
- `go.mod` : `go 1.26.2` (pre-release) → `go 1.24` (mini imposé par
  `batchatco/go-native-netcdf`). `golang.org/x/sync` downgradé `v0.20.0` →
  `v0.10.0`. Les deps directes ne sont plus marquées `// indirect`.
- `internal/airports/store.go` :
  - `loadAirports` / `loadRunways` distinguent `io.EOF` des autres erreurs et
    comptent les rejets par cause (parseErr, badICAO, noGeometry, closed).
  - Garde-fou : si > 20% des lignes sont vraiment corrompues
    (`parseErr`, hors filtre métier), `New()` retourne une erreur explicite.
- `internal/catalog/aggregate.go` : `AggregateProducts` ne fait plus
  all-or-nothing. Un seul service KO est loggé et exposé via
  `PartialFailures` ; les trois KO simultanés produisent toujours une erreur.
- `internal/catalog/route.go` : `RouteEvents` log les familles WFS en échec
  avec contexte (route DEP→ARR FL) au lieu de jeter silencieusement les
  erreurs ; les familles failed sont attachées au plan.
- `internal/http/handlers.go` : tous les `fmt.Sscanf` remplacés par les
  helpers `parseIntParam`/`parseFloatParam`/`parseBBoxParam`. Un paramètre
  invalide retourne 400 avec un message explicite, au lieu d'utiliser
  silencieusement la valeur par défaut.
- Cinq implémentations de fichier temporaire NetCDF (`wind.go`, `qvacis.go`,
  `tropo.go`, `lightning/service.go`, `cloudtop/service.go`) consolidées sur
  `ncutil.OpenBytes`. Helpers `unpackParams`/`anyToFloat` factorisés.

### Fixed

- OpenSky 401 silencieux après rotation de credentials (cf. ci-dessus).
- Boot avec airports.csv corrompu : le binaire ne tourne plus avec une base
  partielle sans le signaler. Logs explicites ; erreur fatale au-delà du
  seuil.
- `aggregate.go` : variables d'erreur masquées par `errors.Join` quand des
  services partiels avaient réussi (perte d'info utile pour l'opérateur).

### Notes opérationnelles

- Le frontend peut désormais lire le header `X-Partial-Errors` et afficher
  un badge « catalog dégradé : SIGMET temporairement indisponible » plutôt
  qu'un échec total.
- Les paramètres HTTP étant désormais stricts, vérifier que le frontend
  n'envoie pas de valeurs de fallback (`fl=NaN`, `bbox=undefined`) — elles
  produiront 400.

---

## [0.1.0] — 2026-04 (avant sprint)

Phase 1 « visualisation » livrée : carte interactive, catalogue 3-services,
suivi ADS-B avec plan de route synthétique, profil vent, intégrations
EUMETSAT (foudre, sommets nuageux, satellite).

Voir l'historique git pour le détail des commits antérieurs.
