# Planche sur Android

Planche fonctionne sur les téléphones et tablettes **Android 8.0 ou plus récent**. C'est la même application que sur ordinateur (Tauri : moteur Rust, interface web), adaptée aux écrans tactiles.

## Installer

### Depuis GitHub (APK)

1. Sur le téléphone, ouvrir la [dernière version](https://github.com/catzguy/Planche/releases/latest) et télécharger `Planche_<version>_android.apk`.
2. Ouvrir le fichier téléchargé. Android demande d'autoriser l'installation depuis le navigateur (« sources inconnues ») : accepter pour cette seule installation.

La pré-version [`develop-latest`](https://github.com/catzguy/Planche/releases/tag/develop-latest) contient l'APK de test le plus récent.

### Depuis Google Play

À venir : voir « Publier sur Google Play » plus bas.

## Utiliser

- **Ajouter un dossier** : le sélecteur de fichiers d'Android s'ouvre ; choisir le dossier qui contient les BD (par exemple `Download/BD` ou un dossier de carte SD), puis **Utiliser ce dossier** et **Autoriser**. Planche garde ce droit de lecture après redémarrage, et uniquement pour ce dossier (Android interdit d'en choisir certains, comme la racine du stockage ou `Download` entier).
- **Ouvrir un fichier** : même sélecteur, pour lire un fichier isolé.
- **Lire** : toucher le bord droit ou gauche, ou glisser du doigt, pour tourner la page (sens inversé en mode manga) ; toucher le centre affiche les commandes.
- **Bouton Retour d'Android** : ferme la fenêtre ou le panneau ouvert, puis le lecteur, puis remonte dans les dossiers ; à la racine de la bibliothèque, quitte Planche.
- **Menu ☰** (en haut à gauche) : vues, catalogues, dossiers, préférences.

Formats : CBZ, CBR, CB7, CBT, PDF, EPUB (BD et romans) et dossiers d'images, comme sur ordinateur.

## Différences avec l'ordinateur

| Fonction | Android |
|---|---|
| Accès aux fichiers | Uniquement les dossiers et fichiers choisis dans le sélecteur d'Android. |
| Clé de la base chiffrée | Dans l'espace privé de l'application (aucune autre application ne peut le lire), à côté de la base ; Android n'offre pas de coffre accessible au moteur Rust. |
| Mots de passe OPDS | Dans la base chiffrée (sur ordinateur : coffre du système). |
| Export des annotations | Markdown uniquement (le sélecteur d'enregistrement d'Android ne permet pas de choisir le format). |
| Impression, plein écran | Absents (pas d'impression dans le navigateur intégré ; Android gère lui-même le plein écran). |
| Lecture à voix haute | Le navigateur intégré d'Android n'a pas de synthèse vocale : Planche l'indique au lieu de lire. |
| Raccourcis clavier | Utilisables avec un clavier physique (tablette). |

## Ce qui a été vérifié

Sur émulateur Android 16 (API 36, téléphone Pixel 8 et tablette Pixel Tablet) : ajout d'un dossier par le sélecteur, scan avec étagères et vignettes (CBZ, CBR, CBT, PDF, EPUB, dossier d'images), lecture d'un CBR (bibliothèque UnRAR via le descripteur de fichier fourni par Android), d'un roman EPUB et d'un PDF, pages tournées au toucher et au glissement, bouton Retour, menu latéral, bibliothèque conservée après un arrêt forcé. Pas encore sur un appareil réel.

## Compiler

Prérequis : Node 20+, Rust avec les cibles Android (`rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`), JDK 21, SDK Android (plateforme 36, build-tools 36) et NDK 28, avec `JAVA_HOME`, `ANDROID_HOME` et `NDK_HOME` définis. Dans `planche/` :

```bash
npm ci
npm run tauri android build -- --apk --aab
```

Pour tester : `npm run tauri android dev` (appareil branché ou émulateur).

Le projet Android est dans `planche/src-tauri/gen/android`. Le module Kotlin des sélecteurs est dans `planche/src-tauri/plugins/planche-storage`, et l'accès aux documents par le moteur dans `planche/src-tauri/src/storage.rs`.

## Clé de signature (une seule fois)

Android n'installe que des applications signées, et Google Play exige que toutes les versions soient signées avec la même **clé d'envoi**.

1. Créer la clé (garder le fichier et le mot de passe en lieu sûr, hors du dépôt) :

   ```bash
   keytool -genkeypair -v -keystore planche-upload.jks -storetype PKCS12 -keyalg RSA -keysize 2048 -validity 10000 -alias planche
   ```

2. Dans GitHub : *Settings* > *Secrets and variables* > *Actions* > *New repository secret* :

   | Secret | Valeur |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | Le fichier encodé : `base64 -w0 planche-upload.jks` (Linux), ou `[Convert]::ToBase64String([IO.File]::ReadAllBytes("planche-upload.jks"))` (PowerShell) |
   | `ANDROID_KEYSTORE_PASSWORD` | Le mot de passe choisi |
   | `ANDROID_KEY_ALIAS` | `planche` |

Sans ces secrets, le pipeline compile une version non signée, qui ne s'installe pas.

## Publier sur Google Play

1. Créer un compte [Google Play Console](https://play.google.com/console) (25 $, une fois) et une application, nom de paquet **`com.planche.reader`**.
2. Remplir la fiche (description, captures d'écran, icône), la classification du contenu, la section *Sécurité des données* (Planche ne collecte ni ne partage aucune donnée) et une adresse de règles de confidentialité.
3. **Première version, à la main** : télécharger l'artefact `planche-android` d'une compilation (ou de la Release), puis déposer `Planche_<version>_android.aab` dans *Tests > Test interne*. Activer la **signature d'application par Google Play** (Google garde la clé de distribution ; si la clé d'envoi est perdue, elle peut être remplacée).
4. **Accès automatique** : *Configuration > Accès à l'API* : relier un projet Google Cloud, créer un **compte de service**, lui télécharger une clé JSON, puis dans *Utilisateurs et autorisations* l'inviter avec le droit de publier des versions.
5. Dans GitHub : *Settings* > *Environments* > `google-play` > secret `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (le contenu du fichier JSON) ; puis *Variables* du dépôt : `GOOGLE_PLAY_TRACK` = `internal` (plus tard `beta` ou `production`). Tant que l'application n'est pas publiée, ajouter `GOOGLE_PLAY_STATUS` = `draft`.
6. Ensuite, chaque étiquette `vX.Y.Z` envoie l'AAB sur cette piste. Le numéro de version Android (`versionCode`) est calculé à partir de la version (`1.2.3` → `1002003`) : il augmente à chaque version, comme l'exige Google Play.
