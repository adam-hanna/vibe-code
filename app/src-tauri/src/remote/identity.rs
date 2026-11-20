//! The desktop's device key: one ed25519 secret per install, in the keychain (#341).
//!
//! Its public half is the endpoint id, the address a phone dials, so **a new
//! key is a new desktop** as far as every paired phone can tell. That is why a
//! keychain that cannot be read fails closed: generating a replacement over an
//! entry nobody could read would silently orphan every phone on the list.
//!
//! It is the third entry under `keys::SERVICE`, beside the two vendor keys, and
//! like them it never crosses the IPC boundary. No command reads it, deletes it
//! or names it; `read` is `pub(crate)` for the same reason `keys::read` is.

use iroh_base::SecretKey;
use keyring::Entry;

/// The account inside the service. Stable - changing it orphans the key.
pub(crate) const ACCOUNT: &str = "remote-identity";

/// When a key is made and when a store is refused is the phone's rule too, so
/// it is the shared crate's (#345). This file is the keychain it is kept in.
pub(crate) use vibe_remote::identity::{read, read_or_create, Vault};

/// What could make a device key that could not be read readable again (#477).
/// Only `Transient` passes by itself, so it is the only kind tried again
/// without the person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Unread {
    /// The keychain's service failed: no session bus, a daemon that died
    /// before or during `OpenSession`, a D-Bus call that errored.
    Transient,
    /// The keychain is locked, or its unlock prompt was dismissed.
    Locked,
    /// Something is stored, and it is not 32 bytes. It can never become a key.
    Malformed,
    /// Anything else the keychain said.
    Other,
}

/// A device key that could not be read: the sentence `read` builds, which
/// names the keychain's error and never the bytes, and what could fix it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Unreadable {
    pub(crate) why: String,
    pub(crate) kind: Unread,
}

/// Which keychain errors pass by themselves (#477).
///
/// Measured from the source of the versions this app builds with: keyring
/// 3.6.3 with `sync-secret-service`, which talks to the Secret Service through
/// `dbus-secret-service` 4.1.0 (libdbus), not the `secret-service` crate.
///
/// - keyring's `decode_error` maps `Locked`, `NoResult` and `Prompt` to
///   `NoStorageAccess`, and everything else - `Dbus(dbus::Error)` included -
///   to `PlatformFailure`.
/// - A failed `SecretService::connect` is mapped with `platform_failure`
///   directly. A session bus that refuses, or a daemon that dies before or
///   during `OpenSession`, is a `dbus::Error`, so it is `PlatformFailure`.
///   That is what happened on 2026-10-26, when gnome-keyring crashed in
///   `open_session` as the desktop started, and it is retried.
/// - **`NoStorageAccess` is never retried.** On a locked item keyring calls
///   `item.unlock()`, which puts the desktop's unlock prompt on screen; a
///   retry every minute would put it there every minute. Not retrying caps it
///   at the one prompt the person already saw.
/// - **One case is knowingly misfiled.** `dbus-secret-service`'s prompt loop
///   starts from `Err(Error::Prompt)`, and a connection error or a closed
///   result channel while the prompt is open returns that default. So a daemon
///   that dies *while its prompt is on screen* reads as `NoStorageAccess`.
///   keyring boxes the inner error, and a dismissal and that death are both
///   `Prompt`, so they cannot be told apart. It happens only after the person
///   has been shown a prompt, and the instruction they are given - unlock,
///   then turn remote access off and on - is right for both.
/// - keyring connects with no prompt timeout, so an unanswered prompt holds a
///   read for up to its `ONE_YEAR_SECONDS`. That is why a retry reads on a
///   blocking thread, outside the transition lock, one read at a time.
fn kind_of(e: &keyring::Error) -> Unread {
    match e {
        keyring::Error::PlatformFailure(_) => Unread::Transient,
        keyring::Error::NoStorageAccess(_) => Unread::Locked,
        _ => Unread::Other,
    }
}

/// An answer the keychain has already given, handed to the shared `read` so
/// the 32-byte rule and its sentences stay in one place (#345). It never
/// writes: nothing that reads through it may make a key.
struct Answered(Result<Option<Vec<u8>>, String>);

impl Vault for Answered {
    fn get(&self) -> Result<Option<Vec<u8>>, String> {
        self.0.clone()
    }
    fn set(&self, _bytes: &[u8; 32]) -> Result<(), String> {
        Err("a device key that has been read is never written back".into())
    }
    fn called(&self) -> &'static str {
        "the keychain"
    }
}

/// The device key from what the keychain answered, with what could fix it
/// when there is none to use. `NoEntry` is no key, as `Keychain::get` says.
pub(crate) fn read_classified(got: keyring::Result<Vec<u8>>) -> Result<Option<SecretKey>, Unreadable> {
    let (answer, kind) = match got {
        // Bytes the shared rule refuses can only be the wrong length.
        Ok(bytes) => (Ok(Some(bytes)), Unread::Malformed),
        Err(keyring::Error::NoEntry) => (Ok(None), Unread::Other),
        Err(e) => {
            let kind = kind_of(&e);
            (Err(format!("{e}")), kind)
        }
    };
    read(&Answered(answer)).map_err(|why| Unreadable { why, kind })
}

/// The OS keychain.
pub(crate) struct Keychain;

impl Keychain {
    fn entry() -> Result<Entry, String> {
        Entry::new(crate::keys::SERVICE, ACCOUNT)
            .map_err(|e| format!("the keychain refused to open the device key's entry: {e}"))
    }

    /// The device key for starting the endpoint, with what could fix a read
    /// that failed (#477). Status and pairing read through `Vault`, which
    /// needs no more than the sentence.
    pub(crate) fn read_key() -> Result<Option<SecretKey>, Unreadable> {
        read_classified(Entry::new(crate::keys::SERVICE, ACCOUNT).and_then(|e| e.get_secret()))
    }
}

impl Vault for Keychain {
    fn get(&self) -> Result<Option<Vec<u8>>, String> {
        match Self::entry()?.get_secret() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("{e}")),
        }
    }

    fn set(&self, bytes: &[u8; 32]) -> Result<(), String> {
        Self::entry()?
            .set_secret(bytes)
            .map_err(|e| format!("the keychain refused to store the device key: {e}"))
    }

    fn called(&self) -> &'static str {
        "the keychain"
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// An in-memory vault that counts writes, and can be made unreadable.
    #[derive(Default)]
    pub(crate) struct FakeVault {
        pub(crate) stored: RefCell<Option<Vec<u8>>>,
        pub(crate) unreadable: Option<String>,
        pub(crate) writes: Cell<usize>,
    }

    impl Vault for FakeVault {
        fn get(&self) -> Result<Option<Vec<u8>>, String> {
            match &self.unreadable {
                Some(why) => Err(why.clone()),
                None => Ok(self.stored.borrow().clone()),
            }
        }
        fn set(&self, bytes: &[u8; 32]) -> Result<(), String> {
            self.writes.set(self.writes.get() + 1);
            *self.stored.borrow_mut() = Some(bytes.to_vec());
            Ok(())
        }
        fn called(&self) -> &'static str {
            "the keychain"
        }
    }

    #[test]
    fn the_account_is_stable() {
        assert_eq!(ACCOUNT, "remote-identity");
    }

    // The rules themselves - made once, never replaced, fail closed - are
    // tested beside them in `app/remote/src/identity.rs` (#345).

    /// #477: which keychain errors are retried, pinned to what keyring 3.6.3
    /// and dbus-secret-service 4.1.0 were read to do (see `kind_of`). The
    /// errors are built here; the real keychain is never touched.
    #[test]
    fn the_keyring_errors_are_classified_as_measured() {
        let boxed = |s: &str| -> Box<dyn std::error::Error + Send + Sync> { Box::new(std::io::Error::other(s.to_string())) };

        // A D-Bus connection error is a PlatformFailure, which passes by itself,
        // and its sentence is the one #476 logs.
        let dead = read_classified(Err(keyring::Error::PlatformFailure(boxed("D-Bus error: Remote peer disconnected"))));
        assert_eq!(
            dead.map(|_| ()).unwrap_err(),
            Unreadable {
                why: "the keychain refused to read the device key: \
                      Platform secure storage failure: D-Bus error: Remote peer disconnected"
                    .into(),
                kind: Unread::Transient,
            }
        );

        // Locked, or a dismissed prompt: the person has to act.
        let locked = read_classified(Err(keyring::Error::NoStorageAccess(boxed("Prompt")))).unwrap_err();
        assert_eq!(locked.kind, Unread::Locked);
        assert!(locked.why.starts_with("the keychain refused to read the device key: "), "{locked:?}");

        // No entry is no key.
        assert!(read_classified(Err(keyring::Error::NoEntry)).expect("no entry is not an error").is_none());

        // The wrong length is refused by the shared rule, and never named by its bytes.
        let odd = read_classified(Ok(vec![0xab; 31])).unwrap_err();
        assert_eq!(odd.kind, Unread::Malformed);
        assert!(odd.why.contains("31 bytes, not 32"), "{odd:?}");
        assert!(!odd.why.to_lowercase().contains("abab"), "{odd:?}");

        // 32 bytes is a key.
        let bytes = [7u8; 32];
        assert_eq!(read_classified(Ok(bytes.to_vec())).unwrap().unwrap().to_bytes(), bytes);

        // Anything else is not retried.
        let other = read_classified(Err(keyring::Error::Invalid("service".into(), "empty".into()))).unwrap_err();
        assert_eq!(other.kind, Unread::Other);
    }

    /// The issue's *"survives a restart and a reboot"*, against the real store.
    ///
    /// **`#[ignore]` on purpose**, for `keys.rs`'s reason: it writes to the
    /// user's own keychain. Run it deliberately, and again after a reboot:
    ///
    /// ```text
    /// cargo test --manifest-path src-tauri/Cargo.toml -- --ignored the_device_key_survives
    /// ```
    ///
    /// It puts back whatever was there - including nothing - so a machine with
    /// a real device key keeps its endpoint id.
    #[test]
    #[ignore = "writes to the real OS keychain; run with --ignored"]
    fn the_device_key_survives_and_comes_back_byte_for_byte() {
        let entry = Keychain::entry().expect("opens");
        let previous = match entry.get_secret() {
            Ok(bytes) => Some(bytes),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => panic!("the keychain could not be read, so nothing was touched: {e}"),
        };

        let bytes: [u8; 32] = std::array::from_fn(|i| (i as u8).wrapping_mul(37) ^ 0xa5);
        Keychain.set(&bytes).expect("stores");
        assert_eq!(Keychain.get(), Ok(Some(bytes.to_vec())), "byte for byte");
        let key = read(&Keychain).expect("reads").expect("present");
        assert_eq!(key.to_bytes(), bytes);

        match previous {
            Some(old) => entry.set_secret(&old).expect("restores"),
            None => entry.delete_credential().expect("leaves it absent"),
        }
    }
}
