//! The paired phones: `remote-paired.json` in the app's data directory (#341).
//!
//! Rust's own file, never vibe's config: a project's `vibe.config.json` must
//! not be able to put a phone on this list.
//!
//! **A file that cannot be read is never overwritten.** Absent is an empty
//! list; unreadable is a sentence naming the file, and every write refuses on
//! it. Writing an empty list over a file nobody could read would unpair every
//! phone on it without a word, which is the silent loss this store exists to
//! avoid.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use iroh_base::PublicKey;
use serde::{Deserialize, Serialize};

/// The file's name inside the app data directory.
pub(crate) const FILE: &str = "remote-paired.json";

const VERSION: u32 = 1;

/// One paired phone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Phone {
    /// The endpoint id, as `PublicKey`'s `Display` writes it.
    pub(crate) id: String,
    pub(crate) name: String,
    /// Milliseconds since the epoch.
    pub(crate) paired_at: u64,
    /// Milliseconds since the epoch; null until connections are recorded.
    pub(crate) last_seen: Option<u64>,
}

#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    phones: Vec<Phone>,
}

#[derive(Clone, Debug)]
pub(crate) struct Store {
    path: PathBuf,
}

impl Store {
    pub(crate) fn new(path: PathBuf) -> Self {
        Store { path }
    }

    /// The store in an app data directory.
    pub(crate) fn in_dir(dir: &Path) -> Self {
        Store::new(dir.join(FILE))
    }

    fn unreadable(&self, why: impl std::fmt::Display) -> String {
        format!("the paired phones list at {} could not be read: {why}", self.path.display())
    }

    /// The list. Absent is empty; anything else that is not a version-1 list of
    /// phones with readable ids is an error naming the file.
    pub(crate) fn load(&self) -> Result<Vec<Phone>, String> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(self.unreadable(e)),
        };
        let file: File = serde_json::from_str(&text).map_err(|e| self.unreadable(e))?;
        if file.version != VERSION {
            return Err(self.unreadable(format!(
                "it is version {}, and this app reads version {VERSION}",
                file.version
            )));
        }
        for phone in &file.phones {
            phone
                .id
                .parse::<PublicKey>()
                .map_err(|e| self.unreadable(format!("{:?} is not an endpoint id: {e}", phone.id)))?;
        }
        Ok(file.phones)
    }

    /// Add a phone. Refuses, writing nothing, if the file cannot be read.
    pub(crate) fn add(&self, phone: Phone) -> Result<(), String> {
        let mut phones = self.load()?;
        phones.push(phone);
        self.write(phones)
    }

    /// Remove a phone, answering whether it was there. This is revoking from
    /// the desktop and, from #342, a phone unpairing itself: the same removal.
    /// An id not on the list writes nothing.
    pub(crate) fn remove(&self, id: &str) -> Result<bool, String> {
        let mut phones = self.load()?;
        let before = phones.len();
        phones.retain(|p| p.id != id);
        if phones.len() == before {
            return Ok(false);
        }
        self.write(phones)?;
        Ok(true)
    }

    /// A temporary file, flushed to disk, then renamed over the real one, so a
    /// crash leaves either the old list or the new one and never half of one.
    fn write(&self, phones: Vec<Phone>) -> Result<(), String> {
        let refuse = |e: std::io::Error| {
            format!("the paired phones list at {} could not be written: {e}", self.path.display())
        };
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(refuse)?;
        }
        let text = serde_json::to_string_pretty(&File { version: VERSION, phones })
            .map_err(|e| refuse(std::io::Error::other(e)))?;
        let tmp = self.path.with_extension("json.tmp");
        let mut file = fs::File::create(&tmp).map_err(refuse)?;
        file.write_all(text.as_bytes()).map_err(refuse)?;
        file.sync_all().map_err(refuse)?;
        drop(file);
        fs::rename(&tmp, &self.path).map_err(refuse)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use iroh_base::SecretKey;

    /// A fresh directory under the temp dir, removed on drop.
    pub(crate) struct Scratch(pub(crate) PathBuf);

    impl Scratch {
        pub(crate) fn new(tag: &str) -> Self {
            let unique = format!(
                "vibe-remote-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_nanos())
            );
            let dir = std::env::temp_dir().join(unique);
            fs::create_dir_all(&dir).expect("makes a scratch dir");
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    pub(crate) fn phone(seed: u8) -> Phone {
        Phone {
            id: SecretKey::from_bytes(&[seed; 32]).public().to_string(),
            name: format!("phone {seed}"),
            paired_at: 1_000,
            last_seen: None,
        }
    }

    #[test]
    fn a_list_round_trips() {
        let dir = Scratch::new("roundtrip");
        let store = Store::in_dir(&dir.0.join("nested"));
        store.add(phone(1)).expect("adds");
        store.add(phone(2)).expect("adds");
        assert_eq!(store.load(), Ok(vec![phone(1), phone(2)]));

        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.0.join("nested").join(FILE)).unwrap()).unwrap();
        assert_eq!(raw["version"], 1);
        assert_eq!(raw["phones"][0]["lastSeen"], serde_json::Value::Null);
        assert_eq!(raw["phones"][0]["pairedAt"], 1_000);
    }

    #[test]
    fn an_absent_file_is_an_empty_list() {
        let dir = Scratch::new("absent");
        assert_eq!(Store::in_dir(&dir.0).load(), Ok(vec![]));
    }

    #[test]
    fn an_unreadable_file_is_never_overwritten() {
        let dir = Scratch::new("unreadable");
        let path = dir.0.join(FILE);
        let store = Store::in_dir(&dir.0);
        for garbage in [
            "not json".to_string(),
            r#"{"version":2,"phones":[]}"#.to_string(),
            r#"{"version":1,"phones":[{"id":"nope","name":"x","pairedAt":1,"lastSeen":null}]}"#.to_string(),
        ] {
            fs::write(&path, &garbage).unwrap();
            let why = store.load().expect_err("refuses");
            assert!(why.contains(&path.display().to_string()), "{why}");
            assert!(store.add(phone(1)).is_err());
            assert!(store.remove(&phone(1).id).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), garbage, "left exactly as it was");
        }
    }

    #[test]
    fn a_write_is_a_rename_and_leaves_no_temporary_file() {
        let dir = Scratch::new("atomic");
        let store = Store::in_dir(&dir.0);
        // What a crash mid-write would have left beside a good list.
        store.add(phone(1)).expect("adds");
        fs::write(dir.0.join("remote-paired.json.tmp"), "half a fi").unwrap();
        assert_eq!(store.load(), Ok(vec![phone(1)]), "a stale temporary file is not read");

        store.add(phone(2)).expect("adds");
        assert!(!dir.0.join("remote-paired.json.tmp").exists());
        assert_eq!(store.load(), Ok(vec![phone(1), phone(2)]));
    }

    #[test]
    fn removing_a_phone_that_is_not_there_is_success_and_writes_nothing() {
        let dir = Scratch::new("remove");
        let store = Store::in_dir(&dir.0);
        assert_eq!(store.remove(&phone(1).id), Ok(false));
        assert!(!dir.0.join(FILE).exists());

        store.add(phone(1)).expect("adds");
        assert_eq!(store.remove(&phone(1).id), Ok(true));
        assert_eq!(store.load(), Ok(vec![]));
    }
}
