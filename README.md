# Planche

Lecteur de bandes dessinées, mangas, PDF et EPUB pour Windows, Linux et macOS (Tauri : Rust + React), avec annotations, lecture à voix haute, catalogues OPDS, 27 langues d'interface et une bibliothèque chiffrée.

| Dossier | Contenu |
|---|---|
| [`planche/`](planche/) | Code de l'application, compilation et architecture ([README](planche/README.md)) |
| [`docs/LINUX.md`](docs/LINUX.md) | Installation sous Linux |
| [`docs/SECURITE.md`](docs/SECURITE.md) | Revue de sécurité et protection de la base |

**Télécharger** : [dernière version](https://github.com/catzguy/Planche/releases/latest) — installateur Windows (`.exe`, `.msi`) et paquets Linux (`.deb`, `.rpm`, AppImage).

**Compilation automatique** (onglet *Actions*) : les workflows [« Windows »](.github/workflows/windows.yml) et [« Linux »](.github/workflows/linux.yml) produisent les paquets à chaque étiquette `v*` ou sur demande (*Run workflow*), dans les artefacts `planche-windows` et `planche-linux`. Le workflow Windows s'exécute aussi sur chaque pull request vers `develop` ou `main`.
