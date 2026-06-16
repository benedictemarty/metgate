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
- Mini-carte géographique (Natural Earth + FIR/UIR EUROCONTROL, 336 zones OACI)
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
  fir/               FIR/UIR mondiaux embarqués (EUROCONTROL EAD, 336 zones, GeoJSON ; cf. gen_fir.py)
  geo/               pays Natural Earth 110m embarqués (GeoJSON)
  http/              routes HTTP, handlers, spec OpenAPI embarquée
  web/               go:embed du frontend buildé (dist/)
web/src/             React 19 + TypeScript + MapLibre 5 + Three.js / R3F
```

Le frontend est embarqué dans le binaire via `go:embed` — **un seul fichier à déployer** (~30 MB).

---

## Prérequis

- Token applicatif **MetGate** (Météo-France) — obligatoire
- *(optionnel)* Clés **EUMETSAT** consumer_key / consumer_secret pour CTH / foudre / satellite
- *(optionnel)* Credentials **OpenSky** pour le suivi ADS-B
- Pour build source : Go ≥ 1.24, Node.js ≥ 22, GNU make

---

## Installation

L'installation se fait en **4 étapes** : récupérer les credentials → choisir un mode de déploiement → démarrer le service → valider.

### Étape 1 — Obtenir les credentials

Toutes les valeurs ci-dessous se mettent dans un fichier `.env` (ou un Secret Kubernetes selon le mode choisi). Le fichier `.env.example` du repo liste l'intégralité des variables avec leur commentaire.

| Source | Comment l'obtenir | Indispensable ? |
|---|---|---|
| **MetGate** (Météo-France) | Demander un token applicatif au gestionnaire MetGate (`metgate.meteo.fr`). Deux environnements : `https://metgate-int.meteo.fr` (intégration / dev) et `https://metgate-mf.meteo.fr` (PROD). | ✅ Oui |
| **EUMETSAT** | Créer un compte sur [eoportal.eumetsat.int](https://eoportal.eumetsat.int) → *My Profile* → *API Key* → générer un couple `consumer_key` / `consumer_secret`. | ⚠️ Optionnel — sans, `/api/lightning`, `/api/cloudtop`, `/api/satellite/tile` renvoient 503. |
| **OpenSky Network** | Compte gratuit sur [opensky-network.org](https://opensky-network.org) → *Personal Account Settings* → *Download credentials* (JSON `{clientId, clientSecret}`). | ⚠️ Optionnel — sans, `/api/aircraft/*` renvoie 503. |

> ⚠️ **Sécurité** : `chmod 600 .env` systématiquement. En K8s, utiliser un Secret (ou mieux : Sealed Secrets / External Secrets Operator).

### Étape 2 — Choisir le mode de déploiement

| Mode | Quand l'utiliser | Effort |
|---|---|---|
| **A. Docker** | Serveur unique, VM, Raspberry Pi, démo locale. C'est la voie recommandée par défaut. | 5 min |
| **B. Kubernetes** | Cluster existant, plusieurs replicas, exposition Internet avec TLS / auth en frontal. | 10 min |
| **C. Build source** | Dev local avec hot reload, modification du code, tests, contribution. | 10 min + dépendances Go/Node |

---

### A. Docker (recommandé)

Image multi-stage distroless publiée sur GHCR à chaque tag : **~32 MB**, user `nonroot` (uid 65532), pas de shell, base pinée par digest, scan Trivy CVE en CI.

```bash
# 2.A.1 — Préparer le fichier de configuration
curl -O https://raw.githubusercontent.com/benedictemarty/metgate/main/.env.example
mv .env.example .env
$EDITOR .env                            # remplir METGATE_TOKEN, EUMETSAT_*, OPENSKY_*
chmod 600 .env                          # ⚠️ contient des secrets

# 2.A.2 — Lancer le conteneur
docker run -d --name metgate \
  --env-file .env \
  -p 8080:8080 \
  --restart unless-stopped \
  --read-only --tmpfs /tmp:size=64m \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  ghcr.io/benedictemarty/metgate:latest
```

**Tags disponibles** : `latest` (HEAD de `main`), `vX.Y.Z` (release sémantique), `X.Y`, `X`, `sha-<short>` (commit GitHub).
**Build local** (sans pull GHCR) : `docker build -t metgate:dev . && docker run … metgate:dev`.

**Options recommandées** :
- `--read-only --tmpfs /tmp` : rootfs immuable, seul `/tmp` accessible en écriture en mémoire.
- `--security-opt no-new-privileges` : impossibilité de gagner des privilèges au runtime.
- `--cap-drop ALL` : aucune capability Linux conservée.
- `--restart unless-stopped` : redémarrage auto sauf arrêt manuel.

**Docker Compose équivalent** (si tu préfères) : un `docker-compose.yml` prêt à
l'emploi est fourni à la racine du repo — `docker compose up -d`. Il charge le
`.env` et expose en `${VAR:-défaut}` les URLs des services extérieurs (MetGate,
OpenSky, adsb.fi, EUMETSAT, EUMETView) ainsi que la configuration du proxy
sortant (`OUTBOUND_PROXY_URL`, `NO_PROXY`, `OUTBOUND_CA_FILE`), pour pointer un
miroir interne ou traverser un proxy d'entreprise sans rebuild.

---

### B. Kubernetes

Manifest minimal fourni dans `deploy/k8s/metgate.yaml` : Deployment 2 replicas + Service ClusterIP. SecurityContext durci : `runAsNonRoot` (uid 65532), `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`. Probes HTTP `/healthz` (readiness 10 s, liveness 30 s), requests modestes (50m CPU / 64 Mi).

```bash
# 2.B.1 — Créer le Secret (JAMAIS committé)
kubectl create secret generic metgate-secret \
  --from-literal=METGATE_TOKEN='votre-token-metgate' \
  --from-literal=EUMETSAT_CONSUMER_KEY='votre-key' \
  --from-literal=EUMETSAT_CONSUMER_SECRET='votre-secret' \
  --from-literal=OPENSKY_CLIENT_ID='votre-client-id' \
  --from-literal=OPENSKY_CLIENT_SECRET='votre-client-secret'

# 2.B.2 — Appliquer le manifest
kubectl apply -f deploy/k8s/metgate.yaml

# 2.B.3 — Vérifier
kubectl get pods -l app=metgate
kubectl logs -l app=metgate --tail=20
```

**Pour modifier le namespace, l'image ou les replicas** : éditer `deploy/k8s/metgate.yaml` (champ `metadata.namespace`, `spec.template.spec.containers[0].image`, `spec.replicas`).

**Pour exposer publiquement** (non inclus dans le manifest, à ajouter selon ton stack) :
1. **Ingress** + **cert-manager** pour TLS Let's Encrypt.
2. **oauth2-proxy** / **Authelia** / **Pomerium** en frontal — ⚠️ **le portail n'a pas d'auth applicative**, ne pas exposer sans rideau.
3. **NetworkPolicy** egress restreinte aux IPs MetGate / OpenSky / EUMETSAT.

Exemple snippet Ingress nginx + cert-manager (à adapter, non fourni par défaut) :

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: metgate
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/auth-url: "https://oauth2-proxy.example.com/oauth2/auth"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [metgate.example.com]
      secretName: metgate-tls
  rules:
    - host: metgate.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: metgate
                port: { number: 80 }
```

---

### C. Build source

À utiliser pour le développement, la modification du code ou la contribution.

```bash
# 2.C.1 — Cloner et configurer
git clone https://github.com/benedictemarty/metgate
cd metgate
cp .env.example .env
$EDITOR .env && chmod 600 .env

# 2.C.2 — Dépendances frontend (lockfile committé : utiliser ci pour install reproductible)
cd web && npm ci && cd ..

# 2.C.3 — Build complet (frontend → dist embarqué dans le binaire Go)
make build              # produit ./bin/portal (~32 MB, statique, CGO=0)
./bin/portal
```

**Hot-reload pour le dev frontend** (2 terminaux) :

```bash
# Terminal 1 — backend Go
make run                # :8080

# Terminal 2 — Vite avec proxy /api → :8080
make web-dev            # :5173
```

Ouvrir [http://localhost:5173](http://localhost:5173) (dev) ou [http://localhost:8080](http://localhost:8080) (prod).

---

### Étape 3 — Vérifier que ça tourne

```bash
# Sonde santé (toujours 200 si le binaire démarre)
curl http://localhost:8080/healthz
# → {"status":"ok"}

# Vérifier la connexion à MetGate (token + base URL OK ?)
curl 'http://localhost:8080/api/products' | jq '.[0]'

# Vérifier EUMETSAT (si configuré)
curl -I 'http://localhost:8080/api/cloudtop?bbox=-10,40,15,55&minfl=200'
# → 200 OK si EUMETSAT_CONSUMER_KEY/SECRET valides
# → 503 si clés absentes ou invalides

# Vérifier OpenSky (si configuré)
curl 'http://localhost:8080/api/aircraft/search?q=AFR'
# → 200 OK si OAuth OpenSky OK ; 503 sinon
```

**Logs structurés** (slog JSON) à surveiller :

| Niveau / message | Signification |
|---|---|
| `INFO eumetsat MTG: désactivé (clés absentes…)` | `EUMETSAT_CONSUMER_KEY/SECRET` vides — endpoints CTH / foudre / sat HS, normal en dev. |
| `INFO opensky: désactivé (credentials absents)` | `OPENSKY_*` vides — endpoints `/api/aircraft/*` HS, normal en dev. |
| `ERROR METGATE_BASE_URL et METGATE_TOKEN doivent être définis` | `.env` non chargé ou variables vides — vérifier `--env-file` ou le Secret. |
| `WARN impossible de lire .env` | Mode Docker / K8s : normal (pas de fichier `.env` dans l'image, tout passe par les variables). |

### Étape 4 — Dépannage

| Symptôme | Cause probable | Action |
|---|---|---|
| `503 metgate WFS GetFeature` | Token MetGate invalide, expiré ou environnement faux (`int` vs `mf`). | Vérifier `METGATE_TOKEN` et `METGATE_BASE_URL`. |
| `503 lightning indisponible` / `503 cloudtop indisponible` | `EUMETSAT_CONSUMER_KEY/SECRET` absents ou révoqués. | Régénérer les clés sur eoportal, mettre à jour Secret / `.env`, redémarrer le pod / conteneur. |
| Carte vide, pas de POI | CORS / Content Security Policy bloqué par un reverse proxy. | Vérifier que le proxy laisse passer `application/geo+json` et `image/png`. |
| Pod K8s en `CrashLoopBackOff` | Secret manquant ou nom de clé incorrect. | `kubectl describe pod -l app=metgate` puis `kubectl logs`. |
| Conteneur Docker s'arrête tout de suite | `.env` non monté ou variables manquantes. | `docker logs metgate` : doit afficher l'erreur `METGATE_BASE_URL et METGATE_TOKEN doivent être définis`. |
| Premier appel `/api/lightning` lent (~30 s) | Téléchargement du NetCDF MTG-LI initial chez EUMETSAT, comportement normal. | Le 2e appel passe par le cache (latence < 100 ms). |
| Trace ADS-B disparaît au restart | Le buffer `history` est en mémoire (cf. CLAUDE.md). | Comportement attendu, persistance non implémentée. |

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

### Pipeline release (GitHub Actions)

À chaque tag `v*` poussé, le workflow `.github/workflows/release.yml` :

1. Build amd64 local.
2. Scan **Trivy** (CRITICAL+HIGH, `ignore-unfixed`) — bloque le job si CVE corrigeables. Résultats SARIF remontés dans l'onglet **Security** GitHub.
3. Si scan OK : build multi-arch `linux/amd64` + `linux/arm64` et push sur `ghcr.io/benedictemarty/metgate`.

Lancement ad-hoc sans tag : `Actions → Release → Run workflow`.

### Binaire (systemd / LXC / VM)

Build cross-compilé sortant en `bin/portal` (~32 MB statique, CGO désactivé) :

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

Le `Makefile` inclut une cible `make deploy` qui pousse le binaire sur un LXC Proxmox via SCP + `pct mount` (variables `PROXMOX_SSH`, `PROXMOX_PORT`, `LXC_ID`, `LXC_DEST` en haut du Makefile à adapter).

---

## Sources de données

| Source | Usage |
|---|---|
| [MetGate — Météo-France](https://metgate.meteo.fr) | METAR, TAF, SIGMET, AIRMET, MAA, vent, tropopause, cendres |
| [OpenSky Network](https://opensky-network.org) | Suivi ADS-B temps réel |
| [EUMETSAT Data Store](https://data.eumetsat.int) | MTG-FCI CTTH (sommets nuageux), MTG-LI (foudre) |
| [EUMETView WMS](https://view.eumetsat.int) | Tuiles satellite FCI IR / RGB Convection |
| [OurAirports](https://ourairports.com/data/) | Aérodromes, pistes, coordonnées (CC0) |
| [EUROCONTROL atlas (EAD)](https://github.com/euctrl-pru/eurocontrol-atlas) | FIR/UIR OACI mondiales, 336 zones, contours haute résolution (MIT) |
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

Les données tierces conservent leur licence d'origine : FIR/UIR EUROCONTROL atlas/EAD (MIT), Natural Earth (domaine public), OurAirports (CC0).
