//! The phone's own lock (#346): asking the person in front of it to confirm.
//!
//! Face ID, Touch ID or the device's fingerprint or PIN, through Tauri's
//! biometric plugin, driven from Rust: the window is granted no biometric
//! permission and calls `phone_confirm`, which comes here.
//!
//! **What this file decides is about the device, never about a run.** The
//! cockpit asks for a confirmation before the spec's four acts; the phone's
//! Rust does not read frames to find them.
//!
//! Whether the phone *has* a lock is read from the plugin's status, and only
//! one answer means it has none: the platform's explicit "no passcode set"
//! (`passcodeNotSet`, from both the iOS and the Android plugin). Biometrics
//! being unavailable is not that - a phone with a PIN and no fingerprint has a
//! lock - so everything else is `Unknown`, and the app lock is enforced for
//! `Unknown` as for `Set`: failing closed costs a prompt, failing open costs a
//! desktop.

use serde::Serialize;

/// The plugin's error code for a device with no passcode, PIN or pattern.
#[cfg_attr(not(mobile), allow(dead_code))]
pub const NO_PASSCODE: &str = "passcodeNotSet";

/// Whether this phone has a screen lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(not(mobile), allow(dead_code))]
pub enum DeviceLock {
    Set,
    None,
    Unknown,
}

/// The plugin's status, read into a lock state.
#[cfg_attr(not(mobile), allow(dead_code))]
pub fn device_lock_of(is_available: bool, error_code: Option<&str>) -> DeviceLock {
    if is_available {
        DeviceLock::Set
    } else if error_code == Some(NO_PASSCODE) {
        DeviceLock::None
    } else {
        DeviceLock::Unknown
    }
}

/// Whether the app opens locked: the setting is on and the device has, or
/// may have, a lock to open it with. A settings file that cannot be read is
/// locked - the lock is on by default and nothing said otherwise. The mock
/// desktop opens unlocked: it serves no real desktop, and the emulator launches
/// in CI cannot answer a biometric prompt.
pub fn starts_locked(lock_setting: bool, settings_unreadable: bool, device: DeviceLock, mock: bool) -> bool {
    if mock {
        return false;
    }
    if settings_unreadable {
        return true;
    }
    lock_setting && device != DeviceLock::None
}

/// Asking the person to confirm, and whether there is a lock to ask with.
pub trait Device: Send + Sync {
    /// Blocks until the person confirms or refuses. `Ok(false)` is a refusal
    /// or a cancel; `Err` is a prompt that could not be shown.
    fn confirm(&self, reason: &str) -> Result<bool, String>;
    fn lock_state(&self) -> DeviceLock;
}

/// A desktop run of the phone app, and the tests: nothing to ask with, so
/// every confirmation is given, and whether there is a lock is unknown.
#[cfg_attr(mobile, allow(dead_code))]
pub struct Host;

impl Device for Host {
    fn confirm(&self, _reason: &str) -> Result<bool, String> {
        Ok(true)
    }
    fn lock_state(&self) -> DeviceLock {
        DeviceLock::Unknown
    }
}

/// A phone, through the biometric plugin.
#[cfg(mobile)]
pub struct Mobile(pub tauri::AppHandle);

#[cfg(mobile)]
fn code_of(error: &tauri_plugin_biometric::Error) -> Option<String> {
    match error {
        tauri_plugin_biometric::Error::PluginInvoke(tauri::plugin::mobile::PluginInvokeError::InvokeRejected(r)) => r.code.clone(),
        _ => None,
    }
}

#[cfg(mobile)]
impl Device for Mobile {
    fn confirm(&self, reason: &str) -> Result<bool, String> {
        use tauri_plugin_biometric::{AuthOptions, BiometricExt};
        let options = AuthOptions { allow_device_credential: true, ..AuthOptions::default() };
        match self.0.biometric().authenticate(reason.to_string(), options) {
            Ok(()) => Ok(true),
            // No passcode: there is nothing to confirm with, and the person
            // has been told so (the no-screen-lock warning).
            Err(e) if code_of(&e).as_deref() == Some(NO_PASSCODE) => Ok(true),
            Err(e) => {
                log::info!("vibe-mobile: not confirmed: {e}");
                Ok(false)
            }
        }
    }

    fn lock_state(&self) -> DeviceLock {
        use tauri_plugin_biometric::BiometricExt;
        match self.0.biometric().status() {
            Ok(status) => device_lock_of(status.is_available, status.error_code.as_deref()),
            Err(e) => {
                log::warn!("vibe-mobile: the device's lock state could not be read: {e}");
                DeviceLock::Unknown
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_explicit_no_passcode_is_no_lock() {
        assert_eq!(device_lock_of(true, None), DeviceLock::Set);
        assert_eq!(device_lock_of(true, Some(NO_PASSCODE)), DeviceLock::Set);
        assert_eq!(device_lock_of(false, Some("passcodeNotSet")), DeviceLock::None);
        assert_eq!(device_lock_of(false, Some("biometryNotEnrolled")), DeviceLock::Unknown, "a PIN with no fingerprint is still a lock");
        assert_eq!(device_lock_of(false, Some("biometryNotAvailable")), DeviceLock::Unknown);
        assert_eq!(device_lock_of(false, None), DeviceLock::Unknown);
    }

    #[test]
    fn the_app_opens_locked_unless_there_is_nothing_to_unlock_with() {
        assert!(starts_locked(true, false, DeviceLock::Set, false));
        assert!(starts_locked(true, false, DeviceLock::Unknown, false));
        assert!(!starts_locked(true, false, DeviceLock::None, false), "no device lock: the warning, not a cover");
        assert!(!starts_locked(false, false, DeviceLock::Set, false), "the person turned it off");
        assert!(starts_locked(false, true, DeviceLock::None, false), "unreadable settings fail closed");
        assert!(!starts_locked(true, false, DeviceLock::Set, true), "the mock desktop opens unlocked");
    }

    #[test]
    fn a_desktop_run_confirms_without_asking() {
        assert_eq!(Host.confirm("delete a run"), Ok(true));
        assert_eq!(Host.lock_state(), DeviceLock::Unknown);
    }
}
