# Planche

Lecteur de BD, mangas et livres numériques multiplateforme (Tauri 2 + Rust + React).

## Lancer

```bash
npm install
npm run tauri dev      # développement
npm run tauri build    # installeur
```

Prérequis : Node 20+, Rust stable, et sous Windows les MSVC Build Tools + WebView2. Sous Linux, WebKitGTK 4.1 et les bibliothèques de développement listées dans [docs/LINUX.md](../docs/LINUX.md), qui détaille aussi l'installation des paquets `.deb`, `.rpm` et AppImage et la compilation automatique ([`.github/workflows/linux.yml`](../.github/workflows/linux.yml)).

## Architecture

| Fichier | Rôle |
|---|---|
| `src-tauri/src/lib.rs` | État, commandes IPC, protocole `planche://` (pages, vignettes, fichier brut PDF/EPUB) |
| `src-tauri/src/db.rs` | SQLite (migrations `user_version`) : `roots`, `shelves`, `books`, `standalone`, `bookmarks`, `annotations`, `kv` |
| `src-tauri/src/scan.rs` | Scan des dossiers racine → étagères et livres, réconciliation par chemin puis par empreinte |
| `src-tauri/src/storage.rs` | Accès aux fichiers : chemins sur ordinateur, documents `content://` du sélecteur Android (ContentResolver via JNI) |
| `src-tauri/plugins/planche-storage` | Module Kotlin des sélecteurs Android (dossier, fichier, enregistrement) |
| `src/platform.ts` | Différences de plateforme côté interface (sélecteurs Android, fonctions absentes) |
| `src-tauri/src/book.rs` | Ouverture des livres à pages : ZIP/EPUB image lus en place, RAR/7z/TAR extraits en cache ; tri EPUB image / texte |
| `src-tauri/src/meta.rs` | Métadonnées `ComicInfo.xml` et OPF, couverture des EPUB texte |
| `src-tauri/src/thumbs.rs` | Worker de fond : pages, vignettes, métadonnées |
| `src/Library.tsx` | Bibliothèque : étagères, séries, vues, signets, annotations, recherche, tri |
| `src/Reader.tsx` | Lecteur BD/PDF : modes de page, ajustement, manga, rognage, notes de page, recherche et lecture vocale des PDF, impression |
| `src/TextReader.tsx` | Lecteur EPUB texte (epub.js) : typographie, sommaire, recherche, surlignage et notes, lecture vocale, impression du chapitre |
| `src/Preferences.tsx` | Préférences : langue, lecture, typographie, voix, éditeur de raccourcis |
| `src/shortcuts.ts` | Registre des 61 actions et de leurs touches, détection des conflits |
| `src/tts.ts` | Lecture à voix haute (Web Speech API, voix du système), découpage en phrases |
| `src/annotations.ts` | Annotations et export Markdown / W3C Web Annotation (JSON) |
| `src/print.ts` | Impression via la boîte de dialogue de la WebView |
| `src/i18n.ts`, `src/locales/*.json` | 27 langues ; le français est la référence |

Données : `%APPDATA%\com.planche.reader\` (`library.db`, `thumbnails/`, `cache/`).

## Fonctions de liseuse

- **EPUB texte** : un EPUB dont les chapitres contiennent du texte (plus de 300 caractères par chapitre en moyenne, romans illustrés compris) s'ouvre dans le lecteur texte ; les EPUB composés d'images restent dans le lecteur BD.
- **Typographie** (panneau « Aa », touche O, ou Préférences) : police (dont police personnalisée), taille, interligne, espacement des lettres, des mots et des paragraphes, retrait, marges, longueur de ligne, alignement, césure, colonnes, paginé/défilement, thèmes clair/sépia/sombre/noir/personnalisé, option « ignorer la mise en forme de l'éditeur ».
- **Synthèse vocale** (🔊, touche R) : voix installées sur le système, vitesse, hauteur, surlignage du paragraphe lu, suivi des pages et chapitres. Disponible pour les EPUB texte et les PDF contenant du texte ; les BD sont des images, sans texte à lire.
- **Annotations** (✎, touche A ; H pour annoter) : surlignage en couleur et notes sur le texte sélectionné (EPUB), notes par page (BD/PDF), filtre par couleur, vue globale « Annotations », export **Markdown** ou **JSON W3C Web Annotation** (le format d'échange de Readium/Thorium).
- **Recherche dans le livre** (🔍, F3 ; Ctrl+G / Ctrl+Maj+G pour naviguer) : EPUB texte et PDF. Les pages de BD sont des images : la recherche y est indisponible.
- **Raccourcis clavier** : 61 actions, chacune avec plusieurs touches possibles, modifiables dans Préférences > Raccourcis (conflits détectés et réattribués), liste affichable avec F1.
- **Impression** (🖶, Ctrl+P) : page(s) affichée(s), tout le livre ou une plage (`1-5, 8, 10-`) pour les BD/PDF ; chapitre courant pour les EPUB texte.
- **Langues** : arabe (de droite à gauche), basque, catalan, chinois simplifié et traditionnel, danois, allemand, anglais, espagnol, estonien, finnois, français, galicien, grec, italien, japonais, lituanien, néerlandais, polonais, portugais (Brésil et Portugal), russe, slovène, suédois, tamoul, turc, tchèque. Hors français, les traductions ont été générées et mériteraient une relecture par des locuteurs natifs. `node scripts/i18n-keys.mjs <code>` vérifie qu'une langue est complète.

## Catalogues OPDS

- **Sources** : tout serveur OPDS 1.x (Atom) ou OPDS 2 (JSON) — Komga (`https://serveur/opds/v1.2/catalog`), Kavita (`https://serveur/api/opds/<clé API>`), Calibre-web (`https://serveur/opds`), bibliothèques publiques… Barre latérale > Catalogues > « Ajouter un catalogue », avec bouton « Tester la connexion ».
- **Navigation** : sous-catalogues, pagination (`next`/`previous`), recherche OpenSearch ou modèle OPDS 2, fiche détaillée (résumé, auteurs, formats), couvertures.
- **Téléchargement** : meilleur format lisible (CBZ > CBR > CB7 > EPUB > PDF…), progression affichée, fichier rangé dans `Documents/Planche/OPDS` — dossier ajouté automatiquement à la bibliothèque — puis bouton « Lire ».
- **Sécurité** (`src-tauri/src/opds.rs`) : authentification HTTP Basic ; mot de passe dans le coffre du système (Gestionnaire d'identification Windows, Trousseau macOS, Secret Service sous Linux), jamais dans la base ; identifiants envoyés uniquement à l'origine (schéma + hôte + port) du catalogue, y compris pour les couvertures, et retirés lors d'une redirection vers un autre hôte.
- Non pris en charge : authentification OPDS 2 « Authentication Document » (OAuth), lecture en streaming page par page (OPDS-PSE), DRM.

## Apparence et accessibilité

- **Thème** de l'application clair, sombre ou « comme le système » ; **taille de l'interface** 80–175 % (n'affecte pas les pages lues) ; option **réduire les animations** (respecte aussi le réglage du système) ; prise en charge des thèmes à contraste élevé de Windows.
- **Clavier** : contour de focus visible, lien « Aller au contenu », menu contextuel des livres au clavier (touche Menu ou Maj+F10, flèches, Échap), focus piégé dans les fenêtres et rendu à l'élément d'origine, Échap pour fermer.
- **Lecteurs d'écran** : boutons-icônes nommés, état des bascules (`aria-pressed`), vue courante (`aria-current`), messages et erreurs annoncés (`status`/`alert`), numéro de page annoncé en lecture, pages BD décrites (« Page N »), titre du livre sur le cadre EPUB, langue et sens d'écriture du document mis à jour avec la langue choisie.

## Comportements à connaître

- **Renommer / déplacer** : chaque livre a une empreinte de contenu (taille + début et fin du fichier, ou liste des images d'un dossier). Un livre introuvable dont l'empreinte correspond à un nouveau fichier est considéré comme déplacé : il garde progression, signets, annotations, favori et vignette.
- **Fichiers isolés** : « Ouvrir un fichier… », glisser-déposer, ou double-clic dans l'Explorateur. Un fichier déjà dans la bibliothèque ouvre son entrée ; sinon sa progression, ses signets et ses annotations sont gardés à part (table `standalone`).
- **Association de fichiers** : l'installateur associe `.cbz .cbr .cb7 .cbt .epub`. Les formats génériques (`.zip`, `.rar`, `.pdf`…) ne sont volontairement pas associés. Une seconde ouverture transmet le fichier à la fenêtre déjà ouverte. Sous Windows, un choix « toujours utiliser » antérieur pour `.epub` est conservé par Windows : le changer dans *Paramètres > Applications > Applications par défaut*.
- **Métadonnées** : `ComicInfo.xml` (titre, série, numéro, volume, année, auteurs) et OPF des EPUB (titre, auteurs, date, série EPUB 3 ou Calibre). Vue **Séries** triée série → volume → numéro.
- **Rognage automatique** (`src/crop.ts`) : chaque côté est rogné tant que les lignes ont la couleur unie du bord, dans la limite de 25 % par côté.

## Raccourcis par défaut (extrait)

| Touche | Action |
|---|---|
| → / ← | Avancer / reculer (selon le sens de lecture) |
| PageDown, S / PageUp, Z | Page suivante / précédente |
| Début / Fin | Début / fin du livre |
| Ctrl+PageDown / Ctrl+PageUp | Livre suivant / précédent |
| G | Aller à la page |
| T | Table des matières (EPUB texte) |
| B / Ctrl+B | Signets / ajouter un signet |
| A / H | Annotations / annoter |
| F3, / | Rechercher |
| R / Maj+R | Lecture vocale : lire-pause / arrêter |
| [ / ] | Lecture vocale plus lente / plus rapide |
| M, P, F, C | BD : manga, mode de page, ajustement, rognage |
| P, Maj+N, J | EPUB texte : paginé/défilement, thème, alignement |
| N | Mode nuit |
| O | Réglages de lecture |
| Ctrl+P | Imprimer |
| + / - / 0 | Zoom (taille du texte pour les EPUB) |
| Échap | Contrôles / fermer un panneau |
| Retour arrière | Bibliothèque |
| Ctrl+, | Préférences |
| F1 | Liste des raccourcis |
| F11, Ctrl+F | Plein écran |
