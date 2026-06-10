<!--
Merci pour cette PR ! Vérifie les points suivants avant submission.
Pour une rustine de doc ou une typo : remplir au minimum "Résumé" et la checklist.
-->

## Résumé

<!-- Pourquoi cette PR (1-3 phrases) -->

## Changements

<!-- Liste à puces : ce qui change, où -->

-
-

## Issue liée

<!-- "Closes #123" ou "Refs #456", ou laisser vide si pas d'issue -->

Closes #

## Plan de test

<!-- Comment vérifier que ça marche, étapes reproductibles -->

- [ ]
- [ ]

## Captures (si UI)

<!-- Avant / après pour les modifs visuelles -->

## Checklist

- [ ] `make test` passe
- [ ] `make lint` passe (sauf justification)
- [ ] Commit message au format [Conventional Commits](https://www.conventionalcommits.org/fr/v1.0.0/) (`feat(map): ...`, `fix(opensky): ...`)
- [ ] Pas de secret committé (`.env`, token, key, certificat)
- [ ] Si nouvelle source de données : ajoutée au tableau *Sources de données* du `README.md` avec sa licence
- [ ] Si nouvelle env var : ajoutée à `.env.example` ET au tableau du `README.md` ET au `Secret` `deploy/k8s/metgate.yaml`
- [ ] Documentation à jour (`README.md`, `CLAUDE.md` si convention ou piège)
- [ ] J'accepte que ma contribution soit publiée sous licence [EUPL-1.2](../LICENSE)
