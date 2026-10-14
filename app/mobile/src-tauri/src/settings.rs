//! `phone.json`: what this phone remembers about itself (#346).
//!
//! Three settings, all the phone's own and none of them the desktop's: the app
//! lock (on by default, as the product spec says), notifications (on), and the
//! name this phone gives itself in a pairing and a `Hello`.
//!
//! The paired list's rules hold here too: **a file that cannot be read is never
//! overwritten**, and a write is a temporary file and a rename under one lock.
//! A file that cannot be read is reported, and its defaults are used - which
//! keeps the lock on.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub const FILE: &str = "phone.json";

/// The name a phone starts with until the person types their own.
pub fn default_name() -> String {
    if cfg!(target_os = "ios") {
        "iPhone".into()
    } else if cfg!(target_os = "android") {
        "Android phone".into()
    } else {
        "Phone".into()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PhoneSettings {
    /// Ask for Face ID, Touch ID or the device's fingerprint or PIN to open
    /// the app, and again after five minutes in the background.
    pub lock: bool,
    /// Local notifications while the app is alive.
    pub notify: bool,
    pub name: String,
}

impl Default for PhoneSettings {
    fn default() -> Self {
        PhoneSettings { lock: true, notify: true, name: default_name() }
    }
}

/// A change to the settings. Every field optional.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    pub lock: Option<bool>,
    pub notify: Option<bool>,
    pub name: Option<String>,
}

/// The settings as read, and why the file could not be, if it could not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Loaded {
    pub settings: PhoneSettings,
    pub problem: Option<String>,
}

#[derive(Debug)]
pub struct SettingsFile {
    path: PathBuf,
    lock: Mutex<()>,
}

impl SettingsFile {
    pub fn in_dir(dir: &Path) -> Self {
        SettingsFile { path: dir.join(FILE), lock: Mutex::new(()) }
    }

    fn read(&self) -> Loaded {
        match fs::read_to_string(&self.path) {
            Ok(text) => match serde_json::from_str::<PhoneSettings>(&text) {
                Ok(settings) => Loaded { settings, problem: None },
                Err(e) => Loaded { settings: PhoneSettings::default(), problem: Some(self.unreadable(e)) },
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Loaded { settings: PhoneSettings::default(), problem: None },
            Err(e) => Loaded { settings: PhoneSettings::default(), problem: Some(self.unreadable(e)) },
        }
    }

    fn unreadable(&self, why: impl std::fmt::Display) -> String {
        format!("this phone's settings at {} could not be read: {why}", self.path.display())
    }

    pub fn load(&self) -> Loaded {
        let _held = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        self.read()
    }

    /// Apply a patch. Refuses, writing nothing, when the file cannot be read.
    pub fn apply(&self, patch: &Patch) -> Result<PhoneSettings, String> {
        let _held = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let loaded = self.read();
        if let Some(why) = loaded.problem {
            return Err(why);
        }
        let mut next = loaded.settings;
        if let Some(lock) = patch.lock {
            next.lock = lock;
        }
        if let Some(notify) = patch.notify {
            next.notify = notify;
        }
        if let Some(name) = &patch.name {
            let name = vibe_remote::wire::phone_name(name).map_err(|e| e.to_string())?;
            next.name = name;
        }
        self.write(&next)?;
        Ok(next)
    }

    fn write(&self, settings: &PhoneSettings) -> Result<(), String> {
        let refuse = |e: std::io::Error| format!("this phone's settings at {} could not be written: {e}", self.path.display());
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(refuse)?;
        }
        let text = serde_json::to_string_pretty(settings).map_err(|e| refuse(std::io::Error::other(e)))?;
        let tmp = self.path.with_extension("json.tmp");
        let mut out = fs::File::create(&tmp).map_err(refuse)?;
        out.write_all(text.as_bytes()).map_err(refuse)?;
        out.sync_all().map_err(refuse)?;
        drop(out);
        fs::rename(&tmp, &self.path).map_err(refuse)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) struct Scratch(pub(crate) PathBuf);

    impl Scratch {
        pub(crate) fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "vibe-mobile-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos())
            ));
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_lock_and_notifications_are_on_by_default() {
        let dir = Scratch::new("settings-default");
        let loaded = SettingsFile::in_dir(&dir.0).load();
        assert_eq!(loaded, Loaded { settings: PhoneSettings::default(), problem: None });
        assert!(loaded.settings.lock && loaded.settings.notify);
    }

    #[test]
    fn a_patch_is_kept_and_a_name_is_made_fit() {
        let dir = Scratch::new("settings-patch");
        let file = SettingsFile::in_dir(&dir.0);
        let next = file.apply(&Patch { lock: Some(false), notify: None, name: Some("  Adam's phone\n".into()) }).unwrap();
        assert_eq!(next, PhoneSettings { lock: false, notify: true, name: "Adam's phone".into() });
        assert_eq!(SettingsFile::in_dir(&dir.0).load().settings, next);
        assert!(file.apply(&Patch { name: Some("   ".into()), ..Patch::default() }).is_err(), "a blank name is refused");
    }

    #[test]
    fn an_unreadable_file_keeps_the_lock_on_and_is_never_overwritten() {
        let dir = Scratch::new("settings-unreadable");
        fs::write(dir.0.join(FILE), "{ nope").unwrap();
        let file = SettingsFile::in_dir(&dir.0);
        let loaded = file.load();
        assert!(loaded.problem.is_some());
        assert!(loaded.settings.lock, "the default, which is on");
        assert!(file.apply(&Patch { lock: Some(false), ..Patch::default() }).is_err());
        assert_eq!(fs::read_to_string(dir.0.join(FILE)).unwrap(), "{ nope");
    }
}
