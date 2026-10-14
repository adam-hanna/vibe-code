//! The phone's device key: one ed25519 secret per install (#345).
//!
//! Its public half is the endpoint id a desktop puts on its paired list, so a
//! new key is a new phone to every desktop. The rules for when one is made and
//! when a store is refused are the desktop's too, and live in the shared crate
//! (`vibe_remote::identity`); this file is where the bytes go.
//!
//! - **Android**: an AES key generated inside the Android Keystore, which never
//!   hands it out, encrypts the device key; the ciphertext is kept in the app's
//!   private SharedPreferences (`android-native-keyring-store`).
//! - **iOS**: a Keychain item in the data-protection store, accessible after the
//!   first unlock and **on this device only**, so it is in no backup and on no
//!   other device. The design said to wrap it as on Android; the Keychain holds
//!   arbitrary bytes under the same protection, so wrapping would add a second
//!   key with nothing more to guard.
//! - **A desktop run of the phone app** (`main.rs`, for development): keyring's
//!   in-memory store. A new key every launch, and nothing written to the
//!   developer's keychain.
//!
//! **No command reads it.** `phone_identity` answers with the endpoint id and
//! nothing else, for `keys.rs`'s reason on the desktop: the window must have
//! nothing to steal.

use std::sync::Arc;

use keyring_core::{Entry, Error};
use vibe_remote::identity::Vault;

/// The service and account the key is filed under. Stable: changing either
/// orphans the key, and with it every pairing.
pub const SERVICE: &str = "dev.vibecode.mobile";
pub const ACCOUNT: &str = "remote-identity";

/// Make this platform's store the one `Entry::new` uses. Called once, at start.
pub fn install_store() -> Result<(), String> {
    let store: Arc<keyring_core::CredentialStore> = platform_store()?;
    keyring_core::set_default_store(store);
    Ok(())
}

#[cfg(target_os = "android")]
fn platform_store() -> Result<Arc<keyring_core::CredentialStore>, String> {
    android_native_keyring_store::Store::new()
        .map(|s| s as Arc<keyring_core::CredentialStore>)
        .map_err(|e| format!("the Android Keystore could not be opened: {e}"))
}

#[cfg(target_os = "ios")]
fn platform_store() -> Result<Arc<keyring_core::CredentialStore>, String> {
    apple_native_keyring_store::protected::Store::new()
        .map(|s| s as Arc<keyring_core::CredentialStore>)
        .map_err(|e| format!("the iOS Keychain could not be opened: {e}"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn platform_store() -> Result<Arc<keyring_core::CredentialStore>, String> {
    keyring_core::mock::Store::new()
        .map(|s| s as Arc<keyring_core::CredentialStore>)
        .map_err(|e| format!("the in-memory key store could not be made: {e}"))
}

/// The modifiers an entry is made with. Only iOS takes any.
fn entry() -> Result<Entry, String> {
    #[cfg(target_os = "ios")]
    let made = Entry::new_with_modifiers(
        SERVICE,
        ACCOUNT,
        &std::collections::HashMap::from([("access-policy", "AfterFirstUnlockThisDeviceOnly")]),
    );
    #[cfg(not(target_os = "ios"))]
    let made = Entry::new(SERVICE, ACCOUNT);
    made.map_err(|e| format!("{} refused to open the device key's entry: {e}", Store.called()))
}

/// This phone's key store, through keyring.
pub struct Store;

impl Vault for Store {
    fn get(&self) -> Result<Option<Vec<u8>>, String> {
        match entry()?.get_secret() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("{e}")),
        }
    }

    fn set(&self, bytes: &[u8; 32]) -> Result<(), String> {
        entry()?
            .set_secret(bytes)
            .map_err(|e| format!("{} refused to store the device key: {e}", self.called()))
    }

    fn called(&self) -> &'static str {
        if cfg!(target_os = "android") {
            "the Android Keystore"
        } else if cfg!(target_os = "ios") {
            "the iOS Keychain"
        } else {
            "the in-memory key store"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_names_it_is_filed_under_are_stable() {
        assert_eq!(SERVICE, "dev.vibecode.mobile");
        assert_eq!(ACCOUNT, "remote-identity");
    }

    /// The whole path the phone takes at start, against the store a desktop
    /// run uses: made once, then the same key read back.
    #[test]
    fn a_key_is_made_once_and_the_same_one_comes_back() {
        install_store().expect("the in-memory store");
        let made = vibe_remote::identity::read_or_create(&Store).expect("made");
        let again = vibe_remote::identity::read_or_create(&Store).expect("read back");
        assert_eq!(made.public(), again.public());
    }
}
