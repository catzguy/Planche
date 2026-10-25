# Planche sur le Microsoft Store

Installée depuis le Microsoft Store, Planche ne déclenche pas d'avertissement SmartScreen : le Store signe lui-même le paquet. Planche y est publiée sous forme de paquet **MSIX**, produit automatiquement par le pipeline.

## Ce qui est automatisé

| Étape | Fichier | Quand |
|---|---|---|
| Paquet `Planche_<version>_x64.msix` (non signé) | `planche/scripts/build-msix.ps1`, manifeste `planche/src-tauri/msix/AppxManifest.xml` | Chaque compilation Windows (pull requests, `develop`, versions), artefact `planche-msix` |
| Soumission au Store | job `store` de `.github/workflows/release.yml` | Chaque étiquette `vX.Y.Z`, une fois la version GitHub publiée, si le Store est configuré |

Le MSIX n'est pas joint aux Releases GitHub : non signé, il ne s'installe pas en dehors du Store.

## Mise en place (une seule fois)

### 1. Compte développeur et réservation du nom

1. Créer un compte développeur individuel (gratuit) sur [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com).
2. Dans [Partner Center](https://partner.microsoft.com/dashboard) : *Apps and games* > *New product* > *MSIX or PWA app*, et réserver le nom **Planche** (ou un autre s'il est pris).
3. Ouvrir *Product management* > *Product identity* et noter :
   - `Package/Identity/Name` (par exemple `12345catzguy.Planche`) ;
   - `Package/Identity/Publisher` (`CN=…`) ;
   - `Package/Properties/PublisherDisplayName` ;
   - le **Store ID** (12 caractères, commence par `9`).

### 2. Variables GitHub

Dans le dépôt : *Settings* > *Secrets and variables* > *Actions* > onglet *Variables*, créer :

| Variable | Valeur |
|---|---|
| `MSSTORE_IDENTITY_NAME` | `Package/Identity/Name` |
| `MSSTORE_PUBLISHER` | `Package/Identity/Publisher` |
| `MSSTORE_PUBLISHER_DISPLAY_NAME` | `Package/Properties/PublisherDisplayName` |
| `MSSTORE_PRODUCT_ID` | Store ID |

Sans ces variables, le MSIX est construit avec une identité de test (`Planche.Dev`) refusée par le Store, et la soumission automatique est ignorée.

### 3. Accès à l'API du Store

1. Partner Center > *Account settings* > *User management* > *Microsoft Entra applications* : créer une application avec le rôle **Manager**, puis lui ajouter une clé (*Add new key*).
2. Noter le **Tenant ID**, le **Client ID** et la **clé** (affichée une seule fois), ainsi que le **Seller ID** (*Account settings* > *Legal info* > *Developer*).
3. Dans GitHub : *Settings* > *Environments* > *New environment* `microsoft-store`, puis y ajouter les secrets :

| Secret | Valeur |
|---|---|
| `PARTNER_CENTER_TENANT_ID` | Tenant ID |
| `PARTNER_CENTER_CLIENT_ID` | Client ID |
| `PARTNER_CENTER_CLIENT_SECRET` | Clé de l'application |
| `PARTNER_CENTER_SELLER_ID` | Seller ID |

L'environnement permet en plus d'exiger ton approbation avant chaque soumission (*Required reviewers*).

### 4. Première soumission (manuelle)

La première soumission se fait dans Partner Center, car elle comprend la fiche du Store :

1. Relancer le workflow « Windows » (*Actions* > *Run workflow*) pour obtenir un MSIX avec la bonne identité, et télécharger l'artefact `planche-msix`.
2. Dans la soumission : déposer le `.msix` (*Packages*), remplir la fiche en français (description, au moins une capture d'écran, icône), le questionnaire de classification par âge, le prix (gratuit) et les marchés.
3. *Submission options* : justifier la capacité restreinte `runFullTrust` (« application de bureau : lecture des fichiers de BD et de livres de l'utilisateur »).
4. Soumettre. La certification prend généralement de quelques heures à trois jours.

### 5. Versions suivantes (automatiques)

1. Augmenter la version (`package.json`, `Cargo.toml`, `tauri.conf.json`) et fusionner.
2. Créer l'étiquette `vX.Y.Z`.
3. Le pipeline publie la version GitHub, puis soumet le MSIX au Store avec la fiche existante. Suivre la certification dans Partner Center.

## À savoir

- **Version** : le Store exige un numéro à quatre parties qui augmente à chaque soumission ; `1.2.3` devient `1.2.3.0`.
- **Données séparées** : la version du Store garde sa bibliothèque dans son propre dossier (`%LOCALAPPDATA%\Packages\<paquet>\LocalCache`). Une bibliothèque créée avec l'installateur `.exe` n'y apparaît pas ; il faut rajouter les dossiers.
- **Langue de la fiche** : le manifeste déclare le français (`fr-FR`). Pour une fiche dans d'autres langues, ajouter des lignes `<Resource Language="…"/>` au manifeste, puis remplir chaque langue dans Partner Center.
- **Système** : Windows 10 version 2004 ou plus récent (WebView2 présent).
- **Test local** : après `npm run tauri build`, `pwsh scripts/build-msix.ps1 -Register` installe le paquet en mode test (mode développeur de Windows requis) ; le retirer avec `Get-AppxPackage Planche.Dev | Remove-AppxPackage`.
