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

use keyring::Entry;

/// The account inside the service. Stable - changing it orphans the key.
pub(crate) const ACCOUNT: &str = "remote-identity";

/// When a key is made and when a store is refused is the phone's rule too, so
/// it is the shared crate's (#345). This file is the keychain it is kept in.
pub(crate) use vibe_remote::identity::{read, read_or_create, Vault};

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
