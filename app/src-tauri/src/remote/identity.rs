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

/// Where the raw 32 bytes are kept. A trait so the tests never touch the real
/// keychain, which is the user's.
pub(crate) trait Vault {
    /// The stored bytes, `None` when nothing is stored, `Err` when the store
    /// could not say.
    fn get(&self) -> Result<Option<Vec<u8>>, String>;
    fn set(&self, bytes: &[u8; 32]) -> Result<(), String>;
}

/// The OS keychain.
pub(crate) struct Keychain;

impl Keychain {
    fn entry() -> Result<Entry, String> {
        Entry::new(crate::keys::SERVICE, ACCOUNT)
            .map_err(|e| format!("the keychain refused to open the device key's entry: {e}"))
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
}

/// The device key, or `None` if there is none yet. Never creates one.
pub(crate) fn read(vault: &dyn Vault) -> Result<Option<SecretKey>, String> {
    let bytes = vault
        .get()
        .map_err(|e| format!("the keychain refused to read the device key: {e}"))?;
    let Some(bytes) = bytes else { return Ok(None) };
    let bytes: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
        format!(
            "the device key in the keychain is {} bytes, not 32, so it cannot be used and will not be replaced",
            bytes.len()
        )
    })?;
    Ok(Some(SecretKey::from_bytes(&bytes)))
}

/// The device key, made and stored the first time it is needed.
///
/// Only an entry that is **known absent** gets a new key. A read that failed
/// returns its sentence and nothing is written.
pub(crate) fn read_or_create(vault: &dyn Vault) -> Result<SecretKey, String> {
    if let Some(key) = read(vault)? {
        return Ok(key);
    }
    let key = SecretKey::generate();
    vault.set(&key.to_bytes())?;
    Ok(key)
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
    }

    #[test]
    fn the_account_is_stable() {
        assert_eq!(ACCOUNT, "remote-identity");
    }

    #[test]
    fn a_key_is_generated_once_stored_and_read_back() {
        let vault = FakeVault::default();
        let made = read_or_create(&vault).expect("generates");
        assert_eq!(vault.writes.get(), 1);
        let again = read(&vault).expect("reads").expect("present");
        assert_eq!(again.public(), made.public());
    }

    #[test]
    fn a_reload_makes_no_new_key() {
        let vault = FakeVault::default();
        let first = read_or_create(&vault).expect("generates");
        let second = read_or_create(&vault).expect("reloads");
        assert_eq!(vault.writes.get(), 1);
        assert_eq!(first.public(), second.public());
    }

    #[test]
    fn an_unreadable_keychain_fails_closed_and_generates_nothing() {
        let vault = FakeVault {
            unreadable: Some("DBus error: Remote peer disconnected".into()),
            ..FakeVault::default()
        };
        let why = read_or_create(&vault).map(|_| ()).expect_err("refuses");
        assert!(why.contains("DBus error"), "{why}");
        assert!(why.contains("device key"), "{why}");
        assert_eq!(vault.writes.get(), 0);
    }

    #[test]
    fn a_stored_value_of_the_wrong_length_is_never_replaced() {
        let vault = FakeVault { stored: RefCell::new(Some(vec![1, 2, 3])), ..FakeVault::default() };
        let why = read_or_create(&vault).map(|_| ()).expect_err("refuses");
        assert!(why.contains("3 bytes"), "{why}");
        assert_eq!(vault.writes.get(), 0);
        assert_eq!(*vault.stored.borrow(), Some(vec![1, 2, 3]));
    }

    #[test]
    fn reading_an_empty_vault_creates_nothing() {
        let vault = FakeVault::default();
        assert!(read(&vault).expect("reads").is_none());
        assert_eq!(vault.writes.get(), 0);
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
