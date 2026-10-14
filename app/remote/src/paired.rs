//! The phone's paired desktops: one file the phone's Rust owns (#346).
//!
//! Each entry is what the phone needs to dial a desktop again and to say which
//! one it is: the endpoint id, the relay hint, the desktop's own name, the name
//! the person gave it, and when it was paired and last seen. **Never a pairing
//! secret**: the secret is burnt the moment it is used, and nothing after
//! pairing needs it. Only the phone's own key goes in the Keychain or Keystore.
//!
//! The rules are the desktop's `store.rs`, for the same reasons:
//!
//! - **A file that cannot be read is never overwritten.** Absent is an empty
//!   list; unreadable is a sentence naming the file, and every write refuses on
//!   it. An empty list drawn over a file nobody could read would read as *no
//!   desktops*, and a write over it would unpair every one of them.
//! - **A write is a temporary file and a rename**, so a crash leaves the old
//!   list or the new one and never half of one.
//!
//! And one of its own: **every read-modify-write holds one lock.** A probe
//! marking a desktop seen and an unpair removing it can run at once, and a
//! `seen` that read before the removal and wrote after it would bring the
//! desktop back. So there is one [`PairedList`] per file, behind an `Arc`, and
//! `seen` and `set_relay` only ever touch an entry that is still there.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use iroh_base::PublicKey;
use serde::{Deserialize, Serialize};

/// The file's name inside the phone app's data directory.
pub const FILE: &str = "paired-desktops.json";

const VERSION: u32 = 1;

/// One paired desktop.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopEntry {
    /// The desktop's endpoint id, as `PublicKey`'s `Display` writes it.
    pub id: String,
    /// The desktop's home relay when last heard of: a hint for the first dial,
    /// never the only road. Null when there was none to learn.
    pub relay: Option<String>,
    /// The desktop's own name, as it said it. Null when it could not say.
    pub desktop_name: Option<String>,
    /// The name the person gave it on this phone. Null until renamed. Never
    /// sent to the desktop.
    pub name: Option<String>,
    /// Milliseconds since the epoch.
    pub paired_at: u64,
    /// Milliseconds since the epoch; null until the phone has reached it after
    /// pairing.
    pub last_seen: Option<u64>,
}

impl DesktopEntry {
    /// What the phone calls this desktop: the person's name, else the
    /// desktop's own, else its id cut short.
    pub fn called(&self) -> String {
        self.name
            .clone()
            .or_else(|| self.desktop_name.clone())
            .unwrap_or_else(|| self.id.chars().take(10).collect())
    }
}

/// The whole file.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedFile {
    pub desktops: Vec<DesktopEntry>,
    /// The desktop the phone opened last, so it opens there again. Cleared when
    /// that desktop is unpaired.
    pub current: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct OnDisk {
    version: u32,
    #[serde(flatten)]
    file: PairedFile,
}

/// The list, serialised: one per file, shared.
#[derive(Debug)]
pub struct PairedList {
    path: PathBuf,
    lock: Mutex<()>,
}

impl PairedList {
    pub fn at(path: PathBuf) -> Self {
        PairedList { path, lock: Mutex::new(()) }
    }

    /// The list in the app's data directory.
    pub fn in_dir(dir: &Path) -> Self {
        PairedList::at(dir.join(FILE))
    }

    fn unreadable(&self, why: impl std::fmt::Display) -> String {
        format!("the paired desktops list at {} could not be read: {why}", self.path.display())
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn load(&self) -> Result<PairedFile, String> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(PairedFile::default()),
            Err(e) => return Err(self.unreadable(e)),
        };
        let disk: OnDisk = serde_json::from_str(&text).map_err(|e| self.unreadable(e))?;
        if disk.version != VERSION {
            return Err(self.unreadable(format!("it is version {}, and this app reads version {VERSION}", disk.version)));
        }
        for d in &disk.file.desktops {
            d.id.parse::<PublicKey>()
                .map_err(|e| self.unreadable(format!("{:?} is not an endpoint id: {e}", d.id)))?;
        }
        Ok(disk.file)
    }

    fn write(&self, file: PairedFile) -> Result<(), String> {
        let refuse = |e: std::io::Error| format!("the paired desktops list at {} could not be written: {e}", self.path.display());
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(refuse)?;
        }
        let text = serde_json::to_string_pretty(&OnDisk { version: VERSION, file }).map_err(|e| refuse(std::io::Error::other(e)))?;
        let tmp = self.path.with_extension("json.tmp");
        let mut out = fs::File::create(&tmp).map_err(refuse)?;
        out.write_all(text.as_bytes()).map_err(refuse)?;
        out.sync_all().map_err(refuse)?;
        drop(out);
        fs::rename(&tmp, &self.path).map_err(refuse)
    }

    /// Read, change and write under the lock. `change` answers whether it
    /// changed anything; nothing is written when it did not.
    fn update<T>(&self, change: impl FnOnce(&mut PairedFile) -> (bool, T)) -> Result<T, String> {
        let _held = self.guard();
        let mut file = self.load()?;
        let (changed, out) = change(&mut file);
        if changed {
            self.write(file)?;
        }
        Ok(out)
    }

    /// The list. Absent is empty; unreadable is a sentence, never an empty list.
    pub fn read(&self) -> Result<PairedFile, String> {
        let _held = self.guard();
        self.load()
    }

    /// Add a desktop, replacing an entry with the same id: pairing again with
    /// one desktop is one desktop. Refuses, writing nothing, on a file that
    /// cannot be read.
    pub fn add(&self, entry: DesktopEntry) -> Result<(), String> {
        self.update(|f| {
            f.desktops.retain(|d| d.id != entry.id);
            f.desktops.push(entry);
            (true, ())
        })
    }

    /// The person's name for a desktop. A blank one clears it, so the
    /// desktop's own name shows again. False when no such desktop is paired.
    pub fn rename(&self, id: &str, name: Option<&str>) -> Result<bool, String> {
        let name = name.map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);
        self.update(|f| match f.desktops.iter_mut().find(|d| d.id == id) {
            Some(d) => {
                d.name = name;
                (true, true)
            }
            None => (false, false),
        })
    }

    /// The phone reached this desktop at `at`. Touches only an entry that is
    /// still there: false, and nothing written, for one that was unpaired.
    pub fn seen(&self, id: &str, at: u64) -> Result<bool, String> {
        self.update(|f| match f.desktops.iter_mut().find(|d| d.id == id) {
            Some(d) => {
                d.last_seen = Some(at);
                (true, true)
            }
            None => (false, false),
        })
    }

    /// The desktop's relay as last learned, replacing a stale hint, or
    /// clearing it. Touches only an entry that is still there.
    pub fn set_relay(&self, id: &str, relay: Option<String>) -> Result<bool, String> {
        self.update(|f| match f.desktops.iter_mut().find(|d| d.id == id) {
            Some(d) if d.relay == relay => (false, true),
            Some(d) => {
                d.relay = relay;
                (true, true)
            }
            None => (false, false),
        })
    }

    /// Forget a desktop, and stop opening it at start if it was the current
    /// one. False when it was not paired.
    pub fn remove(&self, id: &str) -> Result<bool, String> {
        self.update(|f| {
            let before = f.desktops.len();
            f.desktops.retain(|d| d.id != id);
            let removed = f.desktops.len() != before;
            let was_current = f.current.as_deref() == Some(id);
            if was_current {
                f.current = None;
            }
            (removed || was_current, removed)
        })
    }

    /// The desktop to open at start, or none. Only a paired one can be current.
    pub fn set_current(&self, id: Option<&str>) -> Result<(), String> {
        self.update(|f| {
            let next = id.filter(|id| f.desktops.iter().any(|d| d.id == *id)).map(str::to_string);
            let changed = f.current != next;
            f.current = next;
            (changed, ())
        })
    }

    /// One desktop's entry, if it is paired.
    pub fn get(&self, id: &str) -> Result<Option<DesktopEntry>, String> {
        Ok(self.read()?.desktops.into_iter().find(|d| d.id == id))
    }

    /// Whether a desktop is paired. A list that cannot be read answers false:
    /// a reconnect loop must not dial on the strength of a file it cannot read.
    pub fn contains(&self, id: &str) -> bool {
        self.read().is_ok_and(|f| f.desktops.iter().any(|d| d.id == id))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use iroh_base::SecretKey;
    use std::sync::Arc;

    pub(crate) struct Scratch(pub(crate) PathBuf);

    impl Scratch {
        pub(crate) fn new(tag: &str) -> Self {
            let unique = format!(
                "vibe-paired-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos())
            );
            let dir = std::env::temp_dir().join(unique);
            fs::create_dir_all(&dir).expect("a scratch dir");
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn id(seed: u8) -> String {
        SecretKey::from_bytes(&[seed; 32]).public().to_string()
    }

    fn entry(seed: u8) -> DesktopEntry {
        DesktopEntry {
            id: id(seed),
            relay: Some("https://relay.example./".into()),
            desktop_name: Some(format!("desk {seed}")),
            name: None,
            paired_at: 1_000,
            last_seen: None,
        }
    }

    #[test]
    fn the_list_survives_a_new_instance() {
        let dir = Scratch::new("survives");
        let list = PairedList::in_dir(&dir.0.join("nested"));
        assert_eq!(list.read().unwrap(), PairedFile::default(), "absent is empty");
        list.add(entry(1)).unwrap();
        list.add(entry(2)).unwrap();
        list.set_current(Some(&id(2))).unwrap();
        let again = PairedList::in_dir(&dir.0.join("nested")).read().unwrap();
        assert_eq!(again.desktops, vec![entry(1), entry(2)]);
        assert_eq!(again.current, Some(id(2)));
    }

    #[test]
    fn pairing_one_desktop_again_replaces_it() {
        let dir = Scratch::new("again");
        let list = PairedList::in_dir(&dir.0);
        list.add(entry(1)).unwrap();
        list.add(DesktopEntry { paired_at: 2_000, ..entry(1) }).unwrap();
        let file = list.read().unwrap();
        assert_eq!(file.desktops.len(), 1);
        assert_eq!(file.desktops[0].paired_at, 2_000);
    }

    #[test]
    fn a_rename_keeps_the_id_and_the_desktop_s_own_name() {
        let dir = Scratch::new("rename");
        let list = PairedList::in_dir(&dir.0);
        list.add(entry(1)).unwrap();
        assert!(list.rename(&id(1), Some("  Studio  ")).unwrap());
        let d = list.get(&id(1)).unwrap().unwrap();
        assert_eq!((d.id.as_str(), d.desktop_name.as_deref(), d.name.as_deref()), (id(1).as_str(), Some("desk 1"), Some("Studio")));
        assert_eq!(d.called(), "Studio");
        assert!(list.rename(&id(1), Some("   ")).unwrap());
        assert_eq!(list.get(&id(1)).unwrap().unwrap().name, None, "a blank name clears it");
        assert!(!list.rename(&id(9), Some("x")).unwrap(), "no such desktop");
    }

    #[test]
    fn removing_the_current_desktop_clears_current_and_another_does_not() {
        let dir = Scratch::new("remove");
        let list = PairedList::in_dir(&dir.0);
        list.add(entry(1)).unwrap();
        list.add(entry(2)).unwrap();
        list.set_current(Some(&id(1))).unwrap();
        assert!(list.remove(&id(2)).unwrap());
        assert_eq!(list.read().unwrap().current, Some(id(1)));
        assert!(list.remove(&id(1)).unwrap());
        assert_eq!(list.read().unwrap(), PairedFile::default());
        assert!(!list.remove(&id(1)).unwrap());
    }

    #[test]
    fn an_unreadable_file_is_an_error_left_untouched_and_refuses_an_add() {
        let dir = Scratch::new("unreadable");
        fs::write(dir.0.join(FILE), "{ not json").unwrap();
        let list = PairedList::in_dir(&dir.0);
        let why = list.read().expect_err("never an empty list");
        assert!(why.contains("could not be read"), "{why}");
        assert!(list.add(entry(1)).is_err());
        assert!(list.seen(&id(1), 5).is_err());
        assert!(list.remove(&id(1)).is_err());
        assert!(!list.contains(&id(1)));
        assert_eq!(fs::read_to_string(dir.0.join(FILE)).unwrap(), "{ not json", "the file was not overwritten");
    }

    #[test]
    fn no_secret_is_ever_written() {
        let dir = Scratch::new("secret");
        let list = PairedList::in_dir(&dir.0);
        list.add(entry(1)).unwrap();
        let text = fs::read_to_string(dir.0.join(FILE)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let keys: Vec<&str> = value["desktops"][0].as_object().unwrap().keys().map(String::as_str).collect();
        assert!(!keys.iter().any(|k| *k == "secret" || *k == "s"), "{keys:?}");
        assert!(!text.contains("secret"));
    }

    #[test]
    fn seen_and_set_relay_never_bring_a_removed_desktop_back() {
        let dir = Scratch::new("touch-removed");
        let list = PairedList::in_dir(&dir.0);
        list.add(entry(1)).unwrap();
        list.remove(&id(1)).unwrap();
        assert!(!list.seen(&id(1), 5).unwrap());
        assert!(!list.set_relay(&id(1), None).unwrap());
        assert!(list.read().unwrap().desktops.is_empty());
        list.add(entry(2)).unwrap();
        assert!(list.set_relay(&id(2), None).unwrap());
        assert_eq!(list.get(&id(2)).unwrap().unwrap().relay, None, "a stale hint can be cleared");
    }

    #[test]
    fn concurrent_seen_beside_a_removal_loses_neither() {
        let dir = Scratch::new("concurrent");
        let list = Arc::new(PairedList::in_dir(&dir.0));
        for seed in 0..6 {
            list.add(entry(seed)).unwrap();
        }
        std::thread::scope(|s| {
            for seed in 0..6u8 {
                let list = list.clone();
                s.spawn(move || {
                    for at in 0..20 {
                        list.seen(&id(seed), 100 + at).unwrap();
                    }
                });
            }
            let list = list.clone();
            s.spawn(move || list.remove(&id(0)).unwrap());
        });
        let file = list.read().unwrap();
        assert!(file.desktops.iter().all(|d| d.id != id(0)), "the removed desktop stays removed");
        for seed in 1..6 {
            assert_eq!(list.get(&id(seed)).unwrap().unwrap().last_seen, Some(119), "desktop {seed}");
        }
    }
}
