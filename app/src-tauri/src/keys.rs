//! Where the pilot's credentials live, and what may ever see them (#143).
//!
//! The core has never made a network call - *"there is no server, no daemon and
//! no network code of its own; every external call is a child process"* - and
//! that sentence is worth more than it looks. It is why the tool inherits
//! whatever you are already logged into, why there is no key to leak, and why a
//! package with zero runtime dependencies has nothing for `npm audit` to say.
//!
//! The pilot needs a credential. **So the boundary is the point**, and this file
//! is where it is drawn.
//!
//! ## Not `vibe.config.json`, and not a preference
//!
//! - It is a **project file**, committed in this repo and meant to be committed
//!   in others; `vibe.config.example.json` exists to be copied. A key in it is a
//!   key in git.
//! - `validateConfig` refuses bad values **by name and reports them**. A secret
//!   is the one field that must never appear in an error message.
//!
//! So: the OS keychain - Windows Credential Manager, macOS Keychain, the
//! Secret Service on Linux - reached through the Rust side that had to exist for
//! the window anyway.
//!
//! ## The webview never sees a key
//!
//! There is deliberately **no command that returns one**. It can store a key,
//! ask whether one is present, and delete it; it cannot read it back. The
//! network call is made from Rust with a key that never crosses the IPC
//! boundary, so a compromised page has nothing to steal and no request to make.
//!
//! The CSP already says the same thing from the other side: `connect-src 'self'
//! ipc: http://ipc.localhost` means the webview cannot reach `api.anthropic.com`
//! even if it held the key. The two agree, which is how it should be.

use keyring::Entry;
use serde::{Deserialize, Serialize};

/// The service name the keychain files these under.
///
/// Matches the bundle identifier, so an entry is attributable to this app in a
/// credential manager somebody is scrolling through.
const SERVICE: &str = "dev.vibecode.desktop";

/// The two providers the pilot speaks to.
///
/// A closed enum rather than a string, and the reason is the one that keeps
/// coming up: an unrecognised provider must be refused rather than turned into
/// a keychain entry nobody can find again. Serde rejects anything else at the
/// IPC boundary, before it reaches a keychain call.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Anthropic,
    Openai,
}

impl Provider {
    /// The account name inside the service. Stable - changing one orphans a key.
    fn account(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic-api-key",
            Provider::Openai => "openai-api-key",
        }
    }

    pub const ALL: [Provider; 2] = [Provider::Anthropic, Provider::Openai];
}

fn entry(provider: Provider) -> Result<Entry, String> {
    Entry::new(SERVICE, provider.account())
        .map_err(|e| format!("the keychain refused to open an entry: {e}"))
}

/// Whether a provider has a key, and nothing else about it.
///
/// **`present` is a boolean and there is no field carrying the key.** Not even a
/// masked one: a `sk-ant-…3f9a` in a log or a screenshot is four more characters
/// of a secret than anybody needed, and the only thing the UI has to decide is
/// whether to offer the provider.
#[derive(Clone, Serialize)]
pub struct KeyStatus {
    pub provider: Provider,
    pub present: bool,
    /// Why presence could not be established. Null when it could.
    ///
    /// Distinct from `present: false`, and the distinction matters: a locked
    /// keychain is not the same fact as a user who has not entered a key, and
    /// telling them to enter one they already gave is how they end up entering
    /// it twice.
    pub unreadable: Option<String>,
}

/// Store a key. Trimmed, and refused if empty.
///
/// The trim is not cosmetic: a key pasted out of a terminal or an email arrives
/// with a trailing newline more often than not, and a header value with `\n` in
/// it is rejected by the HTTP layer with an error that says nothing about
/// whitespace.
pub fn set(provider: Provider, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("that key is empty".into());
    }
    entry(provider)?
        .set_password(key)
        // The error is deliberately not interpolated with anything derived from
        // the key. `keyring` reports the platform's own message, which describes
        // the store rather than the secret.
        .map_err(|e| format!("the keychain refused to store it: {e}"))
}

/// Forget a key. Deleting one that is not there is success, not an error.
pub fn clear(provider: Provider) -> Result<(), String> {
    match entry(provider)?.delete_credential() {
        Ok(()) => Ok(()),
        // Already gone is the outcome the caller asked for.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("the keychain refused to delete it: {e}")),
    }
}

/// Read a key, for the one caller that may: the code making the request.
///
/// **Not a command, and it must never become one.** `pub(crate)` is the whole
/// point - the pilot's HTTP adapters call this, and nothing reachable from the
/// webview can.
///
/// Its one caller is `pilot::drive`, which reads a key at the last possible
/// moment, hands it straight to a request header, and drops it. The key is
/// never emitted, never logged, never returned to the window and never written
/// down anywhere else in this crate.
pub(crate) fn read(provider: Provider) -> Result<String, String> {
    match entry(provider)?.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => Err(format!(
            "no {} key is stored",
            match provider {
                Provider::Anthropic => "Anthropic",
                Provider::Openai => "OpenAI",
            }
        )),
        Err(e) => Err(format!("the keychain refused to read it: {e}")),
    }
}

/// What the app knows about both providers.
pub fn status() -> Vec<KeyStatus> {
    Provider::ALL
        .into_iter()
        .map(|provider| match entry(provider).and_then(|e| {
            match e.get_password() {
                Ok(_) => Ok(true),
                Err(keyring::Error::NoEntry) => Ok(false),
                Err(err) => Err(format!("{err}")),
            }
        }) {
            Ok(present) => KeyStatus {
                provider,
                present,
                unreadable: None,
            },
            // Fail closed toward "we cannot tell", never toward "there is none".
            // Reporting absent for a locked keychain would have the user enter a
            // key they already gave, and overwrite the one that was fine.
            Err(why) => KeyStatus {
                provider,
                present: false,
                unreadable: Some(why),
            },
        })
        .collect()
}

#[tauri::command]
pub fn key_set(provider: Provider, key: String) -> Result<(), String> {
    set(provider, &key)
}

#[tauri::command]
pub fn key_clear(provider: Provider) -> Result<(), String> {
    clear(provider)
}

#[tauri::command]
pub fn key_status() -> Vec<KeyStatus> {
    status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_provider_names_a_stable_account() {
        // Pinned because changing one of these orphans a key somebody already
        // entered - it stays in their keychain and the app reports none.
        assert_eq!(Provider::Anthropic.account(), "anthropic-api-key");
        assert_eq!(Provider::Openai.account(), "openai-api-key");
    }

    #[test]
    fn an_empty_key_is_refused_before_it_reaches_the_keychain() {
        // Whitespace included: a key pasted out of a terminal arrives with a
        // newline more often than not, and storing "\n" would report success and
        // then fail every request with an error about headers.
        for empty in ["", "   ", "\n", "\t\n "] {
            assert!(set(Provider::Anthropic, empty).is_err());
        }
    }

    #[test]
    fn the_status_shape_never_carries_a_key() {
        // The guard that matters, and the one a future field would quietly
        // break. Serialising a status must produce exactly three keys.
        let status = KeyStatus {
            provider: Provider::Openai,
            present: true,
            unreadable: None,
        };
        let json = serde_json::to_value(&status).expect("serialises");
        let object = json.as_object().expect("an object");
        let mut names: Vec<&String> = object.keys().collect();
        names.sort();
        assert_eq!(names, ["present", "provider", "unreadable"]);
    }

    #[test]
    fn a_missing_key_is_refused_by_name() {
        // `read` has no caller until the adapters land, and this is what keeps
        // it from being dead code in the meantime - the error it produces is
        // what the pilot pane will show, and "no key is stored" without saying
        // WHICH is useless to somebody who configured one of two providers.
        //
        // Deliberately tolerant of a key being present: this machine's keychain
        // is real, and a test that started failing the day somebody entered a
        // key would be the wall-clock fixture in another costume.
        for provider in Provider::ALL {
            if let Err(why) = read(provider) {
                let name = match provider {
                    Provider::Anthropic => "Anthropic",
                    Provider::Openai => "OpenAI",
                };
                assert!(why.contains(name), "{why:?} should name {name}");
                // And it must never quote what it failed to read.
                assert!(!why.contains("sk-"), "an error must not carry a key");
            }
        }
    }

    /// The issue's actual acceptance: *"a key entered in the app is readable on
    /// the next launch."*
    ///
    /// **`#[ignore]` on purpose.** It writes to the real OS keychain, which is
    /// the user's, and a gate that mutates a credential store every time
    /// somebody runs `npm run app:test` is not a gate anybody should trust. Run
    /// it deliberately:
    ///
    /// ```text
    /// cargo test --manifest-path src-tauri/Cargo.toml -- --ignored
    /// ```
    ///
    /// It restores whatever was there before, including restoring *nothing* if
    /// there was nothing - so running it on a machine with a real key configured
    /// leaves that key exactly as it found it.
    #[test]
    #[ignore = "writes to the real OS keychain; run with --ignored"]
    fn a_stored_key_survives_and_comes_back_byte_for_byte() {
        let provider = Provider::Anthropic;
        let existing = read(provider).ok();

        let secret = "sk-ant-test-\u{00e9}\u{4e2d}-0123456789";
        set(provider, secret).expect("stores");
        assert_eq!(read(provider).as_deref(), Ok(secret), "byte for byte, unicode included");

        // Presence is visible without the key being exposed.
        let seen = status().into_iter().find(|s| s.provider == provider).expect("a status");
        assert!(seen.present);
        assert!(seen.unreadable.is_none());

        clear(provider).expect("clears");
        assert!(read(provider).is_err(), "a cleared key is gone");
        // Clearing again is success, not an error: the caller asked for absence
        // and absence is what there is.
        clear(provider).expect("clearing twice is not an error");

        // Put back exactly what was there, or leave it absent.
        if let Some(previous) = existing {
            set(provider, &previous).expect("restores");
        }
    }

    #[test]
    fn a_provider_is_a_closed_set_at_the_ipc_boundary() {
        // An unrecognised provider is refused by serde before it can become a
        // keychain entry under a name nothing will ever look for again.
        assert!(serde_json::from_str::<Provider>("\"anthropic\"").is_ok());
        assert!(serde_json::from_str::<Provider>("\"openai\"").is_ok());
        assert!(serde_json::from_str::<Provider>("\"gemini\"").is_err());
        assert!(serde_json::from_str::<Provider>("\"Anthropic\"").is_err());
    }
}
