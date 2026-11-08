# UnRAR source vendored in Planche

`unrar/` is the UnRAR library source (RARLAB, unrarsrc 7.0.9 = `version.hpp` 7.1.0,
12/05/2024), compiled into Planche by `../build.rs`.

## Planche patches

On top of the four patches of the unrar.rs project listed in [`patches.txt`](./patches.txt)
(commits of https://github.com/muja/unrar.rs, already applied here):

- `dll.cpp`, `RARReadHeaderEx`: iterative with a bound (`RepeatCount > 0x10000` →
  `ERAR_BAD_ARCHIVE`) instead of calling itself once per "split before" header (list
  mode) or merged volume. A crafted archive exhausted the stack and killed the process.
  Same change as UnRAR 7.3.x (WinRAR 7.30: "fixed a crash in unrar.dll library caused by
  excessive function recursion"). Marked `Planche patch` in the source.

## Updating

The commits of `patches.txt` are not in Planche's history, so `upgrade.sh`
(`git cherry-pick`) does not work in this repository. To move to a newer UnRAR:

1. Download `unrarsrc-X.Y.Z.tar.gz` from https://www.rarlab.com/rar_add.htm, check its
   SHA-256 against another source (for example Debian's `unrar-nonfree` `.orig.tar.gz`),
   and replace `unrar/` with its content.
2. Re-apply the unrar.rs patches still needed (from the unrar.rs repository:
   `git diff <sha>^ <sha> -- unrar_sys/vendor/unrar | git apply -p2 --directory=planche/src-tauri/vendor/unrar_sys`),
   and the Planche patch above if the new version still recurses in `RARReadHeaderEx`.
3. Compare `OBJECTS` in the new `makefile` with the file list of `../build.rs` (7.2+
   adds `largepage`; `motw` is needed on Windows only).
4. `cargo test` in `planche/src-tauri`, then open a CBR, a multi-volume CBR and an
   encrypted CBR on Windows, Linux and Android.
