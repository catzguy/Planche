# Planche

Lecteur de bandes dessinées, mangas, PDF et EPUB pour Windows, Linux et macOS (Tauri : Rust + React), avec annotations, lecture à voix haute, catalogues OPDS, 27 langues d'interface et une bibliothèque chiffrée.

| Dossier | Contenu |
|---|---|
| [`planche/`](planche/) | Code de l'application, compilation et architecture ([README](planche/README.md)) |
| [`docs/LINUX.md`](docs/LINUX.md) | Installation sous Linux |
| [`docs/SECURITE.md`](docs/SECURITE.md) | Revue de sécurité et protection de la base |
| [`docs/MICROSOFT_STORE.md`](docs/MICROSOFT_STORE.md) | Publication sur le Microsoft Store (mise en place et fonctionnement) |

**Télécharger** : [dernière version](https://github.com/catzguy/Planche/releases/latest) — installateur Windows (`.exe`, `.msi`) et paquets Linux (`.deb`, `.rpm`, AppImage). La pré-version [`develop-latest`](https://github.com/catzguy/Planche/releases/tag/develop-latest) contient la dernière version de test, compilée depuis `develop`.

## Compilation et publication automatiques

| Workflow | Quand | Résultat |
|---|---|---|
| [Windows](.github/workflows/windows.yml) | Chaque pull request vers `develop` ou `main` | Vérifie que tout compile (tests, langues, installateurs, paquet MSIX du Store) |
| [Release](.github/workflows/release.yml) | Chaque fusion dans `develop` | Remplace la pré-version `develop-latest` par les paquets Windows et Linux du dernier commit |
| [Release](.github/workflows/release.yml) | Étiquette `vX.Y.Z` | Crée la version « Planche X.Y.Z » avec tous les paquets et la liste des pull requests fusionnées, puis soumet le MSIX au Microsoft Store (une fois [configuré](docs/MICROSOFT_STORE.md)) |

**Publier une nouvelle version** :

1. Mettre le même numéro de version dans `planche/package.json`, `planche/src-tauri/Cargo.toml` et `planche/src-tauri/tauri.conf.json`, puis fusionner ce changement.
2. Créer l'étiquette sur le commit à publier : `git tag v0.2.0` puis `git push origin v0.2.0`, ou depuis la page *Releases > Draft a new release*.
3. Environ 15 minutes plus tard, la version est en ligne. Si l'étiquette ne correspond pas à la version de `tauri.conf.json`, la publication s'arrête avec une erreur.
