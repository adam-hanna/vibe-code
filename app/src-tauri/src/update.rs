//! Telling somebody a newer app exists, and installing it when they ask (#299).
//!
//! The app's second network client, beside the pilot, and it is the narrower of
//! the two: it fetches one public file - `latest.json` on the newest published
//! GitHub release - and, only when a person presses Update & restart, the bundle
//! that file names. The bundle is verified against the minisign key compiled in
//! from `tauri.conf.json` before anything is installed, so whatever the endpoint
//! says, only a build signed with the owner's key can land.
//!
//! **The window reaches it through two commands and nothing else.** No updater
//! permission is granted in `capabilities/default.json` and no npm package is
//! installed, so the page has no network access of its own and cannot name a
//! URL: the endpoint is config or `VIBE_UPDATE_ENDPOINT`, and the release page
//! is a constant below.
//!
//! Five rules travel with it:
//!
//! - **A check never fails on screen.** No manifest yet (a 404, which is what
//!   the newest release answers until one ships with the updater), no network, a
//!   manifest that will not parse: each is one line in `vibe-desktop.log` and
//!   `None` to the window. "No update" and "could not ask" look the same there.
//! - **A `.deb` never self-updates.** The plugin can install a `.deb` itself, but
//!   it looks up `linux-x86_64-deb` and then falls back to `linux-x86_64` - which
//!   in our `latest.json` is the AppImage - and would `dpkg -i` those bytes.
//!   `action_for` refuses it, and `update_install` asks it again rather than
//!   trusting what the window was told.
//! - **A live run is never stopped without asking.** `update_install` answers
//!   `Confirm` while `has_run_hosts()` is true - which includes a host set it
//!   cannot read - and does nothing else until the window calls again with the
//!   person's yes. Then every host is stopped with the one `stop()` the tray's
//!   Quit uses, so each run leaves through `HOST_EXIT_ABANDONED`, writes its
//!   `ending.json` and is resumable (#206).
//! - **Hosts stop before the installer runs, on every platform.** The plugin's
//!   `on_before_exit` hook only exists on Windows - where it matters most,
//!   because a running host holds `node.exe` and NSIS/MSI overwrite it - so the
//!   hook is wired for that case and `update_install` also awaits the same stop
//!   itself, after the download and before `install()`, everywhere. `stop()`
//!   drains the set, so the second call finds nothing.
//! - **The old process exits before the new one starts.** `restart()` is called
//!   from this command's async thread, not the main one, so Tauri requests an
//!   exit and spawns the new process only after `RunEvent::Exit` has run - which
//!   is where single-instance releases its lock and `lib.rs` runs `stop()`. A new
//!   process started earlier would find the old one and raise its window instead.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::applog;
use crate::host::{self, HostProcess};

/// Where Download and Release notes send a browser. A constant, so the window
/// can ask for the page and never say which page.
pub const RELEASE_PAGE: &str = "https://github.com/adam-hanna/vibe-code/releases/latest";

/// How long one request may take - the manifest check, and the bundle download.
///
/// **A choice, not a measurement.** The plugin's default is no limit, and a
/// network that swallows packets would then hold a check (and the install guard
/// with it) for ever, with nothing logged. Ten minutes ends a hung check long
/// before the next one six hours later, and is long enough not to cut off a slow
/// but working download of a bundle that carries a Node runtime (~90 MB).
const TIMEOUT: Duration = Duration::from_secs(600);

/// The variable that points the updater somewhere else - the way to test it
/// against a `latest.json` that is not the newest published release.
const OVERRIDE_VAR: &str = "VIBE_UPDATE_ENDPOINT";

/// What this install does with an update.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    /// Download, verify, install and restart, from inside the app.
    Install,
    /// Open the release page and let the person install it themselves.
    Download,
}

/// Which action an install gets, from what Tauri patched into the binary at
/// bundle time and, on Linux, the variable the AppImage runtime sets.
///
/// Fails closed: an install this cannot identify is never handed the AppImage
/// entry or an installer. On Linux an unpatched binary is a dev build or a
/// package somebody built by hand, and `APPIMAGE` is the AppImage runtime's own
/// evidence; on Windows an unpatched binary is a dev build, with no installer
/// behind it to run. macOS reports `App` even unpatched, and there is only one
/// way to install there.
pub fn action_for(os: &str, bundle: Option<BundleType>, appimage_env: bool) -> Action {
    match bundle {
        // Even with APPIMAGE set: the plugin dispatches its installer on the
        // bundle type, so a patched `.deb` binary would `dpkg -i` the AppImage.
        Some(BundleType::Deb) | Some(BundleType::Rpm) => Action::Download,
        Some(BundleType::AppImage) => Action::Install,
        Some(BundleType::Nsis) | Some(BundleType::Msi) => Action::Install,
        Some(BundleType::App) | Some(BundleType::Dmg) => Action::Install,
        None => match os {
            "macos" => Action::Install,
            "linux" if appimage_env => Action::Install,
            _ => Action::Download,
        },
    }
}

/// This process's own install action.
fn this_action() -> Action {
    action_for(
        std::env::consts::OS,
        tauri::utils::platform::bundle_type(),
        std::env::var_os("APPIMAGE").is_some(),
    )
}

/// What `VIBE_UPDATE_ENDPOINT` says.
#[derive(Debug, PartialEq, Eq)]
pub enum Override {
    /// Unset or blank: the endpoint in `tauri.conf.json`.
    None,
    /// A usable URL, which replaces it.
    Use(Url),
    /// Set, and unusable: logged, and the built-in endpoint is used.
    Invalid(String),
}

/// Read the override. Only `https` is usable, because a release build of the
/// plugin refuses any other scheme - accepting `http` here would turn a value
/// that looks fine into a check that fails every time.
pub fn endpoint_override(raw: Option<&str>) -> Override {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Override::None;
    };
    match Url::parse(raw) {
        Ok(url) if url.scheme() == "https" => Override::Use(url),
        _ => Override::Invalid(raw.to_string()),
    }
}

fn read_override() -> Override {
    endpoint_override(std::env::var(OVERRIDE_VAR).ok().as_deref())
}

/// Said once at start-up, so a stray value cannot quietly point every check at
/// somewhere else. Nothing is said when the variable is unset.
pub fn log_override() {
    match read_override() {
        Override::None => {}
        Override::Use(url) => applog::app(&format!("{OVERRIDE_VAR} is set: updates are checked at {url}")),
        Override::Invalid(raw) => applog::app(&format!(
            "{OVERRIDE_VAR} is set to {raw:?}, which is not an https URL; it is ignored and the built-in endpoint is used"
        )),
    }
}

/// The update the last check found, and whether one is being installed.
///
/// The install works on a clone, so a download or install that fails leaves the
/// update here and pressing again retries it. While an install runs, a check
/// cannot replace it - the window must not be describing one version while
/// another is being written over the app.
///
/// **One lock for both halves.** The value and the flag were a `Mutex` and an
/// `AtomicBool`, and `offer` read the flag before taking the lock: a check could
/// see "not installing", an install could begin and clone the old update, and
/// the check would then overwrite it - so a retry installed a version nobody
/// had been shown. Every read and write of either now happens under one lock.
pub struct Slot<T: Clone> {
    state: Mutex<SlotState<T>>,
}

struct SlotState<T> {
    value: Option<T>,
    installing: bool,
}

impl<T: Clone> Default for Slot<T> {
    fn default() -> Self {
        Self {
            state: Mutex::new(SlotState {
                value: None,
                installing: false,
            }),
        }
    }
}

/// What a check should report: the update it found, or the one already being
/// installed, which it must not replace.
pub enum Offered<T> {
    Stored(T),
    Installing(Option<T>),
}

/// Held for the whole of one install; dropping it releases the slot, on every
/// path that returns.
pub struct InstallGuard<'a, T: Clone> {
    slot: &'a Slot<T>,
}

impl<T: Clone> Drop for InstallGuard<'_, T> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.slot.state.lock() {
            state.installing = false;
        }
    }
}

impl<T: Clone> Slot<T> {
    /// Store what a check found - unless an install is running, in which case
    /// the update being installed is what the caller is handed back.
    pub fn offer(&self, value: T) -> Offered<T> {
        match self.state.lock() {
            Ok(mut state) if !state.installing => {
                state.value = Some(value.clone());
                Offered::Stored(value)
            }
            Ok(state) => Offered::Installing(state.value.clone()),
            // Cannot tell: report nothing rather than a version that may not be
            // the one stored.
            Err(_) => Offered::Installing(None),
        }
    }

    #[cfg(test)]
    pub fn current(&self) -> Option<T> {
        self.state.lock().ok().and_then(|state| state.value.clone())
    }

    /// The update being installed, or `None` when no install is running.
    pub fn installing(&self) -> Option<Option<T>> {
        let state = self.state.lock().ok()?;
        state.installing.then(|| state.value.clone())
    }

    /// Start an install: one at a time, and only of something a check found.
    pub fn begin(&self) -> Result<(T, InstallGuard<'_, T>), &'static str> {
        let mut state = self.state.lock().map_err(|_| "the update state could not be read")?;
        if state.installing {
            return Err("an update is already being installed");
        }
        let value = state.value.clone().ok_or("no update has been found yet")?;
        state.installing = true;
        Ok((value, InstallGuard { slot: self }))
    }
}

pub type Pending = Slot<Update>;

/// One frame of `app://update-progress`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "stage", rename_all = "lowercase")]
pub enum Progress {
    /// `total` is the response's `Content-Length`, and absent when it sent none
    /// - in which case the window draws a count and no bar.
    Downloading { downloaded: u64, total: Option<u64> },
    Installing,
}

/// The plugin reports each chunk's length, not how much has arrived; this is
/// the running sum, with the denominator passed through as it came.
#[derive(Default)]
pub struct Tally {
    downloaded: u64,
}

impl Tally {
    pub fn add(&mut self, chunk: usize, total: Option<u64>) -> Progress {
        self.downloaded = self.downloaded.saturating_add(chunk as u64);
        Progress::Downloading {
            downloaded: self.downloaded,
            total,
        }
    }
}

/// What `update_install` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// Runs are going; nothing was downloaded or stopped. Ask, then call again.
    Confirm,
    /// The release page was handed to the system's browser.
    Opened,
}

/// Whether an install must ask first. `run_hosts` is `has_run_hosts()`, which
/// says yes when it cannot tell.
pub fn needs_confirm(confirmed: bool, run_hosts: bool) -> bool {
    !confirmed && run_hosts
}

/// What the popover needs, and nothing else.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    /// RFC 3339.
    pub date: Option<String>,
    pub action: Action,
}

fn info(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
        // The manifest's own string, already RFC 3339, rather than the parsed
        // date re-formatted: no second date library for one field.
        date: update
            .raw_json
            .get("pub_date")
            .and_then(|d| d.as_str())
            .map(str::to_string),
        action: this_action(),
    }
}

/// Every host stopped, gracefully, before anything overwrites the app. The one
/// function both the explicit stop and the Windows hook call.
pub(crate) fn before_install(hosts: &HostProcess) {
    applog::app("stopping every host before installing an update");
    hosts.stop();
}

fn updater(app: &AppHandle) -> Result<Updater, String> {
    let mut builder = app.updater_builder().timeout(TIMEOUT);
    if let Override::Use(url) = read_override() {
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let hook = app.clone();
    builder
        .on_before_exit(move || before_install(&hook.state::<HostProcess>()))
        .build()
        .map_err(|e| e.to_string())
}

/// Ask whether a newer version exists. `None` for no update **and** for any
/// failure, which goes to the log and never to the screen.
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>) -> Result<Option<UpdateInfo>, ()> {
    // An install is under way: describe what is being installed, and do not
    // ask the network for something that could replace it.
    if let Some(installing) = pending.installing() {
        return Ok(installing.as_ref().map(info));
    }
    let found = match updater(&app) {
        Ok(updater) => updater.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e),
    };
    match found {
        Ok(Some(mut update)) => {
            // The plugin builds an `Update` with no timeout of its own, so the
            // download would otherwise be unbounded.
            update.timeout = Some(TIMEOUT);
            // Report what is stored, never merely what was found: an install
            // that began while this check was in flight keeps its update, and
            // the window goes on describing that one.
            Ok(match pending.offer(update) {
                Offered::Stored(update) => Some(info(&update)),
                Offered::Installing(installing) => installing.as_ref().map(info),
            })
        }
        Ok(None) => Ok(None),
        Err(reason) => {
            applog::app(&format!("update check failed: {reason}"));
            Ok(None)
        }
    }
}

/// Open the release page, or install the update the last check found.
///
/// `page` opens the page and touches nothing else. Otherwise, in order: ask if
/// runs are going, take the one install slot, refuse an install that updates by
/// download, download, stop every host (awaited), install, restart.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    pending: State<'_, Pending>,
    page: bool,
    confirmed: bool,
) -> Result<Outcome, String> {
    if page {
        return open_release_page().map(|()| Outcome::Opened);
    }
    install_refusal(this_action())?;
    // From here until the restart no run may start: one started during a
    // ten-minute download would otherwise be stopped by the install without
    // anybody being asked about it. Freezing and asking whether runs exist are
    // one step under the host lock, so the answer cannot go stale before the
    // freeze lands. Every return below thaws; a restart never returns.
    let hosts = app.state::<HostProcess>();
    let frozen = Frozen(hosts.inner().clone());
    if needs_confirm(confirmed, hosts.freeze_runs()) {
        return Ok(Outcome::Confirm);
    }
    let (update, _guard) = pending.begin().map_err(str::to_string)?;

    let mut tally = Tally::default();
    let bytes = update
        .download(
            |chunk, total| {
                let _ = app.emit("app://update-progress", tally.add(chunk, total));
            },
            || {
                let _ = app.emit("app://update-progress", Progress::Installing);
            },
        )
        .await
        .map_err(|e| {
            applog::app(&format!("update download failed: {e}"));
            e.to_string()
        })?;

    let stopping = app.clone();
    tauri::async_runtime::spawn_blocking(move || before_install(&stopping.state::<HostProcess>()))
        .await
        .map_err(|e| format!("could not stop the hosts before installing: {e}"))?;

    if let Err(e) = update.install(bytes) {
        applog::app(&format!("update install failed: {e}"));
        // The runs were stopped resumably; let them start again and bring the
        // service host back so the window can read them and resume one.
        drop(frozen);
        let _ = host::launch(&app);
        return Err(e.to_string());
    }
    applog::app(&format!("update {} installed; restarting", update.version));
    app.restart();
}

/// Run starts refused for as long as this lives; dropped on every path that
/// does not restart.
struct Frozen(HostProcess);

impl Drop for Frozen {
    fn drop(&mut self) {
        self.0.thaw_runs();
    }
}

/// The refusal `update_install` gives an install that updates by download -
/// a `.deb`, or a build this cannot identify - before anything is downloaded
/// or stopped. Its own function so the guard is tested, not only the table.
pub fn install_refusal(action: Action) -> Result<(), String> {
    match action {
        Action::Install => Ok(()),
        Action::Download => Err("this install updates by download, from the release page".into()),
    }
}

/// The release page in the system's browser. No URL and no program from the
/// window: both are fixed here.
fn open_release_page() -> Result<(), String> {
    let mut command = opener();
    command.arg(RELEASE_PAGE);
    match command.spawn() {
        Ok(_) => Ok(()),
        Err(e) => {
            applog::app(&format!("could not open the release page: {e}"));
            Err(format!("could not open {RELEASE_PAGE}: {e}"))
        }
    }
}

#[cfg(target_os = "linux")]
fn opener() -> std::process::Command {
    std::process::Command::new("xdg-open")
}

#[cfg(target_os = "macos")]
fn opener() -> std::process::Command {
    std::process::Command::new("open")
}

#[cfg(windows)]
fn opener() -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = std::process::Command::new("explorer.exe");
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deb_is_never_installed_and_an_unknown_install_fails_closed() {
        use BundleType::*;
        let cases: &[(&str, Option<BundleType>, bool, Action)] = &[
            ("linux", Some(Deb), false, Action::Download),
            ("linux", Some(Deb), true, Action::Download),
            ("linux", Some(Rpm), false, Action::Download),
            ("linux", Some(AppImage), false, Action::Install),
            ("linux", None, false, Action::Download),
            ("linux", None, true, Action::Install),
            ("macos", Some(App), false, Action::Install),
            ("macos", None, false, Action::Install),
            ("windows", Some(Nsis), false, Action::Install),
            ("windows", Some(Msi), false, Action::Install),
            ("windows", None, false, Action::Download),
        ];
        for (os, bundle, env, want) in cases {
            assert_eq!(action_for(os, bundle.clone(), *env), *want, "{os} {bundle:?} APPIMAGE={env}");
        }
    }

    #[test]
    fn the_endpoint_override_is_used_only_when_it_is_an_https_url() {
        assert_eq!(endpoint_override(None), Override::None);
        assert_eq!(endpoint_override(Some("   ")), Override::None);
        let url = "https://github.com/adam-hanna/vibe-code/releases/download/v1.5.1-rc.2/latest.json";
        assert_eq!(endpoint_override(Some(url)), Override::Use(Url::parse(url).unwrap()));
        assert_eq!(
            endpoint_override(Some("not a url")),
            Override::Invalid("not a url".into())
        );
        assert!(matches!(
            endpoint_override(Some("http://localhost:8000/latest.json")),
            Override::Invalid(_)
        ));
    }

    #[test]
    fn only_an_unconfirmed_install_with_runs_going_asks() {
        assert!(needs_confirm(false, true));
        assert!(!needs_confirm(true, true));
        assert!(!needs_confirm(false, false));
        assert!(!needs_confirm(true, false));
    }

    #[test]
    fn an_install_that_updates_by_download_is_refused_before_anything_happens() {
        assert!(install_refusal(Action::Install).is_ok());
        let why = install_refusal(Action::Download).expect_err("a .deb never self-updates");
        assert!(why.contains("by download"), "{why}");
        // And a deb gets that action whatever else the environment says.
        assert!(install_refusal(action_for("linux", Some(BundleType::Deb), true)).is_err());
    }

    fn stored(o: Offered<String>) -> Option<String> {
        match o {
            Offered::Stored(v) => Some(v),
            Offered::Installing(_) => None,
        }
    }

    #[test]
    fn an_empty_slot_cannot_begin_and_does_not_stay_locked() {
        let slot = Slot::<String>::default();
        assert_eq!(slot.begin().err(), Some("no update has been found yet"));
        assert!(slot.installing().is_none());
    }

    #[test]
    fn one_install_at_a_time() {
        let slot = Slot::default();
        assert_eq!(stored(slot.offer("1.6.0".to_string())).as_deref(), Some("1.6.0"));
        let (value, _guard) = slot.begin().expect("begins");
        assert_eq!(value, "1.6.0");
        assert_eq!(slot.begin().err(), Some("an update is already being installed"));
    }

    #[test]
    fn a_check_during_an_install_does_not_replace_the_update_and_reports_it() {
        let slot = Slot::default();
        slot.offer("1.6.0".to_string());
        let _held = slot.begin().expect("begins");
        match slot.offer("1.7.0".to_string()) {
            Offered::Installing(v) => assert_eq!(v.as_deref(), Some("1.6.0")),
            Offered::Stored(_) => panic!("a check replaced the update being installed"),
        }
        assert_eq!(slot.current().as_deref(), Some("1.6.0"));
        assert_eq!(slot.installing(), Some(Some("1.6.0".to_string())));
    }

    #[test]
    fn checks_and_installs_racing_never_install_what_was_not_stored() {
        // The interleaving the old two-part state allowed: a check reading
        // "not installing" just before an install began. Now every outcome is
        // either the check landing first (and being what is installed) or the
        // check being told about the install.
        use std::sync::Arc;
        for _ in 0..200 {
            let slot = Arc::new(Slot::default());
            slot.offer("1.6.0".to_string());
            let checker = {
                let slot = slot.clone();
                std::thread::spawn(move || stored(slot.offer("1.7.0".to_string())).is_some())
            };
            let begun = slot.begin().map(|(v, _g)| v);
            let check_stored = checker.join().unwrap();
            let installed = begun.expect("nothing else installs");
            if !check_stored {
                assert_eq!(installed, "1.6.0");
            }
            // Whatever was installed is what the slot holds or held before a
            // later check: never a value no `offer` returned as stored.
            assert!(installed == "1.6.0" || installed == "1.7.0");
            if installed == "1.7.0" {
                assert!(check_stored, "installed a version the check never stored");
            }
        }
    }

    #[test]
    fn a_failed_install_leaves_the_update_for_a_retry() {
        let slot = Slot::default();
        slot.offer("1.6.0".to_string());
        {
            let _attempt = slot.begin().expect("begins");
            // ...the download or the install fails, and the function returns.
        }
        assert!(slot.installing().is_none());
        let (value, _guard) = slot.begin().expect("a retry begins");
        assert_eq!(value, "1.6.0");
    }

    #[test]
    fn progress_is_the_running_sum_over_the_reported_length() {
        let mut tally = Tally::default();
        let got: Vec<Progress> = [10, 20, 5].iter().map(|c| tally.add(*c, Some(100))).collect();
        assert_eq!(
            got,
            vec![
                Progress::Downloading { downloaded: 10, total: Some(100) },
                Progress::Downloading { downloaded: 30, total: Some(100) },
                Progress::Downloading { downloaded: 35, total: Some(100) },
            ]
        );
        let mut unknown = Tally::default();
        assert_eq!(
            unknown.add(7, None),
            Progress::Downloading { downloaded: 7, total: None }
        );
    }

    #[test]
    fn progress_serialises_the_shape_the_window_reads() {
        let json = serde_json::to_value(Progress::Downloading { downloaded: 3, total: None }).unwrap();
        assert_eq!(json, serde_json::json!({ "stage": "downloading", "downloaded": 3, "total": null }));
        let json = serde_json::to_value(Progress::Installing).unwrap();
        assert_eq!(json, serde_json::json!({ "stage": "installing" }));
        assert_eq!(serde_json::to_value(Outcome::Confirm).unwrap(), "confirm");
        assert_eq!(serde_json::to_value(Action::Download).unwrap(), "download");
    }
}
