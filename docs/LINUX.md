# Planche sous Linux

Planche est une application Tauri : le même code tourne sous Windows, macOS et Linux. Sous Linux, l'interface s'affiche avec **WebKitGTK** (au lieu de WebView2 sous Windows) et la clé de la base est rangée dans le **Secret Service** (GNOME Keyring, KWallet, KeePassXC…).

## Distributions prises en charge

Toute distribution de bureau 64 bits qui fournit **WebKitGTK 4.1** :

| Distribution | Version minimale |
|---|---|
| Ubuntu, Linux Mint, Pop!_OS, elementary OS, Zorin | Ubuntu 22.04 / Mint 21 |
| Debian | 12 (Bookworm) |
| Fedora | 36 |
| openSUSE | Tumbleweed, Leap 15.5 |
| Arch, Manjaro, EndeavourOS | à jour |

Environnements de bureau : GNOME, KDE Plasma, Cinnamon, XFCE, MATE, Budgie… en X11 comme en Wayland.

## Obtenir les paquets

Un installateur Linux ne peut pas être produit depuis Windows : il se compile **sur Linux**. Deux possibilités.

### 1. Compilation automatique (GitHub Actions)

Le fichier `.github/workflows/linux.yml` compile Planche sur un serveur Linux de GitHub et publie trois paquets :

- `Planche_0.1.0_amd64.deb` — Debian, Ubuntu, Mint ;
- `Planche-0.1.0-1.x86_64.rpm` — Fedora, openSUSE ;
- `Planche_0.1.0_amd64.AppImage` — toutes distributions, sans installation.

Lancer le workflow « Linux » (onglet *Actions*) ou pousser une étiquette `v0.1.0`. Les paquets sont dans l'artefact `planche-linux`.

### 2. Compilation sur le poste Linux

Dépendances de compilation :

```bash
# Debian / Ubuntu / Mint
sudo apt install build-essential curl wget file libwebkit2gtk-4.1-dev libssl-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libxdo-devel libappindicator-gtk3-devel librsvg2-devel gcc-c++
sudo dnf group install c-development

# Arch / Manjaro
sudo pacman -S --needed base-devel webkit2gtk-4.1 openssl curl wget file xdotool libappindicator-gtk3 librsvg
```

Puis Node.js 20+ et Rust (`curl https://sh.rustup.rs -sSf | sh`), et dans le dossier `planche/` :

```bash
npm ci
npm run tauri build
```

Les paquets sont produits dans `src-tauri/target/release/bundle/` (`deb/`, `rpm/`, `appimage/`).

## Installer

```bash
# Debian / Ubuntu / Mint (installe aussi WebKitGTK si besoin)
sudo apt install ./Planche_0.1.0_amd64.deb

# Fedora / openSUSE
sudo dnf install ./Planche-0.1.0-1.x86_64.rpm

# AppImage (toute distribution)
chmod +x Planche_0.1.0_amd64.AppImage && ./Planche_0.1.0_amd64.AppImage
```

Avec le `.deb` ou le `.rpm`, Planche apparaît dans le menu des applications et s'enregistre pour les types `.cbz`, `.cbr`, `.cb7`, `.cbt` et `.epub`. L'AppImage ne s'intègre pas au menu ni aux associations de fichiers (sauf avec un outil comme AppImageLauncher ou Gear Lever).

### Faire de Planche le lecteur par défaut

Dans le gestionnaire de fichiers (Nautilus, Dolphin, Nemo, Thunar) : clic droit sur un fichier `.epub` ou `.cbz` > *Ouvrir avec* > Planche > *Définir par défaut* / *Toujours utiliser*. En ligne de commande :

```bash
desktop=$(basename "$(grep -l '^Exec=planche' /usr/share/applications/*.desktop)")
xdg-mime default "$desktop" application/epub+zip application/vnd.comicbook+zip application/vnd.comicbook-rar application/x-cb7 application/x-cbt
```

## Où sont les données

| Contenu | Emplacement |
|---|---|
| Bibliothèque chiffrée, vignettes, cache des pages | `~/.local/share/com.planche.reader/` |
| Clé de la base | Secret Service (« Planche / library-database-key ») |
| Clé de secours (seulement sans Secret Service) | `~/.config/com.planche.reader/library.key` (lisible par toi seul) |
| Livres téléchargés depuis un catalogue OPDS | `~/Documents/Planche/OPDS/` (ou `~/Documents` traduit) |

## Différences avec Windows

| Fonction | Linux |
|---|---|
| Bibliothèque, lecteur BD/PDF/EPUB, signets, rognage, annotations, recherche, raccourcis, 27 langues, thèmes, OPDS | Identique. |
| Chiffrement de la base | Identique, clé dans le Secret Service. **Sans** Secret Service (gestionnaire de fenêtres minimal, certaines installations XFCE), la clé est gardée dans un fichier réservé à ton compte, dans `~/.config` (séparé des données) : la base reste illisible si seul le dossier de données est copié, mais la protection est moindre. Dès qu'un Secret Service est disponible, la clé y est déplacée et le fichier effacé. Si le trousseau est verrouillé au démarrage, il demande ton mot de passe de session. |
| Lecture à voix haute | Dépend de WebKitGTK : la synthèse vocale n'est présente que si ta distribution a compilé WebKitGTK avec cette option. Sinon, Planche affiche « Aucune voix de synthèse n'est disponible » au lieu de lire. |
| Impression | Boîte d'impression GTK du système. |
| « Ouvrir avec une autre application » (EPUB que Planche ne peut afficher) | Il n'existe pas de sélecteur standard sous Linux : Planche ouvre le dossier du fichier dans le gestionnaire de fichiers. |
| Polices du réglage typographique | Georgia, Verdana, Palatino, Consolas… sont rarement installées : Planche utilise leurs équivalents Linux (Liberation, DejaVu, Noto, TeX Gyre Pagella, URW P052). Le paquet `ttf-mscorefonts-installer` (Debian/Ubuntu) donne les polices d'origine. |
| Thèmes à contraste élevé | Ceux de Windows uniquement ; sous Linux, utiliser le thème sombre de Planche et la taille d'interface. |

## Ce qui a été vérifié

- **Code** : revue de toutes les parties propres à une plateforme. Ce qui dépend de Windows (sélecteur « Ouvrir avec », sous-système de fenêtre) est isolé et a un équivalent Linux ; les dépendances Rust sont toutes compatibles Linux (le coffre passe par le Secret Service en Rust pur, sans libdbus).
- **Corrigé pour Linux** :
  - Le lecteur PDF utilisait des fonctions JavaScript très récentes (`Map.getOrInsertComputed`, `Math.sumPrecise`…) qu'il appelait sans repli et qui manquent aux versions de WebKitGTK des distributions. Il utilise désormais la version de pdf.js qui les fournit lui-même.
  - Sans Secret Service, Planche ne démarrait pas (clé de la base introuvable) : ajout de la clé de secours décrite plus haut, avec test.
  - Seul le `.cbz` aurait été associé à Planche (un seul type MIME déclaré pour les quatre extensions BD) : chaque extension a maintenant son type.
  - La lecture à voix haute provoquait une erreur sans synthèse vocale : message clair à la place.
- **Non-régression sous Windows** : version de production recompilée, PDF affiché par la nouvelle version de pdf.js, bibliothèque et progression intactes, 6 tests Rust passés (dont la clé de secours). Ce test a aussi révélé et fait corriger un bug valable sur toutes les plateformes : après la migration vers la base chiffrée, Planche plantait au démarrage suivant (en-tête « WAL » hérité de l'ancien fichier SQLite).
- **Pas encore vérifié** : un lancement réel sous Linux. Ce PC n'a ni WSL ni machine virtuelle Linux ; la première compilation (GitHub Actions ou poste Linux) fera foi.
