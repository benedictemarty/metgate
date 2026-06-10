# Politique de sécurité

## Versions supportées

| Version | Support sécurité |
|---------|------------------|
| `0.1.x` | ✅ branche `main` |
| `< 0.1` | ❌ |

À ce stade le projet est en pré-1.0 : seule la dernière version mineure publiée sur [GHCR](https://github.com/benedictemarty/metgate/pkgs/container/metgate) reçoit des correctifs.

## Signaler une faille

**Ne PAS ouvrir d'issue publique** pour signaler une vulnérabilité.

Deux canaux possibles :

1. **GitHub Security Advisories** *(recommandé)* :
   [github.com/benedictemarty/metgate/security/advisories/new](https://github.com/benedictemarty/metgate/security/advisories/new)
   Conversation privée chiffrée avec le mainteneur.

2. **Email** : `bmarty@mailo.com` avec objet `[security] MetGate — <résumé>`.
   Réponse sous 72 h ouvrées.

Inclure dans le rapport :
- Description du problème et de l'impact estimé.
- Étapes pour reproduire (PoC bienvenu).
- Version concernée (`docker inspect ghcr.io/benedictemarty/metgate:0.1.2 --format '{{index .Config.Labels "org.opencontainers.image.version"}}'`) ou commit SHA.
- Configuration utilisée (env vars activées, mode d'exposition).

## Processus de résolution

| Étape | Délai cible |
|-------|-------------|
| Accusé de réception | 72 h |
| Triage + sévérité estimée (CVSS) | 7 j |
| Correctif livré sur `main` | 30 j (CVSS ≥ 7.0) / 90 j (sinon) |
| Advisory publié + crédit | Après livraison |

Pour les failles critiques (CVSS ≥ 9.0), un patch hors cycle est livré en < 7 jours.

## Périmètre couvert

✅ Le code de ce repo :
- Backend Go (`cmd/`, `internal/`)
- Frontend SPA (`web/src/`)
- Manifests Docker / K8s (`Dockerfile`, `deploy/`)
- Workflows CI (`.github/workflows/`)

❌ Hors périmètre — à signaler en amont :
- API MetGate (Météo-France) → contact via portail MetGate
- API EUMETSAT Data Store → [eumetsat.int/security](https://www.eumetsat.int)
- API OpenSky Network → [opensky-network.org](https://opensky-network.org)
- Bibliothèques tierces — signaler directement aux upstream concernés

## Bonnes pratiques de déploiement

L'application **n'a pas d'authentification applicative à ce stade** (cf. `README.md` § *Limites connues*). Pour toute exposition publique :

1. Ajouter un rideau d'auth en frontal (oauth2-proxy, Authelia, basic auth Ingress).
2. Toujours servir derrière TLS (cert-manager + Let's Encrypt).
3. Restreindre l'egress réseau aux IPs MetGate / EUMETSAT / OpenSky uniquement (`NetworkPolicy` en K8s).
4. Stocker les tokens via un Secret K8s chiffré (Sealed Secrets / External Secrets / Vault), jamais dans un `ConfigMap` ni un `Dockerfile`.
5. Suivre les recommandations du `README.md` section *Déploiement* (image distroless `nonroot`, `readOnlyRootFilesystem`, `drop ALL caps`, `no-new-privileges`).
6. Pin des images par digest `@sha256:…` pour éviter le tag drift.

## Pipeline CI

Chaque release (tag `v*`) est scannée par **Trivy** (`severity: CRITICAL,HIGH`, `ignore-unfixed: true`). Le job échoue et le push GHCR est bloqué tant qu'une CVE corrigeable est présente. Les résultats SARIF sont remontés dans l'onglet **Security → Code scanning** du repo.

## Crédits

Les chercheurs ayant signalé une faille de manière responsable sont crédités dans l'advisory GitHub publié, sauf demande contraire.
