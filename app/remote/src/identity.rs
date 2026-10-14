//! When a device key is made, and when one is refused (#341, #345).
//!
//! The desktop and the phone each keep one ed25519 secret per install. Its
//! public half is the endpoint id, so **a new key is a new device** to
//! everything that has paired with it. That makes the two rules here the same
//! on both ends, and the reason they live in one place:
//!
//! - A key is made only when the store says, without error, that there is none.
//! - A store that cannot be read, or holds something that is not 32 bytes, is
//!   an error and is never written over. Replacing a key nobody could read
//!   would silently orphan every pairing it had.
//!
//! Where the bytes live is each app's: the desktop's OS keychain, the phone's
//! Keystore or Keychain. Each implements [`Vault`].

use iroh_base::SecretKey;

/// Where the raw 32 bytes are kept.
pub trait Vault {
    /// The stored bytes, `None` when nothing is stored, `Err` when the store
    /// could not say.
    fn get(&self) -> Result<Option<Vec<u8>>, String>;
    fn set(&self, bytes: &[u8; 32]) -> Result<(), String>;
    /// What the store is called in a sentence, e.g. `"the keychain"`.
    fn called(&self) -> &'static str;
}

/// The device key, or `None` if there is none yet. Never creates one.
pub fn read(vault: &dyn Vault) -> Result<Option<SecretKey>, String> {
    let store = vault.called();
    let bytes = vault.get().map_err(|e| format!("{store} refused to read the device key: {e}"))?;
    let Some(bytes) = bytes else { return Ok(None) };
    let bytes: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
        format!(
            "the device key in {store} is {} bytes, not 32, so it cannot be used and will not be replaced",
            bytes.len()
        )
    })?;
    Ok(Some(SecretKey::from_bytes(&bytes)))
}

/// The device key, made and stored the first time it is needed.
///
/// Only an entry that is **known absent** gets a new key. A read that failed
/// returns its sentence and nothing is written.
pub fn read_or_create(vault: &dyn Vault) -> Result<SecretKey, String> {
    if let Some(key) = read(vault)? {
        return Ok(key);
    }
    let key = SecretKey::generate();
    vault.set(&key.to_bytes())?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// An in-memory vault that counts writes, and can be made unreadable.
    #[derive(Default)]
    struct FakeVault {
        stored: RefCell<Option<Vec<u8>>>,
        unreadable: Option<String>,
        writes: Cell<usize>,
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
    fn an_unreadable_store_fails_closed_and_generates_nothing() {
        let vault = FakeVault {
            unreadable: Some("DBus error: Remote peer disconnected".into()),
            ..FakeVault::default()
        };
        let why = read_or_create(&vault).map(|_| ()).expect_err("refuses");
        assert!(why.contains("DBus error"), "{why}");
        assert!(why.contains("device key"), "{why}");
        assert!(why.starts_with("the keychain refused"), "names the store: {why}");
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
}
