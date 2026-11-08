# Planche — audit de sécurité avant publication du code (08/11/2026)

Audit en boîte blanche de l'ensemble du dépôt `catzguy/Planche` : moteur Rust (`planche/src-tauri/src`, plugin Android, projet `gen/android`), interface React/TypeScript (`planche/src`), configuration Tauri, workflows GitHub, dépendances, historique Git. État de référence : branche `fix/revue-securite-2026-11` (PR #22), qui contient les corrections #1 à #9 de la revue détaillée [REVUE_SECURITE_2026-11-08.md](REVUE_SECURITE_2026-11-08.md). Ce document donne la synthèse, le résultat de la recherche de secrets, les points propres à la publication, et **le correctif de code exact de chaque point encore ouvert**.

Fait à noter : le dépôt est **déjà public** depuis sa création (vérifié par l'API GitHub, `visibility: public`). Les points « avant publication » ci-dessous sont donc à traiter au plus tôt plutôt qu'avant un basculement.

## 1. Synthèse des risques

| # | Sévérité | Risque | Localisation | État |
|---|---|---|---|---|
| S-1 | **Élevée** | EPUB piégé : lecture non bornée des documents → épuisement mémoire, puis reprise en boucle par le worker → application qui ne démarre plus | `book.rs` `read_entry`, `thumbs.rs` | **Corrigé** PR #22 (#1) |
| S-2 | Moyenne | Chemins libres acceptés par `open_file` / `add_root` : après une injection de script, lecture de tout fichier « livre » ou image du disque via `planche://raw` | `lib.rs` | **Corrigé** PR #22 (#2) : sélecteurs côté moteur, liste blanche |
| S-3 | Moyenne | `save_thumbnail(id)` : traversée de chemin à l'écriture (`..`, `C:`) | `lib.rs` | **Corrigé** PR #22 (#3) |
| S-4 | Moyenne | Corps HTTP OPDS lus sans borne (flux, couvertures, téléchargements) → DoS mémoire par un catalogue hostile | `opds.rs` | **Corrigé** PR #22 (#4) |
| S-5 | Moyenne | Allocation sur la taille déclarée × threads illimités ; décodage d'image sans limite de dimensions | `book.rs`, `lib.rs`, `thumbs.rs` | **Corrigé** PR #22 (#5) |
| S-6 | Moyenne | Coffre : sauvegarde en échec non retentée ; fichier illisible = arrêt silencieux sans secours | `vault.rs`, `lib.rs` | **Corrigé** PR #22 (#6) |
| S-7 | Moyenne | Clé du coffre et coffre sauvegardés ensemble (Android `allowBackup`) ; clé de secours Windows dans le dossier du coffre | `AndroidManifest.xml`, `vault.rs` | **Corrigé** PR #22 (#7) |
| S-8 | Moyenne | Actions GitHub non épinglées dans les jobs qui tiennent la clé de signature et les secrets Store/Play ; keystore laissée sur le runner | `.github/workflows/*` | **Corrigé** PR #22 (#8) |
| S-9 | Faible | `opener:default` plus large que l'usage (`allow-open-url`) | `capabilities/default.json` | **Corrigé** PR #22 (#9) |
| S-10 | Faible | Catalogue OPDS 2 avec `title`/`description` objet (titre localisé, conforme à la spec) → exception React, écran blanc, pas d'`ErrorBoundary` | `opds.ts:176-189`, `Catalogs.tsx`, `Library.tsx:582` | **Corrigé** PR #22 (§4.1) |
| S-11 | Faible | Protocole `planche://` : `Access-Control-Allow-Origin: *`, pas de `X-Content-Type-Options` | `lib.rs` (handler du protocole) | **Corrigé** PR #22 (§4.2) |
| S-12 | Faible | Noms de téléchargement : noms réservés Windows (`CON`, `NUL`…), caractères de format Unicode (U+202E) ; collision du `.part` entre deux téléchargements | `opds.rs` `sanitize`, `unique_path`, `download` | **Corrigé** PR #22 (§4.3) |
| S-13 | Faible | `overrides` npm figé sur `0.8.15` : un futur avis `@xmldom/xmldom` ne serait pas corrigé ; aucun `npm audit` / `cargo audit` en CI | `planche/package.json:28-30`, workflows | **Corrigé** PR #22 (§4.4, workflow `audit.yml`) |
| S-14 | Faible | Fiabilité : course entre deux extractions du même livre ; `Cursor` JNI non fermé en cas d'erreur | `lib.rs` `opened`, `storage.rs:176-179` | **Corrigé** PR #22 (§4.5) |
| S-15 | Faible | epub.js laisse les liens `mailto:`/`tel:` et les liens absolus actifs dans le cadre du livre | `TextReader.tsx:152` | **Corrigé** PR #22 (§4.6) |
| S-16 | Faible | Adresse e-mail personnelle dans l'historique Git (commits antérieurs à la configuration de l'adresse `noreply`) | historique | **Ouvert** → §3 (réglage GitHub à faire par le propriétaire) |
| S-17 | Info | Aucune licence, aucun `SECURITY.md` (politique de signalement) | racine du dépôt | **Corrigé** PR #22 : `LICENSE` (MIT), `SECURITY.md`, champs `license` ; reste à activer Private vulnerability reporting (§3) |
| S-18 | Info | SSRF « côté client » par conception : un flux OPDS peut faire requêter des adresses locales par le moteur (identifiants jamais envoyés hors origine du catalogue) | `opds.rs` `check_url` | Accepté (Komga/Kavita en LAN) ; garde optionnelle §4.7 |
| S-19 | Info | Clé et images en clair non zéroïsées en mémoire ; `panic = "abort"` ; worker pdf.js hors CSP (sans conséquence avec pdf.js 6) | divers | Documenté dans la revue, sans action |

Résultat des outils : `npm audit` **0 vulnérabilité** ; `cargo audit` **0 vulnérabilité**, 6 avertissements (crates non maintenues ou `glib` 0.18, tous tirés par GTK via Tauri, Linux uniquement, sans correctif disponible de notre côté) ; CodeQL (actions, JavaScript/TypeScript, Rust) : 0 alerte ouverte ; secret scanning GitHub : 0 alerte.

## 2. Secrets et données sensibles

Méthode : recherche dans l'arbre de travail **et dans l'intégralité de l'historique** (`git log --all -p`, toutes les branches, fichiers supprimés compris), hors fichiers de verrouillage et traductions, sur les motifs : clés AWS (`AKIA…`), jetons GitHub (`ghp_`, `gho_`, `github_pat_`), Slack (`xox…`), Google (`AIza…`), OpenAI (`sk-…`), JWT, blocs `PRIVATE KEY`, affectations `password|secret|api_key|token|client_secret = "…"` ; et sur les noms de fichiers `.env`, `.jks`, `.keystore`, `keystore.properties`, `local.properties`, `.pem`, `.p12`, `.pfx`, `id_rsa`, `*.key`, `*.db`, `*.planche`.

| Vérification | Résultat |
|---|---|
| Secret codé en dur dans l'arbre | **Aucun.** Les seules valeurs fixes sont des identifiants publics ou de test : `Planche.Dev` / `CN=Planche Dev` (identité MSIX de test dans `scripts/build-msix.ps1`, remplacée par les variables `MSSTORE_*`), l'identifiant d'application `com.planche.reader`, le service de trousseau `Planche` / `library-database-key` (nom d'entrée, pas une valeur). |
| Secret dans l'historique Git | **Aucun** (aucune correspondance de motif, aucun fichier de clé jamais ajouté). |
| Fichiers de signature | `*.jks`, `*.keystore`, `keystore.properties`, `local.properties` ignorés par Git ; jamais commités ; `keystore.properties` écrit par la CI depuis les secrets et supprimé après compilation (PR #22). |
| Secrets de CI | Uniquement via `secrets.*` et `vars.*` ; passés par `env:` ; `secrets: inherit` seulement sur `push`/`workflow_dispatch` ; les PR de forks compilent sans secrets. |
| Données personnelles | Historique : commits signés avec `12049774+catzguy@users.noreply.github.com` (correct) **mais aussi** des commits portant l'adresse personnelle `s.dollard@free.fr` (S-16). Le dépôt étant déjà public, cette adresse est déjà visible ; voir §3. |
| Données utilisateur | Aucune base, vignette ou chemin de bibliothèque dans le dépôt ; les captures d'écran de la documentation ne contiennent pas de chemins personnels (vérifié par liste des fichiers suivis : aucune image hors icônes). |
| Binaire suivi | `gen/android/gradle/wrapper/gradle-wrapper.jar` (standard Gradle). Recommandation : vérifier son empreinte en CI (voir §4.4). |

Protections côté GitHub déjà actives : secret scanning, push protection, Dependabot (npm, cargo, github-actions), CodeQL, signatures de commits requises sur `develop`, revue par code owner.

## 3. Points propres à la publication

### S-16 — Adresse e-mail personnelle dans l'historique
- **Mécanisme** : les premiers commits ont été faits avec `user.email = s.dollard@free.fr`. Toute copie du dépôt l'expose (spam, ciblage).
- **Correctif** : réécrire l'historique est déconseillé (dépôt déjà public, signatures requises, PR fusionnées référencées) ; l'adresse est déjà indexée. Actions utiles :
  1. s'assurer que la configuration locale reste sur l'adresse `noreply` (c'est le cas des commits récents) :
     ```bash
     git config --global user.email "12049774+catzguy@users.noreply.github.com"
     ```
  2. activer, dans GitHub > Settings > Emails, **Keep my email addresses private** et **Block command line pushes that expose my email** (refuse tout futur push portant l'adresse personnelle) ;
  3. si une réécriture est néanmoins souhaitée (`git filter-repo --mailmap`), la faire avant toute publicité du dépôt et re-signer ; sinon, accepter l'exposition.

### S-17 — Licence et politique de signalement
- **Licence** : `license: null` côté GitHub, pas de `LICENSE`, `Cargo.toml` sans champ `license`. Sans licence, le code est « tous droits réservés » : personne ne peut légalement le réutiliser, ce qui contredit l'intention open source. Choisir avant la publicité : **MIT** ou **Apache-2.0** (permissives ; Apache ajoute une clause brevets) ou **GPL-3.0** (copyleft).
  - Contrainte à connaître : `vendor/unrar_sys/vendor/unrar` est sous la **licence UnRAR** (redistribution libre, mais interdiction d'en dériver un compresseur RAR). Elle n'est pas considérée comme libre par Debian/FSF et n'est pas compatible GPL : avec une licence GPL pour Planche, l'exception d'exécution ou le remplacement d'UnRAR serait nécessaire. Avec MIT/Apache-2.0, il suffit de mentionner la licence UnRAR dans le README et de conserver `license.txt` d'UnRAR dans le dépôt (déjà présent dans le vendor).
  - Correctif (exemple MIT) : fichier `LICENSE` à la racine, et dans `planche/src-tauri/Cargo.toml` :
    ```toml
    [package]
    license = "MIT"
    repository = "https://github.com/catzguy/Planche"
    ```
    et dans `planche/package.json` : `"license": "MIT"` (garder `"private": true`, qui empêche une publication npm accidentelle).
- **`SECURITY.md`** (racine ou `.github/`), pour que les chercheurs sachent où signaler sans ouvrir une issue publique :
  ```markdown
  # Politique de sécurité

  ## Versions prises en charge
  La dernière version publiée dans les Releases, et la branche `develop`.

  ## Signaler une vulnérabilité
  Ne pas ouvrir d'issue publique. Utiliser **Security > Report a vulnerability**
  (GitHub Private Vulnerability Reporting) sur ce dépôt. Accusé de réception
  sous 7 jours ; correctif publié dans une version dédiée, avec crédit si souhaité.

  ## Périmètre
  Le code de `planche/` (moteur Rust, interface, projet Android), les workflows.
  Hors périmètre : les serveurs OPDS tiers, le système d'exploitation, WebView2/WebKit.
  ```
  et activer **Settings > Code security > Private vulnerability reporting**.

### Autres vérifications de publication (conformes)
- `.gitignore` couvre `node_modules`, `dist`, `target`, clés Android, `*.local`.
- Aucun fichier de configuration d'IDE avec chemins locaux suivi ; `local.properties` ignoré.
- `README.md` ne contient ni chemin personnel ni identifiant de compte autre que le pseudonyme GitHub.
- Dépendances vendorisées : `vendor/unrar_sys` (copie de la crate 0.5.8 avec `build.rs` modifié) — provenance documentée dans `Cargo.toml` ; conserver le texte de licence d'origine.

## 4. Correctifs de code des points S-10 à S-15

Tous appliqués dans la PR #22 (le code ci-dessous est celui qui a été commité ; les tests `download_names_avoid_reserved_and_bidi` et `only_image_types_pass_for_covers` couvrent §4.3 et le filtre de type des couvertures).

### 4.1 S-10 — Titres OPDS 2 non textuels et absence d'`ErrorBoundary`
- **Localisation** : `planche/src/opds.ts` lignes 176, 178, 189 (`parseJson`) ; rendu dans `planche/src/Catalogs.tsx` (`{e.title}`, `<Modal title={detail.title}>`) ; montage dans `planche/src/Library.tsx:582`.
- **Mécanisme** : le Readium Web Publication Manifest autorise `"title": {"fr": "…", "en": "…"}`. La valeur est rendue telle quelle comme enfant React → `Objects are not valid as a React child` ; aucune limite d'erreur ne l'intercepte → toute l'interface se démonte (déni de service par un catalogue malveillant ou simplement conforme).
- **Correctif** — `opds.ts`, ajouter un normaliseur et l'appliquer :
  ```ts
  /** Readium allows localized strings ({ "fr": "…" }); anything else than text becomes "". */
  const str = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    if (v && typeof v === "object") {
      const first = Object.values(v as Record<string, unknown>).find((x) => typeof x === "string");
      return typeof first === "string" ? first : "";
    }
    return "";
  };
  ```
  ```ts
  // parseJson → pub()
  id: str(p.metadata?.identifier) || String(i),
  title: str(p.metadata?.title),
  summary: str(p.metadata?.description),
  // navEntry
  title: str(n.title) || n.href,
  ```
  et, pour les groupes, `navEntry({ ...l, title: str(g.metadata?.title) }, 1000 + gi)`.
- **Correctif** — limite d'erreur. Nouveau fichier `planche/src/ErrorBoundary.tsx` :
  ```tsx
  import { Component, type ReactNode } from "react";
  import { t } from "./i18n";

  type Props = { children: ReactNode; onReset?: () => void };
  type State = { error: string | null };

  /** Keeps one failing panel from unmounting the whole window. */
  export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null };
    static getDerivedStateFromError(e: unknown): State {
      return { error: String(e) };
    }
    render() {
      if (this.state.error === null) return this.props.children;
      return (
        <div className="notice error" role="alert">
          <p>{t("errors.panelFailed")}</p>
          <pre>{this.state.error}</pre>
          <button onClick={() => { this.setState({ error: null }); this.props.onReset?.(); }}>{t("errors.retry")}</button>
        </div>
      );
    }
  }
  ```
  `Library.tsx:582` :
  ```tsx
  <ErrorBoundary onReset={() => setCatalogVersion((v) => v + 1)}>
    <CatalogBrowser key={`${catalog.id}:${catalog.url}:${catalogVersion}`} catalog={catalog} onEdit={() => setEditing(catalog)} onOpenBook={props.onOpenBookId} />
  </ErrorBoundary>
  ```
  Clés `errors.panelFailed` et `errors.retry` ajoutées dans les 27 fichiers de `src/locales` (`scripts/i18n-keys.mjs` : 324 clés, 0 manquante).

### 4.2 S-11 — En-têtes du protocole `planche://`
- **Localisation** : `planche/src-tauri/src/lib.rs`, fermeture de `register_asynchronous_uri_scheme_protocol` (`Response::builder()`).
- **Mécanisme** : `Access-Control-Allow-Origin: *` autorise toute origine chargée dans la WebView à lire les réponses ; sans `nosniff`, un navigateur pourrait reclasser un corps. Inoffensif aujourd'hui (ressources consommées par `<img>`/`fetch` de la seule origine de l'application, ids UUID non devinables, couvertures forcées en `image/*` depuis PR #22) ; défense en profondeur.
- **Correctif** :
  ```rust
  /// Origin of the application's own page, the only one allowed to read planche:// responses.
  const APP_ORIGIN: &str = if cfg!(any(windows, target_os = "android")) { "http://tauri.localhost" } else { "tauri://localhost" };

  let resp = match result {
      Ok((bytes, mime)) => Response::builder()
          .header("Content-Type", mime)
          .header("X-Content-Type-Options", "nosniff")
          .header("Access-Control-Allow-Origin", APP_ORIGIN)
          .header("Cache-Control", "no-cache")
          .body(bytes),
      Err((status, msg)) => Response::builder()
          .status(status)
          .header("Content-Type", "text/plain; charset=utf-8")
          .header("X-Content-Type-Options", "nosniff")
          .header("Access-Control-Allow-Origin", APP_ORIGIN)
          .body(msg.into_bytes()),
  };
  ```
  En développement (`tauri dev`, origine `http://localhost:1420`), ajouter `#[cfg(debug_assertions)]` pour garder `*`.

### 4.3 S-12 — Noms de fichiers téléchargés et fichier partiel
- **Localisation** : `planche/src-tauri/src/opds.rs`, `sanitize`, `unique_path`, `download`.
- **Mécanisme** : `CON.cbz`, `NUL`, `COM1.pdf` sont des noms de périphérique sous Windows (`File::create` ouvre le périphérique) ; U+202E (RLO) inverse l'affichage du nom dans l'explorateur ; deux téléchargements simultanés du même titre partagent `X.cbz.part` (`unique_path` ne teste que le fichier final) → fichier corrompu puis indexé.
- **Correctif** :
  ```rust
  const RESERVED: [&str; 22] = [
      "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
      "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
  ];

  /// Unicode format characters (category Cf: bidi overrides, zero-width): dropped.
  fn is_format_char(c: char) -> bool {
      matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206F}' | '\u{FEFF}' | '\u{00AD}')
  }

  fn sanitize(name: &str) -> String {
      let cleaned: String = name
          .chars()
          .filter(|c| !is_format_char(*c))
          .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
          .collect();
      let trimmed = cleaned.trim().trim_end_matches('.').trim();
      let short: String = trimmed.chars().take(150).collect();
      if short.is_empty() {
          return "livre".into();
      }
      // Device names are reserved with any extension and any case.
      let stem = short.split('.').next().unwrap_or("").to_ascii_uppercase();
      if RESERVED.contains(&stem.as_str()) { format!("_{short}") } else { short }
  }
  ```
  Dans `download`, remplacer le nom partiel fixe par un nom unique :
  ```rust
  let partial = dir.join(format!(".{}.part", uuid::Uuid::new_v4()));
  ```
  (le `rename(&partial, &path)` final reste inchangé ; `unique_path` ne voit toujours que les fichiers finaux, ce qui suffit puisque le `.part` n'entre plus en collision). Test à ajouter :
  ```rust
  #[test]
  fn download_names_avoid_reserved_and_bidi() {
      assert_eq!(sanitize("CON"), "_CON");
      assert_eq!(sanitize("nul.cbz"), "_nul.cbz");
      assert_eq!(sanitize("a\u{202E}fdp.exe"), "afdp.exe");
      assert_eq!(sanitize("Tome 1 : la suite"), "Tome 1 _ la suite");
  }
  ```

### 4.4 S-13 — `overrides` figé, audits et empreinte Gradle en CI
- **Localisation** : `planche/package.json:28-30` ; `.github/workflows/`.
- **Mécanisme** : `"@xmldom/xmldom": "0.8.15"` bloque toute version ultérieure ; Dependabot ne touche pas aux `overrides` → un futur avis resterait ouvert silencieusement. Aucun job n'exécute `npm audit`/`cargo audit` : une vulnérabilité publiée entre deux revues n'est signalée que par Dependabot (qui ne couvre pas les avis RustSec « unsound/unmaintained »).
- **Correctif** — `package.json` :
  ```json
  "overrides": {
    "@xmldom/xmldom": "^0.8.15"
  }
  ```
  Nouveau workflow `.github/workflows/audit.yml` (actions épinglées comme les autres) :
  ```yaml
  name: Audit
  on:
    schedule:
      - cron: "30 5 * * 1"
    pull_request:
      branches: [develop, main]
      paths: ["planche/package-lock.json", "planche/src-tauri/Cargo.lock", ".github/workflows/audit.yml"]
    workflow_dispatch:
  permissions:
    contents: read
  jobs:
    audit:
      runs-on: ubuntu-latest
      defaults:
        run:
          working-directory: planche
      steps:
        - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        - uses: gradle/actions/wrapper-validation@<sha> # v5 : empreinte de gradle-wrapper.jar
        - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
          with:
            node-version: 22
        - run: npm audit --audit-level=moderate
        - uses: dtolnay/rust-toolchain@b725eda525362e7cf34af9a7243cac1e3f01a7ec # stable
          with:
            toolchain: stable
        - run: cargo install cargo-audit --locked
        - run: cargo audit --deny warnings --ignore RUSTSEC-2024-0429 --ignore RUSTSEC-2024-0370 --ignore RUSTSEC-2026-0370 --ignore RUSTSEC-2026-0371 --ignore RUSTSEC-2026-0372
          working-directory: planche/src-tauri
  ```
  Les `--ignore` listent les avis Linux/GTK sans correctif possible (à retirer quand Tauri passera à gtk-rs 0.20) ; tout nouvel avis fait échouer le job.

### 4.5 S-14 — Course d'extraction et curseur JNI
- **Localisation** : `planche/src-tauri/src/lib.rs` `AppState::opened` ; `planche/src-tauri/src/storage.rs:176-179`.
- **Mécanisme** : deux requêtes `page/{id}/n` simultanées sur un RAR/7z/TAR non encore extrait exécutent chacune `extract_cached` (le `Mutex` ne protège que le `Vec`) : `remove_dir_all` de l'une pendant l'écriture de l'autre → pages manquantes et marqueur `.complete` posé à tort. Côté Android, si `moveToNext` ou `row` échoue, le `?` sort avant `cursor.close()` (fuite jusqu'au GC).
- **Correctif** — `lib.rs`, une seule ouverture en vol par livre :
  ```rust
  use std::collections::HashMap;

  pub struct AppState {
      // …
      /// One lock per book id: a second request for a book being extracted waits for it.
      opening: Mutex<HashMap<String, Arc<Mutex<()>>>>,
  }

  fn opened(&self, id: &str) -> Res<Arc<OpenBook>> {
      let lock = self.opening.lock().unwrap().entry(id.to_owned()).or_default().clone();
      let _guard = lock.lock().unwrap();
      if let Some(b) = self.open.lock().unwrap().iter().find(|(k, _)| k == id) {
          return Ok(b.1.clone());
      }
      // … ouverture inchangée …
      self.opening.lock().unwrap().remove(id);
      Ok(opened)
  }
  ```
  (initialiser `opening: Mutex::new(HashMap::new())` dans `setup`).
- **Correctif** — `storage.rs`, fermeture du curseur dans tous les cas :
  ```rust
  let result = (|| -> jni::errors::Result<Vec<Row>> {
      let mut rows = Vec::new();
      while env.call_method(&cursor, "moveToNext", "()Z", &[])?.z()? {
          rows.push(env.with_local_frame(16, |env| row(env, &cursor))?);
      }
      Ok(rows)
  })();
  let _ = env.call_method(&cursor, "close", "()V", &[]);
  result
  ```
  (`Row` étant le tuple déjà renvoyé par `row`).

### 4.6 S-15 — Liens actifs dans le cadre EPUB
- **Localisation** : `planche/src/TextReader.tsx:152`, hook `r.hooks.content.register`.
- **Mécanisme** : epub.js laisse `mailto:` intact, met les liens absolus en `target="_blank"` et gère les relatifs lui-même. Le cadre est `sandbox="allow-same-origin"` sans `allow-popups` ni `allow-top-navigation`, ce qui neutralise `_blank`/`_top` ; le clic sur `mailto:`/`tel:` reste une navigation du cadre vers un schéma externe, bloquée par Chromium/WebView2 mais non vérifiée sous WebKitGTK/macOS.
- **Correctif** — dans le hook, après `applyCss(...)` :
  ```ts
  // Book links: only in-book navigation stays clickable. External, mail and
  // phone links become plain text (the sandboxed frame must not leave the app).
  for (const a of Array.from(contents.document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (/^(mailto|tel|sms|javascript|data|file|intent):/i.test(href) || /^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
      a.removeAttribute("href");
      a.removeAttribute("target");
      a.setAttribute("role", "text");
    }
  }
  ```

### 4.7 S-18 — Garde optionnelle contre les requêtes vers le réseau local (par conception, non appliquée)
- **Localisation** : `planche/src-tauri/src/opds.rs` `check_url` / `request`.
- **Mécanisme** : les liens d'un flux sont choisis par le serveur ; le moteur les suit (`http`/`https` seuls, identifiants uniquement vers l'origine du catalogue). Pour un lecteur de bureau dont l'usage visé est Komga/Kavita sur le LAN, bloquer les adresses privées casserait le cas nominal. Si l'on veut limiter la portée d'un catalogue distant hostile : n'autoriser une adresse locale ou privée que lorsque le **catalogue lui-même** est local.
- **Correctif optionnel** :
  ```rust
  fn is_local_host(url: &Url) -> bool {
      match url.host() {
          Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost") || d.ends_with(".local") || !d.contains('.'),
          Some(url::Host::Ipv4(ip)) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
          Some(url::Host::Ipv6(ip)) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80,
          None => true,
      }
  }

  // dans request(), après check_url :
  if is_local_host(&url) && !is_local_host(&base) {
      bail!("adresse locale refusée depuis un catalogue distant");
  }
  ```
  (la résolution DNS n'est pas vérifiée : un nom public résolu en adresse privée passe ; une garde complète demanderait un résolveur personnalisé dans reqwest.)

## 5. Ce qui reste à faire par le propriétaire du dépôt

1. GitHub > Settings > Code security : activer **Private vulnerability reporting** (le `SECURITY.md` y renvoie).
2. GitHub > Settings > Emails : **Keep my email addresses private** et **Block command line pushes that expose my email** (S-16).
3. §4.7 (garde contre les adresses locales) seulement si le besoin apparaît.
