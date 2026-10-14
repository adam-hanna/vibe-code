//! Remote access's own settings: `remote.json` in the app's data directory
//! (#344), beside the paired phones list.
//!
//! **Rust's file, never vibe's config.** Rust reads it in `setup`, before any
//! window or host exists, because a start at login opens to the tray and the
//! endpoint has to start without one. The core never reads it, so no project's
//! `vibe.config.json` can turn remote access on or name a relay.
//!
//! **A file that cannot be read means off, and says why.** Never the defaults
//! in silence: a file saying `enabled: true` whose other half is garbage is
//! still off, with the sentence, which is the fail-closed direction. And it is
//! never overwritten, for `store.rs`'s reason - the person fixes or deletes it.
//!
//! **No secret lives here.** Four fields, none of them a key: the device key
//! stays in the keychain.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use iroh::RelayUrl;
use serde::{Deserialize, Deserializer, Serialize};

/// The file's name inside the app data directory.
pub(crate) const FILE: &str = "remote.json";

/// What `remote.json` holds. Every field defaults, so a file naming only some
/// of them is complete; a field this build does not know refuses the file
/// rather than being dropped on the next write.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub start_at_login: bool,
    #[serde(default)]
    pub keep_awake: bool,
    /// A relay of the person's own, an `https` URL, replacing n0's relays.
    #[serde(default)]
    pub relay: Option<String>,
}

/// A change to some of the four fields. An absent field is left alone; `relay:
/// null` clears the relay, which is why it is an option of an option.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Patch {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub start_at_login: Option<bool>,
    #[serde(default)]
    pub keep_awake: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    pub relay: Option<Option<String>>,
}

/// A field that is present, null included, is `Some`; serde's default gives
/// `None` when it is absent.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

/// The settings as read, and why the file could not be, when it could not.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Loaded {
    /// The defaults - off - whenever `unreadable` is set.
    pub settings: Settings,
    pub unreadable: Option<String>,
}

impl Loaded {
    /// Off, with the reason. Used when there is no data directory at all.
    pub(crate) fn unreadable(why: String) -> Self {
        Loaded { settings: Settings::default(), unreadable: Some(why) }
    }
}

/// The relay as iroh takes it. `validate` has already refused anything else,
/// so a value that does not parse here is treated as none.
pub(crate) fn relay_url(settings: &Settings) -> Option<RelayUrl> {
    settings.relay.as_deref().and_then(|r| r.parse().ok())
}

/// Whether the whole of a settings value may be written.
pub(crate) fn validate(settings: &Settings) -> Result<(), String> {
    let Some(relay) = &settings.relay else { return Ok(()) };
    let url: RelayUrl = relay.parse().map_err(|_| format!("{relay:?} is not a URL"))?;
    if url.scheme() != "https" {
        return Err(format!("the relay has to be an https URL, and {relay:?} is not"));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(format!("the relay {relay:?} names no host"));
    }
    Ok(())
}

impl Patch {
    fn applied_to(&self, mut settings: Settings) -> Settings {
        if let Some(v) = self.enabled {
            settings.enabled = v;
        }
        if let Some(v) = self.start_at_login {
            settings.start_at_login = v;
        }
        if let Some(v) = self.keep_awake {
            settings.keep_awake = v;
        }
        if let Some(relay) = &self.relay {
            // A blank box is the same intention as null: no relay of one's own.
            settings.relay = relay.as_ref().map(|r| r.trim().to_string()).filter(|r| !r.is_empty());
        }
        settings
    }
}

#[derive(Clone, Debug)]
pub(crate) struct SettingsFile {
    path: PathBuf,
}

impl SettingsFile {
    pub(crate) fn new(path: PathBuf) -> Self {
        SettingsFile { path }
    }

    pub(crate) fn in_dir(dir: &Path) -> Self {
        SettingsFile::new(dir.join(FILE))
    }

    fn unreadable(&self, why: impl std::fmt::Display) -> String {
        format!(
            "the remote access settings at {} could not be read, so remote access is off until it is fixed or deleted: {why}",
            self.path.display()
        )
    }

    /// The settings. Absent is the defaults; anything else that is not a valid
    /// settings object is off, with a sentence naming the file.
    pub(crate) fn load(&self) -> Loaded {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Loaded::default(),
            Err(e) => return Loaded::unreadable(self.unreadable(e)),
        };
        let settings: Settings = match serde_json::from_str(&text) {
            Ok(settings) => settings,
            Err(e) => return Loaded::unreadable(self.unreadable(e)),
        };
        match validate(&settings) {
            Ok(()) => Loaded { settings, unreadable: None },
            Err(why) => Loaded::unreadable(self.unreadable(why)),
        }
    }

    /// Apply a patch: load, merge, validate the whole, then write. **Refuses,
    /// writing nothing, when the file cannot be read or the result is invalid.**
    pub(crate) fn apply_patch(&self, patch: &Patch) -> Result<Settings, String> {
        let loaded = self.load();
        if let Some(why) = loaded.unreadable {
            return Err(why);
        }
        let next = patch.applied_to(loaded.settings);
        validate(&next)?;
        self.write(&next)?;
        Ok(next)
    }

    /// A temporary file, flushed, then renamed over the real one, as `store.rs`
    /// writes the paired list.
    fn write(&self, settings: &Settings) -> Result<(), String> {
        let refuse = |e: std::io::Error| {
            format!("the remote access settings at {} could not be written: {e}", self.path.display())
        };
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(refuse)?;
        }
        let text = serde_json::to_string_pretty(settings).map_err(|e| refuse(std::io::Error::other(e)))?;
        let tmp = self.path.with_extension("json.tmp");
        let mut file = fs::File::create(&tmp).map_err(refuse)?;
        file.write_all(text.as_bytes()).map_err(refuse)?;
        file.sync_all().map_err(refuse)?;
        drop(file);
        fs::rename(&tmp, &self.path).map_err(refuse)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::store::tests::Scratch;

    fn patch(json: &str) -> Patch {
        serde_json::from_str(json).expect("a patch")
    }

    #[test]
    fn a_missing_file_is_all_the_defaults() {
        let dir = Scratch::new("settings-missing");
        let loaded = SettingsFile::in_dir(&dir.0).load();
        assert_eq!(loaded, Loaded::default());
        assert!(!loaded.settings.enabled && !loaded.settings.start_at_login && !loaded.settings.keep_awake);
        assert_eq!(loaded.settings.relay, None);
    }

    #[test]
    fn a_file_that_cannot_be_used_is_off_with_a_reason_naming_it() {
        let dir = Scratch::new("settings-bad");
        let path = dir.0.join(FILE);
        let file = SettingsFile::in_dir(&dir.0);
        for garbage in [
            "not json",
            r#"{"enabled":true,"bogus":1}"#,
            r#"{"enabled":true,"relay":"http://relay.example.com"}"#,
            r#"{"enabled":true,"keepAwake":"yes"}"#,
            r#"{"enabled":true,"relay":"not a url"}"#,
        ] {
            fs::write(&path, garbage).unwrap();
            let loaded = file.load();
            assert!(!loaded.settings.enabled, "{garbage} must be off");
            assert_eq!(loaded.settings, Settings::default());
            let why = loaded.unreadable.expect("a reason");
            assert!(why.contains(&path.display().to_string()), "{why}");
        }
    }

    #[test]
    fn a_file_with_only_some_fields_takes_the_defaults_for_the_rest() {
        let dir = Scratch::new("settings-partial");
        fs::write(dir.0.join(FILE), r#"{"enabled":true}"#).unwrap();
        let loaded = SettingsFile::in_dir(&dir.0).load();
        assert_eq!(loaded.unreadable, None);
        assert_eq!(loaded.settings, Settings { enabled: true, ..Settings::default() });
    }

    #[test]
    fn a_refused_patch_leaves_the_file_byte_identical_or_absent() {
        let dir = Scratch::new("settings-refused");
        let path = dir.0.join(FILE);
        let file = SettingsFile::in_dir(&dir.0);

        for bad in [r#"{"relay":"ftp://relay.example.com"}"#, r#"{"relay":"http://relay.example.com"}"#] {
            assert!(file.apply_patch(&patch(bad)).is_err());
            assert!(!path.exists(), "an absent file stays absent");
        }

        let original = "{\n  \"enabled\": true\n}";
        fs::write(&path, original).unwrap();
        let why = file.apply_patch(&patch(r#"{"enabled":false,"relay":"ftp://x.example"}"#)).unwrap_err();
        assert!(why.contains("https"), "{why}");
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn a_patch_over_an_unreadable_file_is_refused_and_writes_nothing() {
        let dir = Scratch::new("settings-unreadable");
        let path = dir.0.join(FILE);
        fs::write(&path, "{ half a fi").unwrap();
        let why = SettingsFile::in_dir(&dir.0).apply_patch(&patch(r#"{"enabled":true}"#)).unwrap_err();
        assert!(why.contains(&path.display().to_string()), "{why}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ half a fi");
    }

    #[test]
    fn a_patch_round_trips_and_leaves_no_temporary_file() {
        let dir = Scratch::new("settings-roundtrip");
        let file = SettingsFile::in_dir(&dir.0.join("nested"));
        let written = file
            .apply_patch(&patch(r#"{"enabled":true,"keepAwake":true,"relay":"https://relay.example.com/"}"#))
            .unwrap();
        assert_eq!(file.load(), Loaded { settings: written.clone(), unreadable: None });
        assert!(!dir.0.join("nested").join("remote.json.tmp").exists());

        // Untouched fields are kept; null clears the relay; a blank one does too.
        let next = file.apply_patch(&patch(r#"{"startAtLogin":true,"relay":null}"#)).unwrap();
        assert_eq!(next, Settings { enabled: true, start_at_login: true, keep_awake: true, relay: None });
        file.apply_patch(&patch(r#"{"relay":"https://relay.example.com/"}"#)).unwrap();
        assert_eq!(file.apply_patch(&patch(r#"{"relay":"  "}"#)).unwrap().relay, None);

        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.0.join("nested").join(FILE)).unwrap()).unwrap();
        assert_eq!(raw, serde_json::json!({ "enabled": true, "startAtLogin": true, "keepAwake": true, "relay": null }));
    }

    #[test]
    fn a_patch_distinguishes_an_absent_relay_from_null() {
        assert_eq!(patch("{}").relay, None);
        assert_eq!(patch(r#"{"relay":null}"#).relay, Some(None));
        assert_eq!(patch(r#"{"relay":"https://r.example"}"#).relay, Some(Some("https://r.example".into())));
        assert!(serde_json::from_str::<Patch>(r#"{"secret":1}"#).is_err());
    }

    #[test]
    fn the_relay_must_be_https_with_a_host() {
        let with = |r: &str| Settings { relay: Some(r.into()), ..Settings::default() };
        assert!(validate(&with("https://relay.example.com")).is_ok());
        assert!(validate(&with("http://relay.example.com")).is_err());
        assert!(validate(&with("relay.example.com")).is_err());
        assert!(validate(&Settings::default()).is_ok());
        assert_eq!(relay_url(&with("https://relay.example.com")).map(|u| u.to_string()), Some("https://relay.example.com/".into()));
    }
}
