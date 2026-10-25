# Planche vs Thorium Reader 3.5.1

Thorium : version installée dans `C:\Program Files\Thorium` (EDRLab, open source BSD-3). Analyse statique de `resources\app.asar` (`package.json`, bundles webpack `main.js`, `index_library.js`, `index_reader.js`, `index_pdf.js`) et de ses 863 textes d'interface (traduction française embarquée). Rien n'a été exécuté côté Thorium.
Planche : état actuel du dépôt `Planche/planche` (https://github.com/catzguy/Planche).

## En une phrase

Thorium est une **liseuse d'ebooks accessible** (EPUB, livres audio, PDF, DRM LCP, catalogues de bibliothèques publiques) qui sait aussi afficher quelques formats BD ; Planche est un **lecteur de BD/mangas** centré sur la gestion d'une collection de fichiers locaux. Ils se recouvrent peu.

## Socle technique

| | Thorium 3.5.1 | Planche 0.1 |
|---|---|---|
| Base | Electron (Chromium embarqué) + Readium, React/Redux | Tauri 2 (WebView système) + Rust, React |
| Taille installée | **394 Mo** (exe de 224 Mo) | **9 Mo** d'exe, installeur 3,5 Mo |
| Stockage | Copie chaque livre dans son propre dossier `publications` (+ « stockage supplémentaire » en bêta) ; base SQLite | Lit les fichiers **là où ils sont** ; base SQLite |
| Réseau | Mises à jour auto, télémétrie (`telemetry.edrlab.org`), catalogues OPDS | Aucun accès réseau |
| Natif | `lcp.node` (DRM LCP), `windows-registry.node` | unrar, 7z, zip, image (Rust) |

## Formats

| Format | Thorium | Planche |
|---|---|---|
| EPUB 2/3 texte (refondable) | ✅ cœur du produit | ❌ (images uniquement) |
| EPUB à mise en page fixe / images | ✅ | ✅ (images, ordre du spine) |
| PDF | ✅ (pdf.js) | ✅ (pdf.js) |
| CBZ / ZIP | ⚠️ parseur CBZ présent, mais `.cbz` **absent de la liste des extensions importables** (`.zip` y est) — non vérifié à l'exécution | ✅ |
| CBR / RAR, CB7 / 7z, CBT / TAR | ❌ | ✅ (y compris faux .cbr qui sont des zip) |
| Dossier d'images | ❌ | ✅ |
| Divina (BD numérique Readium) | ✅ | ❌ |
| Livres audio (.audiobook, W3C .lpf, Readium) | ✅ | ❌ |
| DAISY | ✅ | ❌ |
| DRM LCP (.lcpl, .lcpdf, .lcpa) | ✅ prêt, retour, renouvellement | ❌ |

## Bibliothèque

| | Thorium | Planche |
|---|---|---|
| Ajout | Import fichier par fichier (copie) ou glisser-déposer | Dossiers entiers, scan récursif, actualisation |
| Organisation | Liste plate + **mots-clés** ; vue grille ou tableau | **Étagères = arborescence des dossiers** |
| Tri / filtres | Titre, auteur, langue, état de lecture ; filtres combinables | Nom, date d'ajout ; vues En cours / Non lus / Favoris / Récents / Signets |
| Recherche | Titre, auteur, format, mot-clé | Nom |
| Métadonnées | Riches (auteur, éditeur, langue, accessibilité…) | Nom de fichier uniquement |
| Fichiers renommés / déplacés | N/A (Thorium garde sa copie) ; « Fichiers manquants » si stockage externe | ✅ reconnus par empreinte, progression conservée |
| Catalogues en ligne | ✅ OPDS + catalogues des bibliothèques publiques françaises, connexion, téléchargements | ❌ |
| Favoris | Sur les catalogues | Sur les livres |

## Lecteur

| | Thorium | Planche |
|---|---|---|
| Une / deux pages, couverture seule | 1 ou 2 colonnes (EPUB) | ✅ 1, 2, 2 + couverture seule, avec page large isolée automatiquement |
| Défilement continu | ✅ (mode défilé) | ✅ |
| Ajustement largeur / hauteur / page | PDF : 50–500 %, largeur, page entière | ✅ + zoom |
| Mode manga (droite → gauche) | Suit le sens déclaré par l'EPUB | ✅ bascule par livre ou par étagère |
| Rognage automatique des marges | ❌ | ✅ |
| Mise en forme du texte (police, taille, interlignes, marges, justification, thèmes) | ✅ très complète, préréglages | ❌ (pas de texte) |
| Synthèse vocale, lecture audio synchronisée (Media Overlays) | ✅ | ❌ |
| Signets | ✅ avec libellé | ✅ avec nom, vue globale « Signets » |
| Annotations, surlignage, export/import des notes | ✅ (couleurs, tags, export) | ❌ |
| Recherche dans le livre | ✅ | ❌ |
| Table des matières, aller à la page, historique | ✅ | Curseur de pages |
| Mode nuit / couleur de fond | Thèmes de lecture | ✅ variateur + couleur de fond |
| Raccourcis clavier | ✅ ~65 actions, personnalisables | Fixes (≈20) |
| Impression | ✅ (avec limites LCP) | ❌ |
| Livre suivant / précédent | ❌ | ✅ dans l'étagère |
| Mode Zen, plein écran | ✅ | Plein écran |
| Accessibilité (lecteurs d'écran, métadonnées a11y) | ✅ point fort majeur | Basique |

## Intégration système

| | Thorium | Planche |
|---|---|---|
| Ouvrir un fichier hors bibliothèque | Le fichier est importé (copié) | ✅ lu sur place, progression gardée à part |
| Association de fichiers | EPUB, PDF, audio, LCP… | .cbz .cbr .cb7 .cbt |
| Instance unique | ✅ | ✅ |
| Session (rouvrir les livres ouverts) | ✅ | Reprend la page, pas les fenêtres |
| Plusieurs fenêtres de lecture | ✅ | ❌ (une vue) |
| Thème clair / sombre de l'app | ✅ | Sombre uniquement |
| Langues de l'interface | 27 | Français |

## Ce que ça veut dire pour Planche

- **Pas de concurrence frontale** : pour une collection de BD en CBR/CB7/CBZ rangée en dossiers, Planche fait ce que Thorium ne fait pas (formats d'archive, étagères = dossiers, lecture sur place, double page intelligente, manga, rognage, livre suivant).
- **Ce que Thorium fait mieux et qu'il serait raisonnable de reprendre** :
  1. Raccourcis clavier personnalisables (Cover le faisait aussi).
  2. Recherche/filtres plus riches : mots-clés, état de lecture, tri combiné.
  3. Métadonnées : lire `ComicInfo.xml` (standard des CBZ/CBR) pour titre, série, numéro, auteurs.
  4. Thème clair et accessibilité de base (navigation clavier, libellés ARIA).
  5. OPDS : beaucoup de serveurs de BD (Komga, Kavita, Calibre-web) exposent un catalogue OPDS ; ce serait le pendant « cloud » de Planche.
- **À ne pas reprendre** : EPUB texte, synthèse vocale, LCP, annotations de texte — c'est le métier de Thorium, et la taille/complexité de Readium ne se justifie pas pour un lecteur de BD.
