# Contribuer à MetGate

Merci de l'intérêt porté au projet ! Toute contribution est la bienvenue : correction de bug, ajout de produit MetGate, amélioration UI, documentation, traduction, etc.

## Avant de commencer

- Lire le [`README.md`](README.md) pour comprendre l'architecture et lancer le projet en local.
- Lire le [`CLAUDE.md`](CLAUDE.md) pour les conventions internes (pièges WCS NetCDF, WFS GML, OpenSky throttling, etc.).
- Consulter les [issues ouvertes](https://github.com/benedictemarty/metgate/issues) — un label `good first issue` signale les sujets accessibles.
- Pour une grosse modification, **ouvrir d'abord une issue** pour discuter de l'approche avant d'écrire du code.

## Workflow

1. **Fork** du repo + clone local
2. Créer une branche depuis `main` :
   ```bash
   git checkout -b feat/ma-fonctionnalite      # ou fix/, chore/, docs/
   ```
3. Coder en respectant les conventions ci-dessous
4. Lancer les tests : `make test`
5. Lancer le lint : `make lint`
6. Commit avec message [Conventional Commits](https://www.conventionalcommits.org/fr/v1.0.0/) :
   - `feat(map): ajouter overlay givrage WCS`
   - `fix(opensky): retry exponentiel sur 429`
   - `docs(install): clarifier étape EUMETSAT`
   - `chore(deps): bump go 1.26 → 1.27`
7. Push vers ton fork puis ouvrir une Pull Request vers `main`
8. La CI lance les tests + build Docker + scan Trivy : tous doivent passer.

## Conventions de code

### Go (`internal/`, `cmd/`)

- `gofmt` / `goimports` obligatoires (lancés par `make lint`).
- `golangci-lint v2` doit passer sans warning.
- Erreurs en français côté logs slog ; identifiants techniques en anglais (`err`, `req`, etc.).
- Pas de panic, retourner des erreurs typées.
- Commentaires de package (`// Package xxx ...`) sur chaque nouveau package.
- Tests : `*_test.go` à côté du code, table-driven quand possible.

### Frontend (`web/src/`)

- React 19 + TypeScript strict.
- Tailwind v4 utility-first ; pas de CSS module sauf cas particulier.
- Imports triés par ESLint (configuration commitée).
- Pas de `any` sauf justification commentée.
- Composants en PascalCase, hooks en camelCase préfixés `use`.

### Commits & PR

- Un commit = un changement logique cohérent (pas de « WIP » en main).
- Message en français, format conventional.
- PR avec description claire (cf. template) : pourquoi, quoi, comment tester.
- Squash & merge utilisé sur `main` — pas de force-push après review.

## Lancer en local

```bash
cp .env.example .env       # remplir METGATE_TOKEN + creds optionnelles
chmod 600 .env

cd web && npm ci && cd ..  # dépendances frontend
make build                 # binaire embarquant le dist React
./bin/portal               # http://localhost:8080

# Ou en dev hot-reload (2 terminaux) :
make run                   # backend :8080
make web-dev               # vite :5173
```

## Tests

```bash
make test                  # go test ./...
make lint                  # golangci-lint v2
```

Si tu touches au parseur GML / WCS / décodeur TAC : penser à ajouter une fixture dans `internal/catalog/testdata/` et un cas dans le test correspondant.

## Sources de données externes

Toute nouvelle source (API tierce, dataset embarqué) doit :
- être documentée dans le `README.md` (section *Sources de données*) avec sa licence ;
- voir sa clé d'accès passée par variable d'environnement (jamais hardcodée) ;
- échouer en mode dégradé (503) si la clé est absente, plutôt que de planter le binaire.

## Sécurité

Voir [SECURITY.md](SECURITY.md) — **ne pas ouvrir d'issue publique pour une faille**, contacter le mainteneur par email.

## Licence

En soumettant une PR, tu acceptes que ta contribution soit publiée sous la licence du projet : [EUPL-1.2](LICENSE).

## Questions

Ouvre une [Discussion GitHub](https://github.com/benedictemarty/metgate/discussions) ou contacte `bmarty@mailo.com`.
