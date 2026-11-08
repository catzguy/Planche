# Politique de sécurité

## Versions prises en charge

La dernière version publiée dans les [Releases](https://github.com/catzguy/Planche/releases) et la branche `develop`. Les pré-versions `develop-latest` servent aux tests et ne reçoivent pas de correctif à part.

## Signaler une vulnérabilité

Ne pas ouvrir d'issue publique. Utiliser **Security > Report a vulnerability** sur ce dépôt (signalement privé GitHub) en décrivant :

- la version de Planche et le système (Windows, Linux, macOS, Android) ;
- le fichier, le flux OPDS ou l'enchaînement qui déclenche le problème ;
- l'effet observé (lecture d'un fichier hors de la bibliothèque, exécution de code, fuite d'identifiants, plantage…).

Accusé de réception sous 7 jours. Le correctif est publié dans une version dédiée, avec mention du rapporteur s'il le souhaite. Merci de laisser le temps de corriger avant toute publication.

## Périmètre

- Le code de `planche/` : moteur Rust (`src-tauri`), interface (`src`), projet Android (`src-tauri/gen/android`, `src-tauri/plugins`).
- Les workflows GitHub (`.github/workflows`).
- Les paquets publiés (installateurs Windows, paquets Linux, APK, MSIX).

Hors périmètre : les serveurs OPDS tiers (Komga, Kavita…), le système d'exploitation, WebView2 / WebKitGTK / WebView Android, et les vulnérabilités d'une dépendance qui ne sont pas exploitables à travers Planche (les signaler au projet concerné ; Dependabot et CodeQL surveillent les dépendances).

## Ce que fait déjà Planche

Les fichiers ouverts et les catalogues sont considérés comme non fiables : voir [docs/SECURITE.md](docs/SECURITE.md), [docs/REVUE_SECURITE_2026-11-08.md](docs/REVUE_SECURITE_2026-11-08.md), [docs/AUDIT_OPEN_SOURCE_2026-11-08.md](docs/AUDIT_OPEN_SOURCE_2026-11-08.md) et [docs/AUDIT_BOITE_BLANCHE_2026-11-08.md](docs/AUDIT_BOITE_BLANCHE_2026-11-08.md) (constats ouverts et correctifs prévus).
