# Planche — revue de sécurité (25/10/2026)

Périmètre : tout le code de `planche/` (backend Rust `src-tauri/src`, interface `src/`, configuration Tauri), ses dépendances, et le stockage local des données.
Méthode : audit automatique des dépendances (`npm audit`, `cargo audit`), revue manuelle des points d'entrée (commandes IPC, protocole `planche://`, rendu de contenu non fiable, archives, réseau), corrections, puis **tests d'attaque sur la version de production** (fichiers piégés, injection de script, lecture de la base depuis l'extérieur).

## Modèle de menace

Planche ouvre des fichiers **non fiables** (BD, PDF, EPUB téléchargés n'importe où, flux OPDS de serveurs tiers). Le risque principal est qu'un fichier ou un flux exécute du code dans l'interface : ce code aurait alors accès aux commandes de l'application (lecture de fichiers, scan de dossiers, réseau). Les autres risques : écriture hors du dossier prévu lors de l'extraction d'une archive, épuisement mémoire/disque, fuite des identifiants OPDS, et lecture de la bibliothèque (chemins, progression, annotations, réglages, adresses de catalogues — dont les clés d'API Kavita) par un autre programme.

## Constats et corrections

| # | Gravité | Constat | Correction | Vérifié |
|---|---|---|---|---|
| 1 | **Critique** | Aucune Content Security Policy (`"csp": null`) : un script injecté dans l'interface aurait pu tout faire. | CSP stricte en production : scripts uniquement de l'application, pas d'`eval`, pas de gestionnaires en ligne, aucune connexion externe, `object-src 'none'`, `form-action 'none'`. | `onerror` injecté, `<script>` en ligne, `eval`, script et `fetch` distants : **tous bloqués**. |
| 2 | **Critique** | Impression d'un chapitre EPUB : le HTML du livre était inséré tel quel dans la page de l'application (un `<img onerror=…>` du livre s'y serait exécuté). | Nettoyage par liste blanche (`sanitizeBookHtml`, analyse inerte) : ni script, ni gestionnaire, ni lien `javascript:`, ni ressource externe. | EPUB piégé imprimé : 0 gestionnaire, lien neutralisé. |
| 3 | **Élevée** | Recherche EPUB : en cas de repli, l'extrait du livre était affiché comme HTML. | Extrait toujours échappé (`markExcerpt`). | Texte `<img onerror…>` affiché comme texte. |
| 4 | **Élevée** | Commande `write_text_file(chemin, contenu)` : la page pouvait écrire n'importe quel fichier sur le disque. | Supprimée. Remplacée par `export_annotations`, qui ouvre **elle-même** la boîte « Enregistrer » ; la page ne choisit plus le chemin. Permission `dialog:allow-save` retirée. | `write_text_file` → « Command not found ». |
| 5 | **Élevée** | Extraction RAR/TAR : chemins de l'archive confiés aux bibliothèques ; aucune limite de taille (bombes de décompression) ; lecture ZIP allouant la taille déclarée. | Extraction réécrite : seules les **images en fichiers ordinaires** sont écrites, par notre code, sous un chemin vérifié (`safe_relative` : refus de `..`, chemins absolus, lecteurs `C:`, flux `:`) ; liens symboliques ignorés ; limites 256 Mo/fichier, 8 Go/archive, 100 000 entrées ; lecture bornée même si la taille déclarée ment. | CBT piégé (`../..`, `/`, `C:/`, lien symbolique) : seule l'image légitime extraite, **aucun fichier hors du cache**. Test unitaire. |
| 6 | **Élevée** | Dépendance `@xmldom/xmldom` ≤ 0.8.14 (via epub.js) : 14 avis (injection XML, déni de service). | Forcée en 0.8.15 (`overrides`). | `npm audit` : 0 vulnérabilité. |
| 7 | Moyenne | Base de données SQLite en clair dans `%APPDATA%`, lisible par tout programme (démontré : chemins et progression lus avec un outil SQLite). | Voir ci-dessous. | Voir ci-dessous. |
| 8 | Moyenne | OPDS : mot de passe envoyé en clair si le catalogue est en `http://` vers une autre machine. | Avertissement explicite dans le formulaire (le refus casserait les serveurs Komga/Kavita en réseau local). | — |
| 9 | Faible | `cargo audit` : 5 avertissements (crates non maintenues `zbus_names`, `zvariant*`, `proc-macro-error` ; défaut de `glib::VariantStrIter`). | Aucune vulnérabilité ; ces crates ne sont compilées que pour **Linux** (WebKitGTK, Secret Service). À surveiller lors des mises à jour de Tauri/keyring. | `cargo audit` : 0 vulnérabilité. |

Points vérifiés sans problème : toutes les requêtes SQL sont paramétrées (les seuls noms de tables formatés sont des constantes) ; le cadre EPUB est en bac à sable **sans scripts** (`sandbox="allow-same-origin"`, `allowScriptedContent: false`) ; le XML est lu sans résolution d'entités externes (regex côté Rust, `DOMParser` côté interface) ; les identifiants OPDS ne partent que vers l'origine du catalogue (vérifié : refus sur une autre origine) et sont retirés en cas de redirection ; TLS vérifié (`native-tls`) ; les noms de fichiers téléchargés sont assainis ; pdf.js 6.4 n'a plus de chemin `eval` (faille CVE-2024-4367 corrigée en 4.2).

## Protection de la base de données

**Ce qui a été mis en place** (`src-tauri/src/vault.rs`) :

1. **Aucun fichier SQLite sur le disque.** La base vit uniquement en mémoire dans le processus Planche : aucun autre programme ne peut s'y connecter pendant que l'application tourne.
2. **Instantané chiffré** `library.planche`, écrit 2 s après une modification et à la fermeture : chiffrement authentifié **XChaCha20-Poly1305** (nonce aléatoire de 192 bits à chaque écriture), écriture atomique. Toute altération du fichier est détectée et refusée.
3. **Clé aléatoire de 256 bits dans le coffre du système** (Gestionnaire d'identification Windows / Trousseau macOS / Secret Service), jamais à côté du fichier : le fichier seul est inexploitable (copie, sauvegarde, synchronisation cloud, autre compte). Sous Linux sans Secret Service, repli sur un fichier de clé `~/.config/com.planche.reader/library.key` (droits 600, hors du dossier de données), déplacé dans le coffre dès qu'il devient disponible (voir [LINUX.md](LINUX.md)).
4. **Migration automatique** de l'ancienne base en clair, puis **effacement** (réécriture par des zéros et suppression de `library.db`, `-wal`, `-shm`).
5. Dossier de données accessible uniquement au compte utilisateur, à SYSTEM et aux administrateurs (ACL Windows vérifiées).

**Vérifié** : après migration, plus aucun `.db` ; ouverture du fichier avec SQLite → « file is not a database » ; aucune chaîne lisible (chemins, titres, schéma) ; entropie 7,998 bits/octet ; 14 livres, 3 signets, 2 annotations, progression et réglages intacts.

**Limites (honnêtement)** :
- Un programme malveillant **qui s'exécute sous ton compte Windows** peut, comme toi, demander la clé au Gestionnaire d'identification, ou lire la mémoire de Planche. Aucune application de bureau ne peut s'en protéger : c'est le rôle de l'antivirus et de la séparation des comptes. Le chiffrement protège contre tout le reste (fichier copié, sauvegardes, cloud, disque volé non chiffré, autres utilisateurs).
- Les **vignettes** et le **cache de pages extraites** (images de tes propres BD) restent en clair dans le dossier de données.
- L'effacement de l'ancienne base est « au mieux » : sur SSD, des blocs anciens peuvent subsister physiquement. Activer **BitLocker** sur le disque couvre ce cas et renforce l'ensemble.
- En cas d'arrêt brutal, les modifications des 2 dernières secondes peuvent être perdues.

## Risques résiduels et recommandations

- `style-src 'unsafe-inline'` reste nécessaire (styles React, feuilles de style des EPUB) : une injection CSS n'exécute pas de code mais pourrait altérer l'affichage.
- Le cadre EPUB partage l'origine de l'application : **ne jamais activer les scripts d'EPUB** (`allowScriptedContent`) sans isoler d'abord le lecteur sur une origine séparée.
- L'analyse des RAR utilise la bibliothèque C UnRAR (code natif) : la garder à jour.
- Les commandes IPC acceptent des chemins (ouvrir un fichier, ajouter un dossier) : elles ne sont exploitables qu'après une injection de script, désormais bloquée par la CSP.
- En développement (`tauri dev`) la CSP est désactivée (`devCsp: null`) ; la protection s'applique aux versions compilées.
- À refaire régulièrement : `npm audit`, `cargo audit` ; mettre à jour Tauri, pdf.js, epub.js, UnRAR.
