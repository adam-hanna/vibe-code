//! The vibe phone app's Rust side (#345, #346).
//!
//! **A client only.** No Node host, no agent CLI and nothing that runs a turn:
//! everything the cockpit does is a command on a paired desktop, carried there
//! by [`desktop::Desktop`]. What lives here is what belongs to the device in
//! somebody's hand: its key, its list of desktops, its lock, and opening a page
//! in its browser.
//!
//! Eighteen commands, and the window's capabilities grant nothing else but the
//! camera (`capabilities/scan.json`):
//!
//! - `remote_call`: one desktop command, carried to the desktop.
//! - `phone_identity`: this phone's endpoint id, the public half of its key.
//! - `phone_open_release_page`: the release page in the phone's browser, when
//!   the desktop answers an update with `openOnPhone`.
//! - The desktops (#346): `phone_desktops`, `phone_probe`, `phone_open`,
//!   `phone_session`, `phone_release`, `phone_pair`, `phone_pair_cancel`,
//!   `phone_unpair`, `phone_rename` and `phone_network_change`.
//! - The device (#346): `phone_settings`, `phone_settings_set`,
//!   `phone_confirm`, `phone_unlock` and `phone_notify`.
//!
//! **No command returns the phone's key, or a desktop's pairing code's hidden
//! half after pairing.** The key stays in `identity.rs` and `link.rs`.
//!
//! **The app opens locked** when its lock is on and the device has, or may
//! have, a screen lock, and every command that reads or reaches a desktop is
//! refused until `phone_unlock` succeeds. The lock is checked here, in Rust,
//! so no webview path can get round it.

mod desktop;
mod device;
mod identity;
mod link;
#[cfg(feature = "mock-desktop")]
mod mock;
mod pairing;
mod settings;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
#[cfg(mobile)]
use tauri::Emitter;
use tauri::plugin::PermissionState;
use tauri::{Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use desktop::Desktop;
use device::{Device, DeviceLock};
use settings::{Loaded, Patch, PhoneSettings, SettingsFile};

/// The background time after which the app asks again: the product spec's
/// five minutes.
#[cfg_attr(not(mobile), allow(dead_code))]
const LOCK_AFTER: Duration = Duration::from_secs(5 * 60);

/// What every guarded command says while the app is locked.
const LOCKED: &str = "The app is locked.";

/// What the phone holds for the life of the app.
pub struct Phone {
    desktop: Box<dyn Desktop>,
    /// The endpoint id, or why there is none. Decided once, at start: a key
    /// store that could not be read stays a sentence until the app restarts,
    /// rather than being retried into a new key.
    identity: Result<String, String>,
    device: Arc<dyn Device>,
    settings: Result<Arc<SettingsFile>, String>,
    locked: AtomicBool,
    /// When the app went to the background, for the five-minute re-lock.
    #[cfg_attr(not(mobile), allow(dead_code))]
    away_since: Mutex<Option<Instant>>,
}

/// `phone_identity`'s answer. The public id and nothing else.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityReport {
    endpoint_id: String,
}

/// `phone_settings`'s answer: the settings, the device's lock read now, and
/// whether the app is locked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsReport {
    #[serde(flatten)]
    settings: PhoneSettings,
    device_lock: DeviceLock,
    locked: bool,
    problem: Option<String>,
}

impl Phone {
    fn unlocked(&self) -> Result<(), String> {
        if self.locked.load(Ordering::SeqCst) {
            Err(LOCKED.to_string())
        } else {
            Ok(())
        }
    }

    fn loaded(&self) -> Loaded {
        match &self.settings {
            Ok(file) => file.load(),
            Err(why) => Loaded { settings: PhoneSettings::default(), problem: Some(why.clone()) },
        }
    }

    async fn device_lock(&self) -> DeviceLock {
        let device = self.device.clone();
        tauri::async_runtime::spawn_blocking(move || device.lock_state()).await.unwrap_or(DeviceLock::Unknown)
    }

    async fn report(&self) -> SettingsReport {
        let loaded = self.loaded();
        SettingsReport {
            settings: loaded.settings,
            device_lock: self.device_lock().await,
            locked: self.locked.load(Ordering::SeqCst),
            problem: loaded.problem,
        }
    }

    async fn confirm(&self, reason: String) -> Result<bool, String> {
        let device = self.device.clone();
        tauri::async_runtime::spawn_blocking(move || device.confirm(&reason)).await.map_err(|e| e.to_string())?
    }

    /// Ask, and unlock on a yes. Answers whether the app is still locked.
    async fn unlock(&self) -> Result<bool, String> {
        if self.confirm("Unlock Vibe".into()).await? {
            self.locked.store(false, Ordering::SeqCst);
        }
        Ok(self.locked.load(Ordering::SeqCst))
    }

    async fn remote_call(&self, command: &str, args: Value) -> Result<Value, String> {
        self.unlocked()?;
        self.desktop.call(command, args).await
    }

    #[cfg_attr(not(mobile), allow(dead_code))]
    fn suspended(&self) {
        *self.away_since.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    }

    /// Back in the foreground: lock again if it was away long enough and
    /// there is something to unlock with. Answers whether it locked.
    #[cfg_attr(not(mobile), allow(dead_code))]
    async fn resumed(&self) -> bool {
        let away = self.away_since.lock().unwrap_or_else(|p| p.into_inner()).take();
        let long = away.is_some_and(|since| since.elapsed() >= LOCK_AFTER);
        if !long || cfg!(feature = "mock-desktop") {
            return false;
        }
        let loaded = self.loaded();
        let lock = device::starts_locked(loaded.settings.lock, loaded.problem.is_some(), self.device_lock().await, false);
        if lock {
            self.locked.store(true, Ordering::SeqCst);
        }
        lock
    }
}

#[tauri::command]
async fn remote_call(phone: State<'_, Phone>, command: String, args: Value) -> Result<Value, String> {
    phone.remote_call(&command, args).await
}

#[tauri::command]
fn phone_identity(phone: State<'_, Phone>) -> Result<IdentityReport, String> {
    phone.identity.clone().map(|endpoint_id| IdentityReport { endpoint_id })
}

#[tauri::command]
fn phone_open_release_page(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(vibe_remote::RELEASE_PAGE, None::<&str>)
        .map_err(|e| format!("could not open {}: {e}", vibe_remote::RELEASE_PAGE))
}

#[tauri::command]
fn phone_desktops(phone: State<'_, Phone>) -> Result<Value, String> {
    phone.unlocked()?;
    Ok(phone.desktop.desktops())
}

#[tauri::command]
fn phone_probe(phone: State<'_, Phone>) -> Result<(), String> {
    phone.unlocked()?;
    phone.desktop.probe();
    Ok(())
}

#[tauri::command]
async fn phone_open(phone: State<'_, Phone>, id: Option<String>) -> Result<Value, String> {
    phone.unlocked()?;
    phone.desktop.open(id).await
}

/// Behind the lock, with `phone_release`: a connection's range and the release
/// of its replay are what let the desktop's frames reach the window. A
/// reconnect while the app sits locked is kept by the link and held at its
/// gate; the webview waits for the unlock before it asks for either.
#[tauri::command]
fn phone_session(phone: State<'_, Phone>) -> Result<Value, String> {
    phone.unlocked()?;
    phone.desktop.session()
}

#[tauri::command]
fn phone_release(phone: State<'_, Phone>, generation: u64) -> Result<(), String> {
    phone.unlocked()?;
    phone.desktop.release(generation);
    Ok(())
}

#[tauri::command]
async fn phone_pair(phone: State<'_, Phone>, payload: String, phone_name: String, attempt: u64) -> Result<Value, String> {
    phone.unlocked()?;
    phone.desktop.pair(payload, phone_name, attempt).await
}

#[tauri::command]
fn phone_pair_cancel(phone: State<'_, Phone>, attempt: u64) {
    phone.desktop.pair_cancel(attempt);
}

#[tauri::command]
async fn phone_unpair(phone: State<'_, Phone>, id: String) -> Result<Value, String> {
    phone.unlocked()?;
    phone.desktop.unpair(id).await
}

#[tauri::command]
fn phone_rename(phone: State<'_, Phone>, id: String, name: Option<String>) -> Result<(), String> {
    phone.unlocked()?;
    phone.desktop.rename(&id, name)
}

#[tauri::command]
async fn phone_network_change(phone: State<'_, Phone>, online: bool) -> Result<(), String> {
    phone.desktop.network_changed(Some(online)).await;
    Ok(())
}

/// Whether to ask the OS for permission to notify: the setting is on, and the
/// OS has not been answered yet. A refusal is the OS's answer and is not asked
/// again.
fn ask_to_notify(notify: bool, state: PermissionState) -> bool {
    notify && matches!(state, PermissionState::Prompt | PermissionState::PromptWithRationale)
}

/// Whether a notification may be shown: the setting is on and the OS allows it.
fn may_notify(notify: bool, state: PermissionState) -> bool {
    notify && state == PermissionState::Granted
}

/// Notifications are on by default, so a fresh install has never pressed the
/// switch and the OS has never been asked. Asked once per launch, from the
/// first `phone_settings` (the boot read) and whenever the switch is turned
/// on - never from `phone_notify`, which fires while the app is hidden.
static ASKED_TO_NOTIFY: AtomicBool = AtomicBool::new(false);

fn ensure_notify_permission(app: &tauri::AppHandle, notify: bool) {
    let state = match app.notification().permission_state() {
        Ok(state) => state,
        Err(e) => {
            log::warn!("vibe-mobile: notification permission: {e}");
            return;
        }
    };
    if ask_to_notify(notify, state) {
        if let Err(e) = app.notification().request_permission() {
            log::warn!("vibe-mobile: notification permission: {e}");
        }
    }
}

#[tauri::command]
async fn phone_settings(app: tauri::AppHandle, phone: State<'_, Phone>) -> Result<SettingsReport, String> {
    let report = phone.report().await;
    // Not in the mock build, which CI launches with nobody to answer a prompt,
    // for the reason it starts unlocked.
    if !cfg!(feature = "mock-desktop") && !ASKED_TO_NOTIFY.swap(true, Ordering::SeqCst) {
        ensure_notify_permission(&app, report.settings.notify);
    }
    Ok(report)
}

#[tauri::command]
async fn phone_settings_set(app: tauri::AppHandle, phone: State<'_, Phone>, patch: Patch) -> Result<SettingsReport, String> {
    let file = phone.settings.as_ref().map_err(Clone::clone)?;
    file.apply(&patch)?;
    if patch.notify == Some(true) {
        ensure_notify_permission(&app, true);
    }
    Ok(phone.report().await)
}

#[tauri::command]
async fn phone_confirm(phone: State<'_, Phone>, reason: String) -> Result<bool, String> {
    phone.confirm(reason).await
}

#[tauri::command]
async fn phone_unlock(phone: State<'_, Phone>) -> Result<bool, String> {
    phone.unlock().await
}

/// A local notification, fired from Rust so the window needs no notification
/// permission. The webview asks only while it is hidden; this checks the
/// setting again, so a stale webview cannot notify past a switch turned off.
#[tauri::command]
fn phone_notify(app: tauri::AppHandle, phone: State<'_, Phone>, title: String, body: String) -> Result<(), String> {
    // Shown only once the OS allows it: a fresh install's first notification
    // would otherwise go to `show()` unasked and vanish.
    let state = app.notification().permission_state().map_err(|e| e.to_string())?;
    if !may_notify(phone.loaded().settings.notify, state) {
        return Ok(());
    }
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

fn data_dir(app: &tauri::App) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("this phone gave the app no data directory: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                // One target: the defaults add stdout and a log file of their own.
                .clear_targets()
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout))
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_biometric::init()).plugin(tauri_plugin_barcode_scanner::init());
    builder
        .setup(|app| {
            let key = identity::load();
            let identity = key.as_ref().map(|k| k.public().to_string()).map_err(Clone::clone);
            match &identity {
                Ok(id) => log::info!("vibe-mobile: device key ready, endpoint id {id}"),
                Err(why) => log::error!("vibe-mobile: no device key: {why}"),
            }
            let dir = data_dir(app);
            let settings = dir.as_ref().map(|d| Arc::new(SettingsFile::in_dir(d))).map_err(Clone::clone);
            #[cfg(mobile)]
            let device: Arc<dyn Device> = Arc::new(device::Mobile(app.handle().clone()));
            #[cfg(not(mobile))]
            let device: Arc<dyn Device> = Arc::new(device::Host);

            #[cfg(feature = "mock-desktop")]
            let desktop: Box<dyn Desktop> = {
                let _ = (key, &dir);
                Box::new(mock::Recorded::new(app.handle().clone()))
            };
            #[cfg(not(feature = "mock-desktop"))]
            let desktop: Box<dyn Desktop> = match (key, &dir) {
                (Ok(key), Ok(dir)) => {
                    let named = settings.clone();
                    let name: Arc<dyn Fn() -> String + Send + Sync> = Arc::new(move || match &named {
                        Ok(file) => file.load().settings.name,
                        Err(_) => settings::default_name(),
                    });
                    Box::new(link::Link::new(
                        app.handle().clone(),
                        key,
                        Arc::new(vibe_remote::paired::PairedList::in_dir(dir)),
                        app.package_info().version.to_string(),
                        name,
                    ))
                }
                (_, Err(why)) => {
                    log::error!("vibe-mobile: {why}");
                    Box::new(desktop::Unconnected)
                }
                (Err(_), _) => Box::new(desktop::Unconnected),
            };

            let phone = Phone {
                desktop,
                identity,
                device: device.clone(),
                settings,
                locked: AtomicBool::new(false),
                away_since: Mutex::new(None),
            };
            let loaded = phone.loaded();
            let locked = device::starts_locked(
                loaded.settings.lock,
                loaded.problem.is_some(),
                device.lock_state(),
                cfg!(feature = "mock-desktop"),
            );
            phone.locked.store(locked, Ordering::SeqCst);
            app.manage(phone);
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle().clone();
            match event {
                #[cfg(mobile)]
                tauri::WindowEvent::Suspended => app.state::<Phone>().suspended(),
                #[cfg(mobile)]
                tauri::WindowEvent::Resumed => {
                    tauri::async_runtime::spawn(async move {
                        let phone = app.state::<Phone>();
                        if phone.resumed().await {
                            let _ = app.emit("phone://locked", ());
                        }
                        // Every return to the foreground reconnects now.
                        phone.desktop.network_changed(None).await;
                    });
                }
                _ => {
                    let _ = app;
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            remote_call,
            phone_identity,
            phone_open_release_page,
            phone_desktops,
            phone_probe,
            phone_open,
            phone_session,
            phone_release,
            phone_pair,
            phone_pair_cancel,
            phone_unpair,
            phone_rename,
            phone_network_change,
            phone_settings,
            phone_settings_set,
            phone_confirm,
            phone_unlock,
            phone_notify
        ])
        .run(tauri::generate_context!())
        .expect("the phone app could not start");
}

#[cfg(test)]
mod tests {
    use tauri::plugin::PermissionState as P;

    #[test]
    fn a_default_on_switch_asks_the_os_once_it_is_undecided_and_never_after_a_refusal() {
        assert!(super::ask_to_notify(true, P::Prompt), "a fresh install");
        assert!(super::ask_to_notify(true, P::PromptWithRationale));
        assert!(!super::ask_to_notify(true, P::Granted));
        assert!(!super::ask_to_notify(true, P::Denied), "a refusal is the OS's answer");
        assert!(!super::ask_to_notify(false, P::Prompt), "the switch is off");
    }

    #[test]
    fn a_notification_is_shown_only_when_the_switch_is_on_and_the_os_allows_it() {
        assert!(super::may_notify(true, P::Granted));
        for state in [P::Prompt, P::PromptWithRationale, P::Denied] {
            assert!(!super::may_notify(true, state), "{state:?}");
        }
        assert!(!super::may_notify(false, P::Granted));
    }

    use super::*;
    use desktop::{Answer, UNCONNECTED};

    /// A desktop that answers every call, so a refusal can only be the lock.
    struct Answers;

    impl Desktop for Answers {
        fn call(&self, command: &str, _args: Value) -> Answer<'_> {
            let command = command.to_string();
            Box::pin(async move { Ok(Value::String(command)) })
        }
    }

    struct Fixed(DeviceLock, bool);

    impl Device for Fixed {
        fn confirm(&self, _reason: &str) -> Result<bool, String> {
            Ok(self.1)
        }
        fn lock_state(&self) -> DeviceLock {
            self.0
        }
    }

    fn phone(dir: &settings::tests::Scratch, device: Fixed, locked: bool) -> Phone {
        Phone {
            desktop: Box::new(Answers),
            identity: Ok("id".into()),
            device: Arc::new(device),
            settings: Ok(Arc::new(SettingsFile::in_dir(&dir.0))),
            locked: AtomicBool::new(locked),
            away_since: Mutex::new(None),
        }
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn a_locked_app_refuses_every_desktop_command_until_unlocked() {
        let dir = settings::tests::Scratch::new("lib-locked");
        let p = phone(&dir, Fixed(DeviceLock::Set, true), true);
        assert_eq!(run(p.remote_call("host_status", Value::Null)), Err(LOCKED.into()));
        assert_eq!(p.unlocked(), Err(LOCKED.into()), "the guard every desktop command takes");
        let report = run(p.report());
        assert!(report.locked);
        assert_eq!(report.device_lock, DeviceLock::Set);

        assert_eq!(run(p.unlock()), Ok(false), "unlocked");
        assert_eq!(run(p.remote_call("host_status", Value::Null)), Ok(Value::String("host_status".into())));
        assert!(!run(p.report()).locked);
    }

    #[test]
    fn a_refused_confirmation_leaves_it_locked() {
        let dir = settings::tests::Scratch::new("lib-refused");
        let p = phone(&dir, Fixed(DeviceLock::Set, false), true);
        assert_eq!(run(p.unlock()), Ok(true));
        assert_eq!(run(p.remote_call("host_status", Value::Null)), Err(LOCKED.into()));
    }

    #[test]
    fn the_settings_report_reads_the_device_lock_live() {
        for state in [DeviceLock::Set, DeviceLock::None, DeviceLock::Unknown] {
            let dir = settings::tests::Scratch::new("lib-device-lock");
            let p = phone(&dir, Fixed(state, true), false);
            let report = run(p.report());
            assert_eq!(report.device_lock, state);
            let json = serde_json::to_value(&report).unwrap();
            assert_eq!(json["deviceLock"], serde_json::to_value(state).unwrap());
            assert_eq!(json["lock"], true, "flattened settings");
            assert_eq!(json["locked"], false);
        }
    }

    #[test]
    fn an_unconnected_desktop_still_says_so_once_unlocked() {
        let dir = settings::tests::Scratch::new("lib-unconnected");
        let mut p = phone(&dir, Fixed(DeviceLock::Set, true), false);
        p.desktop = Box::new(desktop::Unconnected);
        assert_eq!(run(p.remote_call("host_status", Value::Null)), Err(UNCONNECTED.into()));
    }

    #[test]
    #[cfg(not(feature = "mock-desktop"))]
    fn coming_back_soon_does_not_lock_and_coming_back_late_does() {
        let dir = settings::tests::Scratch::new("lib-resume");
        let p = phone(&dir, Fixed(DeviceLock::Set, true), false);
        p.suspended();
        assert!(!run(p.resumed()), "back within five minutes");
        *p.away_since.lock().unwrap() = Some(Instant::now() - LOCK_AFTER);
        assert!(run(p.resumed()), "away for five minutes");
        assert_eq!(p.unlocked(), Err(LOCKED.into()));

        let none = phone(&dir, Fixed(DeviceLock::None, true), false);
        *none.away_since.lock().unwrap() = Some(Instant::now() - LOCK_AFTER);
        assert!(!run(none.resumed()), "nothing to unlock with");
    }
}
