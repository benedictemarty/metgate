# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## État du dépôt

Ce répertoire ne contient **aucun code source**, aucun système de build, aucun test, aucun script. Il n'est pas non plus un dépôt git. Son unique contenu est :

- `Default module.openapi.json` — spécification OpenAPI 3.0.1 (~30 000 lignes, 85 endpoints) décrivant l'API **MetGate** de Météo-France.

Toute affirmation sur des « commandes courantes » (build, lint, tests) ou une « architecture du code » serait inventée. Si l'utilisateur demande de telles opérations, lui signaler que le dépôt n'en contient pas le support et lui demander où se trouve le code applicatif.

## Ce que décrit la spécification OpenAPI

MetGate est un broker de données météorologiques exposé par Météo-France. Servers déclarés dans la spec :

- `https://metgate-mf.meteo.fr` (MG_PROD)
- `https://metgate-int.meteo.fr` (MG_INT)

Schémas de sécurité : `MG Basic`, `MG Bearer`, `bearer`.

Tags fonctionnels : `admin`, `common`, `dsna`, `crna/e`, `ectl`, `dwd` (consommateurs aéronautiques / météo européens).

Les endpoints sont regroupés par dossier `x-apidog-folder` (la spec est gérée via Apidog, projet `350764`) :

- **Admin / Broker** — gestion des rôles & URLs autorisées (`/accounts_privileges/roles/...`), des comptes utilisateurs (`/accounts_privileges/users/...`), des produits, instances de produits, capabilities et configuration du broker (`/admin_broker/...`).
- **Client / Subscription Management** — souscriptions aux produits (`/service_subscription/subscription/...`), avec opérations pause/activate/update.
- **Client / Token Management** — `/public/api/token/create`, `/public/api/token/check_validity`.
- **Client / AMQP Notifications** — `/amqp_notification/notification/{hmi_mode}/{max_msg}/{user_login}`.
- **Client / Services OGC** — catalogue + relais WFS 2.0.0 (vector) et WCS 2.0.1 (forecast) via `/broker_service/{catalog,WFS,WCS,RAW}`.
- **Schémas IWXXM** (`iwxxm/2023-1`, `iwxxm/3.0`), **opengis**, **Meteo France** — types de payloads référencés par les endpoints.

L'authentification est Bearer (JWT) sur la quasi-totalité des routes ; les descriptions sont rédigées en français dans le champ `description` de chaque opération.

## Travailler sur la spec

- Le fichier comporte des extensions propriétaires Apidog (`x-apidog-*`) qu'il faut préserver lors d'éditions manuelles si la spec doit rester synchronisée avec Apidog.
- Pour explorer/valider/dériver des clients : utiliser des outils standards OpenAPI (Redoc/Swagger UI/openapi-generator) en pointant directement sur le fichier — il n'y a pas de tooling configuré localement.
- Le nom de fichier contient un espace (`Default module.openapi.json`) : toujours le citer entre guillemets dans les commandes shell.

## Instructions globales utilisateur — applicabilité

Le `~/.claude/CLAUDE.md` global de l'utilisateur impose plusieurs règles de gestion (CHANGELOG, ROADMAP, fichiers `CIRRUS_OS` et `VERSION_TRAKING`, méthode agile, tests systématiques, commits git avec identité `bmarty`/`bmarty@mailo.com`, émulateur « villegly », workspace à 3 git). **Aucun de ces artefacts n'existe dans ce répertoire**. Avant d'agir sur ces consignes :

1. Demander à l'utilisateur où se trouve le workspace réel (les 3 dépôts git, l'émulateur villegly, les CHANGELOG/ROADMAP). Ce répertoire `metgate/` est manifestement isolé.
2. Ne pas créer ces fichiers d'office ici — ils n'auraient pas le bon emplacement.
3. Ne pas exécuter `git init` ni de commits sans confirmation : le répertoire est volontairement non-versionné en l'état actuel.
