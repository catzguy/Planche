# Cover 3.17.1 — Dossier de reverse-engineering

Cible : `FrenchFry.Cover_3.17.1.0_x64__a3mvwcjazefp4` (Microsoft Store, éditeur « Whatsticker Apps S.R.L. », dev d'origine FrenchFry Software).
Méthode : analyse statique du package MSIX (manifest, métadonnées XAML `.xr.xml`, chaînes ASCII/UTF‑16 extraites du binaire natif et de `resources.pri`) + lecture des données locales de l'app (`%LOCALAPPDATA%\Packages\FrenchFry.Cover_a3mvwcjazefp4\LocalState`). Aucun code n'a été exécuté ni décompilé en pseudo-code.

Légende : **[O]** observé directement · **[I]** inféré · **[?]** inconnu.

---

## 1. Stack technique

| Élément | Valeur | |
|---|---|---|
| Type d'app | UWP C#/XAML, compilée **.NET Native** (ilc 2.2) → le DLL de 36 Mo est du code machine, pas de l'IL décompilable | [O] |
| Cible | Windows 10 17763+, x64, VS 2022 | [O] |
| Architecture | MVVM (`FrenchFry.Cover.App.Mvvm.ReadViewModel`, `MasterViewModel`), DI `Microsoft.Extensions.DependencyInjection` | [O] traces de pile + chaînes |
| Projets | `FrenchFry.Cover.App.UWP` (UI), `FrenchFry.Cover.Model` (+ `.Storage`, `.Sorting`, `.SmartViews`), `CommonLibrary` (onboarding/paywall/review/support, réutilisée d'autres apps de l'éditeur) | [O] |
| Archives | **SharpCompress** (zip, rar, 7z, tar, gzip) + ZstdSharp | [O] |
| PDF | `Windows.Data.Pdf` (rendu) + PdfSharp | [O] |
| EPUB | parseur maison OPF/NCX, **images uniquement** (« Can not open text epubs ») | [O] |
| Base de données | SQLite (`Microsoft.Data.Sqlite` + SQLitePCLRaw/e_sqlite3) | [O] |
| JSON | Newtonsoft.Json | [O] |
| Tri | NaturalSort.Extension (tri « naturel » des pages/fichiers) | [O] |
| UI | WinRTXamlToolkit, Behaviors XAML, FullScreenTitleBar | [O] |
| Logs | MetroLog → `LocalState\MetroLogs\Log - yyyyMMdd.log` | [O] |
| Analytics | Google Analytics Measurement Protocol, Bing UET SDK, StatHat, ipify | [O] |

## 2. Formats pris en charge

- Associations de fichiers [O] : `.cbz .cbr .cbt .cb7 .zip .rar .tar .7z .pdf .epub`
- Formats d'image [O] : JPEG, PNG, GIF, BMP, WEBP
- Dossiers d'images bruts traités comme un livre [O]
- Protocoles URI [O] : `cover-comics:`, `cover.onedrive:`, `cover-dropbox:`, `cover.gdrive:` (les 3 derniers = callbacks OAuth)

## 3. Modèle de données

### 3.1 SQLite `LocalState\_books.db` [O]

```sql
CREATE TABLE IF NOT EXISTS Book (
  Id varchar(36) primary key not null,   -- GUID majuscule (migration v1)
  DateCreate bigint, DateLastRead bigint,
  FileName varchar, FriendlyName varchar, FullPath varchar,
  CurrentPage integer, PageCount integer,
  IsMangaSet integer, IsManga integer,       -- sens de lecture forcé/par livre
  ScrollOffsetX float, ScrollOffsetY float,  -- position en scroll continu
  Color varchar,                             -- varchar(7) "#RRGGBB" (ajouté par ALTER)
  FolderId varchar(36),                      -- étagère parente
  Status integer, Type integer,
  HasThumbnail integer, HasLargeThumbnail integer, HasWideThumbnail integer,
  FailedThumbnailCount integer, IsPortrait integer, IsIsolatedFile integer,
  IsRemote integer, IsDownloading integer, IsDownloaded integer,
  FolderType integer,                        -- Local/OneDrive/Dropbox/GoogleDrive/LocalNetwork
  IsCopiedLocally integer, TotalBytes integer,
  IsFavorite integer, IsHidden integer, IsAvailableInKidsCorner integer,
  LocalSaveDate bigint, SyncSize integer
);
CREATE TABLE IF NOT EXISTS Bookmarks (Id varchar(36) primary key not null, BookId varchar(36) not null, Name varchar, Page integer);
CREATE TABLE IF NOT EXISTS StandaloneBook (FullPath varchar primary key not null, CurrentPage integer);  -- fichiers ouverts hors bibliothèque
```

Migrations versionnées par `PRAGMA user_version` (0→3 : GUID en majuscules, conversion des dates .NET ticks → texte, ajout `StandaloneBook`), plus ajout de colonnes à la volée via `ALTER TABLE … ADD COLUMN` [O].

### 3.2 Arbre de bibliothèque `LocalState\_library.xml` [O]

XML sérialisé : `Library > Folders` (dossiers racines ajoutés) + `Shelf` récursif. Attributs d'une étagère : `Id, Name, BackgroundSourceId, IsCurrentlyReadingShelf, Color, FolderJpgFullpath, FolderJpgSize, HasThumbnail, FailedThumbnailCount`, enfants `Shelves` / `Books`. Une étagère = un dossier du disque [I].

### 3.3 Réglages `LocalState\_settings.xml` [O]

`PageMode` (OnePage | TwoPages | TwoPagesWithCover | ContinuousScrolling), `FitMode` (FitWidth | FitHeight | FitBoth), `BackAction` (GoToLibrary | GoToShelf), `PageBackgroundColor`, `MangaModeByDefault`, `SortFoldersFirst`, `KeepScreenActiveWhileReading`, `ShowHiddenElements`, `CurrentSort` (Name/Date × Asc/Desc), `CurrentSmartView`, `SmartMode` (détection double-pages), `AutoCropPages` (rognage auto des bords), `IsVerticalPaging`, `AutoRefreshLibrary`, `SmartRenameBooks`, `HideCircularProgressBar`, `PerformanceProfile` (BestQuality | Balanced | BestPerformance), `ContinuousScrollZoomFactor`, `DisableLiveTile`, `RedTileBackground`, `SyncEnabled`, compteurs de review, état de navigation (`Context`, `ShelfId`, `BookId` → reprise au lancement), et `KeyboardShortcuts`.

### 3.4 Autres fichiers [O]

- `thumbnails/{bookId}-big.jpg` et `-wide.jpg` (vignettes portrait + large pour la tuile)
- `cache/{bookId}/` (extraction/cache des pages)
- `app_config_cache.json` : config distante (paywall, A/B tests, placements)

## 4. Écrans et composants (depuis les types XAML) [O]

| Zone | Types |
|---|---|
| Démarrage | `ExtendedSplash`, `CommonLibrary.Pages.SplashScreenPage`, `OnboardingPage` (3 images), `ReleaseNotes` |
| Navigation | `MainPage` (menu hamburger : Library, CurrentlyReading, Downloads, ManageContent, Store, Search) |
| Bibliothèque | `Shelf` (grille étagères+livres, `LibraryDataTemplateSelector`), `PullToRefreshPresenter`, `EmptyLibrary`, `AddFolderButtons`, `ManageContent`, `Search` |
| Lecture | `Read` → `Reader` → `Reader_PagePerPage` (`FixedFlipView`) ou `Reader_ContinuousScroll`; `ProgressGauge`/`PartialCircle` (jauge circulaire), `Bookmarks`, `BookmarksForBook`, `OnScreenNotifier` |
| Cloud | `RemoteFolderPicker`, `CloudDownload`, `LocalDownload`, `DownloadsFlyout`, `DownloadsIcon` |
| Réglages | `SettingsPage` : General, Shortcuts (`KeyboardShortcutEditor`), Tile, Purchase, About |
| Monétisation | `PurchaseControl`, `PaywallPage`, `WebPaywallPage`, `EnableTrialNotificationPaywallPage`, `ReviewRequestDialog`, `SupportFormDialog`, `WarningDialog` |

## 5. Fonctionnalités

### Bibliothèque
- Ajout de dossiers racine (local, réseau, OneDrive, Dropbox, Google Drive) ; scan récursif → étagères = sous-dossiers, livres = archives/PDF/EPUB/dossiers d'images. Statuts de scan : Discovering → Merging, compteurs livres/étagères [O].
- Refus d'un dossier déjà inclus (ou parent d'un dossier ajouté) [O].
- Rafraîchissement manuel (pull-to-refresh) et auto [O].
- Tri : nom / date, asc/desc, dossiers d'abord ; tri naturel [O].
- **Smart views** : Library, Unread, InProgress, RecentlyRead, RecentlyAdded, Favorite, AvailableOffline [O].
- Actions livre : favori, lu / non lu, masquer, supprimer du disque, définir comme fond d'étagère, couleur, mode manga par livre ou par étagère entière [O].
- « Smart rename » des livres et étagères (nettoyage des noms) [O, règles exactes ?].
- Recherche dans la bibliothèque [O].
- Couleur dominante par livre/étagère (`Color`) [O, algorithme ?].

### Lecteur
- Modes : page par page, deux pages, deux pages avec couverture seule, défilement continu (horizontal ou vertical) [O].
- Ajustement : largeur, hauteur, page entière ; zoom [O].
- Mode manga (droite → gauche), par défaut configurable [O].
- Détection auto des doubles pages en mode 2 pages [O].
- Rognage automatique des bords (`CropImage`) [O].
- Mode nuit / variateur de luminosité (`DimmerOpacity`), couleur de fond de page [O].
- Profils de performance (taille de décodage des images) [O].
- Mémorise page courante + offset de scroll ; propose « revenir à la première page » en fin de livre [O].
- Livre suivant/précédent dans l'étagère [O].
- Signets nommés par livre (bibliothèque uniquement) [O].
- Plein écran, écran maintenu allumé [O].
- Ouverture de fichiers isolés (hors bibliothèque) avec mémorisation de la page [O].

### Raccourcis clavier par défaut (rebindables) [O]

| Action | Touche | Action | Touche |
|---|---|---|---|
| BackToLibrary | Back | PreviousBook | Ctrl+PageUp |
| DisplayControls | Escape | NextBook | Ctrl+PageDown |
| ReadForward | S | BrightnessIntensity | N |
| ReadBackward | Z | ToggleManga | M |
| NextPage | PageDown | TogglePageMode | P |
| PreviousPage | PageUp | ToggleFitMode | F |
| FirstPage | Home | Fullscreen | Ctrl+F |
| LastPage | End | Search | F3 |

Gestion des conflits (« Conflicts with '{0}' ») et support manette (Gamepad*) [O].

### Cloud [O]
- **OneDrive** : OAuth2 v2 `login.microsoftonline.com/common`, Microsoft Graph `/me/drive/items/…`, pagination `@odata.nextLink`, gestion des `remoteItem` (partagés).
- **Dropbox** : OAuth2 code flow, `files/list_folder`, `files/get_metadata`, `content…/files/download` (header `Dropbox-API-Arg`).
- **Google Drive** : OAuth2 `accounts.google.com`, Drive v3 `files?q='{id}' in parents and trashed=false`, gestion des raccourcis.
- Téléchargement pour lecture hors ligne, file de téléchargements, suppression de la copie locale, déconnexion par service.
- [?] Sync multi-appareils (`SyncEnabled`, `BookSyncManager`, `PushAllSyncStatuses`) : présente dans le code, backend non identifié.

### Intégrations Windows [O]
- Live tiles (bibliothèque + lecture en cours, modèles `Assets/Tiles/*.xml`), fond rouge ou transparent.
- Confirmation de fermeture (`confirmAppClose`), stockage amovible.

### Monétisation (v3.17) [O]
- Historique : gratuit jusqu'à 25 livres, IAP à vie `Limit250Books` (1,49 $), `FullVersion` (4,99 $), `Limit250ToFullVersion`.
- Actuel : abonnements Store (`9NV3STXX9VXH`, `9PK2VJMQTJ0P`) avec essai gratuit, paywall piloté par config distante `cover-windows.uc.r.appspot.com` ; placements : après splash/onboarding, trop de livres, deux pages, scroll continu, mode manga, signets, ajout cloud… Limite « soft » 3 livres.
- Demande d'avis, formulaire support Zendesk, notifications/avertissements JSON distants (`frenchfryfiles.blob.core.windows.net`), changelog.

## 6. Limites de l'analyse

- Code .NET Native : seules les chaînes, noms de membres conservés pour la réflexion et traces de pile sont lisibles. Les algorithmes précis (rognage auto, détection double page, smart rename, couleur dominante, heuristique de tri des pages) ne sont **pas** extraits ; ils sont à réimplémenter.
- L'apparence exacte (mises en page XAML compilées en XBF dans `resources.pri`) n'a pas été décodée ; l'interface doit être reconstruite à partir de l'usage réel de l'app.
- Valeurs numériques des enums `Status`, `Type`, `FolderType` : ordre déduit de la liste de chaînes, non confirmé.

## 7. Points juridiques pour la reconstruction

Reconstruire une app **fonctionnellement équivalente** est légitime ; en revanche ne pas réutiliser : le nom « Cover », le logo/assets, les textes marketing, les clés OAuth de l'éditeur, ni copier son code. Il faut enregistrer ses propres apps OAuth (Azure, Dropbox, Google).
