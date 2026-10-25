//! Encrypted storage for the library database.
//!
//! The SQLite database only ever lives in memory inside the app process: no
//! SQLite file is open on disk, so no other program can attach to it or read
//! it while Planche runs. Changes are persisted as a snapshot (sqlite3_serialize)
//! encrypted with XChaCha20-Poly1305 into `library.planche`. The random 256-bit
//! key is kept in the OS credential store (Windows Credential Manager, macOS
//! Keychain, Secret Service), never next to the file, so the snapshot is
//! unreadable on its own (copied file, backup, cloud sync, another account).
//! Without a reachable credential store (some Linux desktops), the key falls
//! back to a user-only file in the config directory.

use anyhow::{anyhow, bail, Context, Result};
use chacha20poly1305::aead::{Aead, Generate, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rusqlite::{Connection, MAIN_DB};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const MAGIC: &[u8] = b"PLANCHE-DB\x01";
const NONCE_LEN: usize = 24;
const KEYRING_SERVICE: &str = "Planche";
const KEYRING_USER: &str = "library-database-key";
/// Database file name used before encryption; migrated then erased.
const LEGACY_DB: &str = "library.db";
const VAULT_FILE: &str = "library.planche";
const KEY_FILE: &str = "library.key";

pub struct Vault {
    path: PathBuf,
    cipher: XChaCha20Poly1305,
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    (0..s.len())
        .step_by(2)
        .map(|i| s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()))
        .collect()
}

fn parse_key(hex: &str) -> Result<Key> {
    let bytes = from_hex(hex.trim()).filter(|b| b.len() == 32).ok_or_else(|| anyhow!("corrupt database key"))?;
    Key::try_from(bytes.as_slice()).map_err(|_| anyhow!("corrupt database key"))
}

/// Fallback key file, used only when no credential store is reachable (a Linux
/// desktop without a Secret Service such as GNOME Keyring or KWallet). It lives
/// in the config directory, apart from the data, readable by the user only.
fn read_key_file(path: &Path) -> Result<Option<Key>> {
    match fs::read_to_string(path) {
        Ok(hex) => parse_key(&hex).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn write_key_file(path: &Path, key: &Key) -> Result<()> {
    let mut dir = fs::DirBuilder::new();
    dir.recursive(true);
    let mut file = fs::OpenOptions::new();
    file.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        dir.mode(0o700);
        file.mode(0o600);
    }
    if let Some(parent) = path.parent() {
        dir.create(parent)?;
    }
    let mut f = file.open(path).context("writing the database key file")?;
    f.write_all(to_hex(key).as_bytes())?;
    f.sync_all()?;
    Ok(())
}

/// A new random key, kept in the credential store or else in the key file.
fn new_key(entry: Option<&keyring::Entry>, key_file: &Path) -> Result<Key> {
    let key = Key::generate();
    if entry.is_none_or(|e| e.set_password(&to_hex(&key)).is_err()) {
        write_key_file(key_file, &key)?;
    }
    Ok(key)
}

/// The database key from the credential store, created on first use. A
/// missing key with an existing vault is an error: generating a new key would
/// make the library unreadable, so we never do it silently.
fn load_key(vault_exists: bool, key_file: &Path) -> Result<Key> {
    let fallback = read_key_file(key_file)?;
    let entry = match keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        Ok(entry) => entry,
        // No credential store on this system.
        Err(e) => {
            return match fallback {
                Some(key) => Ok(key),
                None if vault_exists => bail!("database key not found (no credential store: {e})"),
                None => new_key(None, key_file),
            };
        }
    };
    match entry.get_password() {
        Ok(hex) => parse_key(&hex),
        Err(keyring::Error::NoEntry) => match fallback {
            // A credential store is available now: move the key into it.
            Some(key) => {
                if entry.set_password(&to_hex(&key)).is_ok() {
                    erase(key_file);
                }
                Ok(key)
            }
            None if vault_exists => bail!("database key not found in the credential store"),
            None => new_key(Some(&entry), key_file),
        },
        // The store exists but cannot be used (no Secret Service running, locked).
        Err(e) => match fallback {
            Some(key) => Ok(key),
            None if vault_exists => bail!("credential store: {e}"),
            None => new_key(None, key_file),
        },
    }
}

/// Overwrites then deletes a file holding plaintext data (best effort: SSDs
/// and copy-on-write file systems may keep older blocks).
fn erase(path: &Path) {
    if let Ok(meta) = fs::metadata(path) {
        if let Ok(mut f) = fs::OpenOptions::new().write(true).open(path) {
            let zeros = vec![0u8; 64 * 1024];
            let mut left = meta.len();
            while left > 0 {
                let n = left.min(zeros.len() as u64) as usize;
                if f.write_all(&zeros[..n]).is_err() {
                    break;
                }
                left -= n as u64;
            }
            let _ = f.sync_all();
        }
        let _ = fs::remove_file(path);
    }
}

/// Marks a database image as rollback-journal mode. A database migrated from
/// the WAL-mode `library.db` keeps the WAL version bytes (offsets 18-19) in
/// its header, and SQLite refuses to open such an image in memory
/// ("unable to open database file").
fn rollback_journal(image: &mut [u8]) {
    if image.len() >= 20 && image.starts_with(b"SQLite format 3\0") {
        image[18] = 1;
        image[19] = 1;
    }
}

impl Vault {
    /// Opens the library: an in-memory connection loaded from the encrypted
    /// snapshot, or migrated from a legacy plaintext `library.db`. `config_dir`
    /// holds the fallback key file when there is no credential store.
    pub fn open(data_dir: &Path, config_dir: &Path) -> Result<(Connection, Vault)> {
        let path = data_dir.join(VAULT_FILE);
        let key = load_key(path.exists(), &config_dir.join(KEY_FILE))?;
        let vault = Vault { path, cipher: XChaCha20Poly1305::new(&key) };
        let mut conn = Connection::open_in_memory()?;
        let legacy = data_dir.join(LEGACY_DB);
        if vault.path.exists() {
            let mut data = vault.decrypt(&fs::read(&vault.path)?)?;
            rollback_journal(&mut data);
            let len = data.len();
            conn.deserialize_read_exact(MAIN_DB, data.as_slice(), len, false)
                .context("loading the library")?;
        } else if legacy.exists() {
            conn.restore(MAIN_DB, &legacy, None::<fn(rusqlite::backup::Progress)>)
                .context("migrating the plaintext database")?;
            vault.save(&mut conn)?;
            for suffix in ["", "-wal", "-shm", "-journal"] {
                erase(&data_dir.join(format!("{LEGACY_DB}{suffix}")));
            }
        }
        Ok((conn, vault))
    }

    fn decrypt(&self, file: &[u8]) -> Result<Vec<u8>> {
        if file.len() < MAGIC.len() + NONCE_LEN || !file.starts_with(MAGIC) {
            bail!("not a Planche database");
        }
        let (nonce, body) = file[MAGIC.len()..].split_at(NONCE_LEN);
        let nonce = XNonce::try_from(nonce).map_err(|_| anyhow!("bad nonce"))?;
        self.cipher
            .decrypt(&nonce, Payload { msg: body, aad: MAGIC })
            .map_err(|_| anyhow!("database decryption failed (wrong key or tampered file)"))
    }

    /// Writes an encrypted snapshot atomically (temporary file, then rename).
    pub fn save(&self, conn: &mut Connection) -> Result<()> {
        let mut plain = conn.serialize(MAIN_DB)?.to_vec();
        rollback_journal(&mut plain);
        let nonce = XNonce::generate();
        let sealed = self
            .cipher
            .encrypt(&nonce, Payload { msg: &plain, aad: MAGIC })
            .map_err(|_| anyhow!("database encryption failed"))?;
        drop(plain);
        let tmp = self.path.with_extension("planche.tmp");
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(MAGIC)?;
            f.write_all(&nonce)?;
            f.write_all(&sealed)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_round_trip_and_tamper_detection() {
        let vault = Vault { path: PathBuf::new(), cipher: XChaCha20Poly1305::new(&Key::generate()) };
        let nonce = XNonce::generate();
        let sealed = vault.cipher.encrypt(&nonce, Payload { msg: b"SQLite format 3", aad: MAGIC }).unwrap();
        let mut file = [MAGIC, nonce.as_slice(), &sealed].concat();
        assert_eq!(vault.decrypt(&file).unwrap(), b"SQLite format 3");
        let last = file.len() - 1;
        file[last] ^= 1;
        assert!(vault.decrypt(&file).is_err());
        let other = Vault { path: PathBuf::new(), cipher: XChaCha20Poly1305::new(&Key::generate()) };
        file[last] ^= 1;
        assert!(other.decrypt(&file).is_err());
    }

    #[test]
    fn migrated_wal_database_reloads() {
        let dir = std::env::temp_dir().join(format!("planche-wal-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(LEGACY_DB);
        {
            let c = Connection::open(&file).unwrap();
            c.pragma_update(None, "journal_mode", "WAL").unwrap();
            c.execute_batch("CREATE TABLE t(x); INSERT INTO t VALUES(42);").unwrap();
        }
        let mut mem = Connection::open_in_memory().unwrap();
        mem.restore(MAIN_DB, &file, None::<fn(rusqlite::backup::Progress)>).unwrap();
        let mut image = mem.serialize(MAIN_DB).unwrap().to_vec();
        rollback_journal(&mut image);
        let mut back = Connection::open_in_memory().unwrap();
        let len = image.len();
        back.deserialize_read_exact(MAIN_DB, image.as_slice(), len, false).unwrap();
        let x: i64 = back.query_row("SELECT x FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(x, 42);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fallback_key_file_round_trip() {
        let dir = std::env::temp_dir().join(format!("planche-key-{}", std::process::id()));
        let path = dir.join("sub").join(KEY_FILE);
        assert!(read_key_file(&path).unwrap().is_none());
        let key = Key::generate();
        write_key_file(&path, &key).unwrap();
        assert_eq!(read_key_file(&path).unwrap().unwrap(), key);
        // Never overwrites an existing key.
        assert!(write_key_file(&path, &Key::generate()).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
