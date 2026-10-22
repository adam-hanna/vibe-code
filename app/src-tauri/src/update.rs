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
//! Six rules travel with it:
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
//! - **An AppImage installs only over a file that is there** (#390). The
//!   plugin overwrites `$APPIMAGE`, so `action_for` decides on that file - a
//!   regular file in a folder this user can write - rather than on the
//!   variable. `update_install` asks before the download and again after it,
//!   before any host is stopped, and a refusal names the path and says to
//!   download from the release page instead of a bare `os error 2`.
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

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Manager, State, Url};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::applog;
use crate::host::{self, HostProcess};

/// Where Download and Release notes send a browser. A constant, so the window
/// can ask for the page and never say which page. The phone opens the same one,
/// so it lives in the shared crate (#345).
pub use vibe_remote::RELEASE_PAGE;

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

/// What `$APPIMAGE` names, which is the file an AppImage update overwrites.
///
/// **The variable is not the file** (#390). The plugin points its installer at
/// `$APPIMAGE` and begins by reading that path's metadata, so a file moved,
/// renamed or deleted after launch - the app was started from a worktree's
/// `target/release/bundle/appimage/` and the worktree was pruned while it ran -
/// downloaded the whole bundle, stopped every host and then failed with a bare
/// `No such file or directory (os error 2)`. Linux keeps the open file alive for
/// the process using it, so nothing else looked wrong. A directory this user
/// cannot write fails the same way with another error: the plugin renames the
/// old file aside and writes the new one in its place, and both need the folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppImageFile {
    /// Unset or empty: the AppImage runtime did not start this process.
    Unset,
    /// A regular file, in a directory this process can write.
    Ready(PathBuf),
    /// Nothing that is a regular file is at the path any more.
    Missing(PathBuf),
    /// The file is there, but its directory cannot be written.
    ReadOnly(PathBuf),
}

/// Read what `var` names through the two probes. Its own function so the
/// decision is tested without a filesystem; `read_appimage` passes the real ones.
pub fn appimage_file(
    var: Option<&OsStr>,
    is_file: impl Fn(&Path) -> bool,
    dir_writable: impl Fn(&Path) -> bool,
) -> AppImageFile {
    let Some(path) = var.filter(|v| !v.is_empty()).map(PathBuf::from) else {
        return AppImageFile::Unset;
    };
    if !is_file(&path) {
        return AppImageFile::Missing(path);
    }
    // A file always has a parent; a bare name is relative to the working
    // directory, which is where the plugin would write it.
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.to_path_buf(),
        _ => PathBuf::from("."),
    };
    if dir_writable(&dir) {
        AppImageFile::Ready(path)
    } else {
        AppImageFile::ReadOnly(path)
    }
}

/// This process's `$APPIMAGE`, read now. Every decision reads it again rather
/// than once at start-up, because what goes wrong is the file changing while
/// the app runs.
fn read_appimage() -> AppImageFile {
    appimage_file(
        std::env::var_os("APPIMAGE").as_deref(),
        |p| std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false),
        dir_writable,
    )
}

/// `access(W_OK)`: asked of the kernel, so a read-only mount, a folder owned
/// by somebody else and an ACL all answer the same way, and nothing is written
/// to find out.
#[cfg(unix)]
fn dir_writable(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `c` is a valid NUL-terminated string that outlives the call.
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(not(unix))]
fn dir_writable(_: &Path) -> bool {
    // `APPIMAGE` only means anything on Linux; elsewhere it is never consulted.
    false
}

/// Whether the plugin would install this build by overwriting an AppImage: a
/// binary patched as one, or an unpatched Linux binary, which the plugin's
/// installer dispatch sends to the same `install_appimage`.
fn installs_as_appimage(os: &str, bundle: Option<&BundleType>) -> bool {
    match bundle {
        Some(BundleType::AppImage) => true,
        None => os == "linux",
        _ => false,
    }
}

/// Which action an install gets, from what Tauri patched into the binary at
/// bundle time and, on Linux, the file `APPIMAGE` names.
///
/// Fails closed: an install this cannot identify is never handed the AppImage
/// entry or an installer. On Linux an unpatched binary is a dev build or a
/// package somebody built by hand, and `APPIMAGE` is the AppImage runtime's own
/// evidence; on Windows an unpatched binary is a dev build, with no installer
/// behind it to run. macOS reports `App` even unpatched, and there is only one
/// way to install there. **An AppImage installs only when the file it would
/// overwrite is there and its folder can be written** (#390) - and that holds
/// for a patched AppImage binary too, because without `APPIMAGE` the plugin
/// falls back to `current_exe()`, which is inside the read-only mount.
pub fn action_for(os: &str, bundle: Option<BundleType>, appimage: &AppImageFile) -> Action {
    match &bundle {
        // Even with APPIMAGE set: the plugin dispatches its installer on the
        // bundle type, so a patched `.deb` binary would `dpkg -i` the AppImage.
        Some(BundleType::Deb) | Some(BundleType::Rpm) => Action::Download,
        _ if installs_as_appimage(os, bundle.as_ref()) => match appimage {
            AppImageFile::Ready(_) => Action::Install,
            AppImageFile::Unset | AppImageFile::Missing(_) | AppImageFile::ReadOnly(_) => Action::Download,
        },
        Some(BundleType::Nsis) | Some(BundleType::Msi) => Action::Install,
        Some(BundleType::App) | Some(BundleType::Dmg) => Action::Install,
        _ => match os {
            "macos" => Action::Install,
            _ => Action::Download,
        },
    }
}

/// The sentence for an AppImage that cannot be updated in place, naming the
/// path and what to do; `None` when the file is fine or there is none.
pub fn appimage_problem(appimage: &AppImageFile) -> Option<String> {
    match appimage {
        AppImageFile::Unset | AppImageFile::Ready(_) => None,
        AppImageFile::Missing(path) => Some(format!(
            "This AppImage was moved or deleted after it started: {} is not there any more, so the update has nothing to replace. \
             Download the new version from the release page, put it somewhere permanent such as ~/Applications, and start it from there.",
            path.display()
        )),
        AppImageFile::ReadOnly(path) => Some(format!(
            "This AppImage's folder cannot be written, so the update cannot replace {}. \
             Download the new version from the release page, or move this AppImage to a folder you own, such as ~/Applications, and start it from there.",
            path.display()
        )),
    }
}

/// This process's own install action.
fn this_action() -> Action {
    let (os, bundle) = this_os_bundle();
    action_for(os, bundle, &read_appimage())
}

/// Why this process's AppImage cannot be updated in place, when it is one.
fn this_appimage_problem() -> Option<String> {
    let (os, bundle) = this_os_bundle();
    installs_as_appimage(os, bundle.as_ref()).then(|| appimage_problem(&read_appimage())).flatten()
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
    check(&app, &pending).await
}

/// `update_check`'s body, shared with a phone's call through the bridge (#343).
pub(crate) async fn check(app: &AppHandle, pending: &Pending) -> Result<Option<UpdateInfo>, ()> {
    // An install is under way: describe what is being installed, and do not
    // ask the network for something that could replace it.
    if let Some(installing) = pending.installing() {
        return Ok(installing.as_ref().map(info));
    }
    let found = match updater(app) {
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
                Offered::Stored(update) => {
                    // The window draws Download and nothing more; the log says
                    // which file made it so (#390).
                    if let Some(why) = this_appimage_problem() {
                        applog::app(&format!("update {} is offered by download: {why}", update.version));
                    }
                    Some(info(&update))
                }
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
/// `page` opens the page and touches nothing else. Otherwise, in order: refuse
/// an install that updates by download, take the one install slot, freeze run
/// starts and ask if runs are going, download, stop every host (awaited),
/// install, restart.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    pending: State<'_, Pending>,
    page: bool,
    confirmed: bool,
) -> Result<Outcome, String> {
    install(&app, &pending, page, confirmed, open_release_page).await
}

/// `update_install`'s body, shared with a phone's call through the bridge
/// (#343). `open_page` is how `page` is honoured: the window opens the
/// desktop's browser, and a phone's call opens nothing here, because the page
/// is opened on the phone (`openOnPhone`), from the phone's own constant.
pub(crate) async fn install(
    app: &AppHandle,
    pending: &Pending,
    page: bool,
    confirmed: bool,
    open_page: fn() -> Result<(), String>,
) -> Result<Outcome, String> {
    if page {
        return open_page().map(|()| Outcome::Opened);
    }
    install_refusal(this_os_bundle(), &read_appimage())?;
    let hosts = app.state::<HostProcess>();
    // Held to the end; every return drops it, which thaws run starts and then
    // releases the slot. A restart never returns.
    let held = claim(pending, hosts.inner()).map_err(str::to_string)?;
    if needs_confirm(confirmed, held.run_hosts) {
        return Ok(Outcome::Confirm);
    }

    let mut tally = Tally::default();
    let update = &held.update;
    let bytes = update
        .download(
            |chunk, total| {
                crate::remote::hub::emit(app, PROGRESS_EVENT, &tally.add(chunk, total));
            },
            || {
                crate::remote::hub::emit(app, PROGRESS_EVENT, &Progress::Installing);
            },
        )
        .await
        .map_err(|e| {
            applog::app(&format!("update download failed: {e}"));
            e.to_string()
        })?;

    // Asked again after the download and before anything is stopped: the
    // download can take minutes, and a file moved in that time would otherwise
    // be found missing only after every run had been stopped (#390).
    if let Err(why) = install_refusal(this_os_bundle(), &read_appimage()) {
        applog::app(&format!("update install refused after the download: {why}"));
        return Err(why);
    }

    let stopping = app.clone();
    tauri::async_runtime::spawn_blocking(move || before_install(&stopping.state::<HostProcess>()))
        .await
        .map_err(|e| format!("could not stop the hosts before installing: {e}"))?;

    if let Err(e) = update.install(bytes) {
        // The raw error is for the log; the window gets a sentence when the
        // file is what failed - the race the second check above cannot close.
        applog::app(&format!("update install failed: {e}"));
        // The runs were stopped resumably; let them start again and bring the
        // service host back so the window can read them and resume one.
        drop(held);
        let _ = host::launch(app);
        return Err(install_failure(this_os_bundle(), &read_appimage(), e.to_string()));
    }
    applog::app(&format!("update {} installed; restarting", update.version));
    app.restart();
}

/// Download and install progress, to the window and every connected phone.
const PROGRESS_EVENT: &str = "app://update-progress";

/// Run starts refused for as long as this lives; dropped on every path that
/// does not restart.
struct Frozen(HostProcess);

/// One install attempt's hold on the slot and on run starts. Fields drop in
/// declaration order, so the freeze is lifted before the slot is released and
/// the next attempt can never have its freeze lifted by this one.
pub struct Claim<'a, T: Clone> {
    pub update: T,
    _frozen: Frozen,
    pub run_hosts: bool,
    _guard: InstallGuard<'a, T>,
}

/// Take the install slot, and only then freeze run starts and ask whether runs
/// exist. The order is the guarantee: a second press is refused by `begin`
/// before it has touched the freeze, so it cannot thaw the freeze an install in
/// flight depends on and let a run start that the install would then stop
/// unasked. Freezing and asking are one step under the host lock (see
/// `freeze_runs`), so the answer cannot go stale before the freeze lands.
pub fn claim<'a, T: Clone>(pending: &'a Slot<T>, hosts: &HostProcess) -> Result<Claim<'a, T>, &'static str> {
    let (update, guard) = pending.begin()?;
    let run_hosts = hosts.freeze_runs();
    Ok(Claim {
        update,
        _frozen: Frozen(hosts.clone()),
        run_hosts,
        _guard: guard,
    })
}

impl Drop for Frozen {
    fn drop(&mut self) {
        self.0.thaw_runs();
    }
}

/// The OS and the bundle type Tauri patched in: the half of the install
/// decision that cannot change while the app runs.
fn this_os_bundle() -> (&'static str, Option<BundleType>) {
    (std::env::consts::OS, tauri::utils::platform::bundle_type())
}

/// The refusal `update_install` gives an install that updates by download -
/// a `.deb`, a build this cannot identify, or an AppImage whose file is gone or
/// cannot be replaced - before anything is downloaded or stopped. Its own
/// function so the guard is tested, not only the table.
pub fn install_refusal((os, bundle): (&str, Option<BundleType>), appimage: &AppImageFile) -> Result<(), String> {
    match action_for(os, bundle.clone(), appimage) {
        Action::Install => Ok(()),
        Action::Download => Err(installs_as_appimage(os, bundle.as_ref())
            .then(|| appimage_problem(appimage))
            .flatten()
            .unwrap_or_else(|| "this install updates by download, from the release page".into())),
    }
}

/// What the window is told when `install()` itself fails: the AppImage
/// sentence if the file is now gone or unwritable, otherwise the plugin's own
/// words.
pub fn install_failure((os, bundle): (&str, Option<BundleType>), appimage_now: &AppImageFile, raw: String) -> String {
    installs_as_appimage(os, bundle.as_ref())
        .then(|| appimage_problem(appimage_now))
        .flatten()
        .unwrap_or(raw)
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

    fn ready() -> AppImageFile {
        AppImageFile::Ready(PathBuf::from("/home/u/Applications/Vibe-linux-x86_64.AppImage"))
    }

    #[test]
    fn a_deb_is_never_installed_and_an_unknown_install_fails_closed() {
        use BundleType::*;
        let unset = AppImageFile::Unset;
        let ok = ready();
        let cases: &[(&str, Option<BundleType>, &AppImageFile, Action)] = &[
            ("linux", Some(Deb), &unset, Action::Download),
            ("linux", Some(Deb), &ok, Action::Download),
            ("linux", Some(Rpm), &unset, Action::Download),
            ("linux", Some(AppImage), &ok, Action::Install),
            // Without `APPIMAGE` the plugin would overwrite `current_exe()`,
            // which is inside the read-only mount (#390).
            ("linux", Some(AppImage), &unset, Action::Download),
            ("linux", None, &unset, Action::Download),
            ("linux", None, &ok, Action::Install),
            ("macos", Some(App), &unset, Action::Install),
            ("macos", None, &unset, Action::Install),
            ("windows", Some(Nsis), &unset, Action::Install),
            ("windows", Some(Msi), &unset, Action::Install),
            ("windows", None, &unset, Action::Download),
        ];
        for (os, bundle, appimage, want) in cases {
            assert_eq!(action_for(os, bundle.clone(), appimage), *want, "{os} {bundle:?} {appimage:?}");
        }
    }

    #[test]
    fn an_appimage_installs_only_when_its_file_is_there_and_its_folder_is_writable() {
        let path = PathBuf::from("/home/u/wt/app/src-tauri/target/release/bundle/appimage/Vibe_1.6.1_amd64.AppImage");
        let gone = AppImageFile::Missing(path.clone());
        let locked = AppImageFile::ReadOnly(path.clone());
        for bundle in [Some(BundleType::AppImage), None] {
            assert_eq!(action_for("linux", bundle.clone(), &gone), Action::Download);
            assert_eq!(action_for("linux", bundle.clone(), &locked), Action::Download);
            assert_eq!(action_for("linux", bundle, &ready()), Action::Install);
        }
    }

    #[test]
    fn the_appimage_file_is_read_from_the_variable_and_the_two_probes() {
        let var = OsStr::new("/opt/apps/Vibe.AppImage");
        let p = PathBuf::from("/opt/apps/Vibe.AppImage");
        assert_eq!(appimage_file(None, |_| true, |_| true), AppImageFile::Unset);
        assert_eq!(appimage_file(Some(OsStr::new("")), |_| true, |_| true), AppImageFile::Unset);
        assert_eq!(appimage_file(Some(var), |_| false, |_| true), AppImageFile::Missing(p.clone()));
        // A missing file is reported as missing, whatever the folder says.
        assert_eq!(appimage_file(Some(var), |_| false, |_| false), AppImageFile::Missing(p.clone()));
        assert_eq!(appimage_file(Some(var), |_| true, |_| false), AppImageFile::ReadOnly(p.clone()));
        assert_eq!(appimage_file(Some(var), |_| true, |_| true), AppImageFile::Ready(p));
        // The folder asked about is the file's own.
        let asked = std::cell::RefCell::new(None);
        appimage_file(Some(var), |_| true, |d| {
            *asked.borrow_mut() = Some(d.to_path_buf());
            true
        });
        assert_eq!(asked.into_inner(), Some(PathBuf::from("/opt/apps")));
        // A bare name lives in the working directory.
        appimage_file(Some(OsStr::new("Vibe.AppImage")), |_| true, |d| {
            assert_eq!(d, Path::new("."));
            true
        });
    }

    #[cfg(unix)]
    #[test]
    fn the_real_probes_see_a_deleted_appimage_and_a_read_only_folder() {
        use std::os::unix::fs::PermissionsExt;
        let read = |p: &Path| {
            appimage_file(
                Some(p.as_os_str()),
                |p| std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false),
                dir_writable,
            )
        };
        let root = std::env::temp_dir().join(format!("vibe-update-390-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("Vibe.AppImage");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(read(&file), AppImageFile::Ready(file.clone()));
        // A directory at the path is not a file to overwrite.
        assert_eq!(read(&root), AppImageFile::Missing(root.clone()));

        // root (uid 0) ignores the mode, so the read-only half is only
        // meaningful for an ordinary user.
        let is_root = unsafe { libc::geteuid() } == 0;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o555)).unwrap();
        let locked = read(&file);
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        if !is_root {
            assert_eq!(locked, AppImageFile::ReadOnly(file.clone()));
        }

        // The case #390 hit: the file was deleted while the app ran.
        std::fs::remove_file(&file).unwrap();
        assert_eq!(read(&file), AppImageFile::Missing(file.clone()));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_moved_appimage_is_refused_with_a_sentence_naming_the_path() {
        let path = PathBuf::from("/home/u/wt/Vibe_1.6.1_amd64.AppImage");
        let linux_appimage = ("linux", Some(BundleType::AppImage));
        let why = install_refusal(linux_appimage.clone(), &AppImageFile::Missing(path.clone())).expect_err("refused");
        assert!(why.contains("moved or deleted"), "{why}");
        assert!(why.contains("/home/u/wt/Vibe_1.6.1_amd64.AppImage"), "{why}");
        assert!(why.contains("release page"), "{why}");
        assert!(!why.contains("os error"), "{why}");

        let why = install_refusal(("linux", None), &AppImageFile::ReadOnly(path.clone())).expect_err("refused");
        assert!(why.contains("cannot be written"), "{why}");
        assert!(why.contains("/home/u/wt/Vibe_1.6.1_amd64.AppImage"), "{why}");

        assert!(install_refusal(linux_appimage, &ready()).is_ok());
        // A `.deb` is refused for being a `.deb`, never with AppImage words,
        // even if a stray `APPIMAGE` names a missing file.
        let why = install_refusal(("linux", Some(BundleType::Deb)), &AppImageFile::Missing(path)).expect_err("refused");
        assert!(why.contains("by download"), "{why}");
    }

    #[test]
    fn an_install_that_fails_because_the_file_went_says_so_and_otherwise_passes_the_error_on() {
        let raw = "No such file or directory (os error 2)".to_string();
        let gone = AppImageFile::Missing(PathBuf::from("/tmp/x/Vibe.AppImage"));
        let said = install_failure(("linux", Some(BundleType::AppImage)), &gone, raw.clone());
        assert!(said.contains("moved or deleted") && said.contains("/tmp/x/Vibe.AppImage"), "{said}");
        assert_eq!(install_failure(("linux", Some(BundleType::AppImage)), &ready(), raw.clone()), raw);
        assert_eq!(install_failure(("windows", Some(BundleType::Nsis)), &gone, raw.clone()), raw);
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
        assert!(install_refusal(("windows", Some(BundleType::Nsis)), &AppImageFile::Unset).is_ok());
        let why = install_refusal(("linux", Some(BundleType::Deb)), &AppImageFile::Unset).expect_err("a .deb never self-updates");
        assert!(why.contains("by download"), "{why}");
        // And a deb gets that action whatever else the environment says.
        assert!(install_refusal(("linux", Some(BundleType::Deb)), &ready()).is_err());
        // An unidentified build keeps the plain sentence.
        let why = install_refusal(("windows", None), &AppImageFile::Unset).expect_err("unpatched windows");
        assert!(why.contains("by download"), "{why}");
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
