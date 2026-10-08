//! Supervising the process that does the work.
//!
//! Everything about a run lives on the Node side. This module starts that
//! process, forwards bytes in both directions, and reports when it dies. It
//! parses **one** thing - whether a line of stdout is JSON at all - and only so
//! that a line which is not can be labelled rather than passed off as a frame.
//!
//! The rule the whole file is written to: **Rust is transport plus OS.** The
//! moment it starts deciding something about a run there are two definitions of
//! a legal run, and the argument settled in #134 reopens with a window attached.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::reaper::Reaper;

/// `DETACHED_PROCESS` — the host gets no console, and so cannot be sent a
/// console control event.
///
/// **This is a lifetime fix, not a cosmetic one.** `node.exe` is a
/// console-subsystem binary, so spawning it with no creation flags attaches it
/// to a console: the parent's if there is one, a freshly allocated one if not.
/// Whichever it lands in, tearing that console down sends `CTRL_CLOSE_EVENT` to
/// every process attached to it, and libuv delivers that to Node as **SIGHUP** —
/// which `src/ending.ts` stamps and exits `EXIT_UNRAISED` on, correctly and
/// fatally.
///
/// That is not hypothetical. A run was killed four minutes into a plan turn,
/// mid-phase, with `ending.json` reading `"how": "signal", "signal": "SIGHUP"`
/// and the window reporting `host exited with code 1`. Redirecting all three
/// streams does not prevent the allocation.
///
/// **`CREATE_NO_WINDOW` is the wrong flag and was tried first.** It suppresses
/// the console *window*; the process still holds a console and can still be sent
/// a control event. Measured with `AttachConsole` against four children spawned
/// exactly as below, all stdio piped:
///
/// | creation flags                | console? |
/// |------------------------------|----------|
/// | none                         | yes      |
/// | `CREATE_NO_WINDOW` (0x0800_0000) | yes  |
/// | `DETACHED_PROCESS` (0x0000_0008) | **no** |
/// | both                         | no       |
///
/// The two are documented as mutually exclusive — `CREATE_NO_WINDOW` is ignored
/// beside `DETACHED_PROCESS` — so this is the one flag rather than both, and
/// there is no window to hide on a process with no console to put one on.
///
/// Note what this does *not* say about `src/proc.ts`. That file passes
/// `windowsHide: true` for `claude` and `codex`, which is Node's name for
/// `CREATE_NO_WINDOW` — so those children do hold a console. That is fine and
/// is not the same bug: with the host detached each gets its own fresh,
/// window-less console rather than sharing one whose teardown would take the
/// whole run with it.
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// A line the host process wrote to stdout, on its way to the webview.
pub const FRAME_EVENT: &str = "host://frame";
/// A line the host process wrote to stderr, or a line of stdout that was not a
/// frame. Prose either way, never protocol.
pub const LOG_EVENT: &str = "host://log";
/// A host process ended. Emitted exactly once per start, after the host has left
/// the set.
pub const EXIT_EVENT: &str = "host://exit";

/// How long a quit waits for the host to leave on its own before killing it.
///
/// **A ceiling, not a wait.** The host reads a closed stdin as *the supervisor
/// has gone* and leaves at once, abandoning an in-flight run rather than
/// finishing it - `closing()` in `src/serve.ts` says why, and until #206 it
/// waited for the whole run instead, so this five seconds expired every single
/// time and the "graceful" path was the kill path in every case that mattered.
///
/// What is left is the fallback for a host that will not go: killing after this
/// is safe *because* the run is resumable, which the CLI already guarantees and
/// the app inherits unchanged. It costs the `ending.json` stamp, which is
/// exactly why the ordinary path no longer comes here.
const QUIT_GRACE: Duration = Duration::from_secs(5);

/// Strip Windows' extended-length prefix from a path.
///
/// **The bug the packaging spike found, and the reason this file has tests.**
/// `BaseDirectory::Resource` returns a verbatim path - `\\?\C:\Program
/// Files\...` - and Node refuses one as a main module, failing with `EISDIR ...
/// lstat 'C:'`. It is invisible under `tauri dev`, where resources resolve to an
/// ordinary relative path, and appears only in a built bundle. Which is why
/// nothing about resource paths may be verified from the dev server.
///
/// Only the drive-letter form is stripped. `\\?\UNC\server\share` is a genuine
/// network path whose prefix is load-bearing, and turning it into
/// `UNC\server\share` would produce something that resolves nowhere.
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path.to_path_buf();
    };
    let Some(rest) = text.strip_prefix(r"\\?\") else {
        return path.to_path_buf();
    };
    let bytes = rest.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    // Refuse rather than repair. Half-stripping a prefix nobody can classify
    // produces something that looks resolvable and is not.
    if drive {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// Which build this is (#201).
///
/// **Two builds of one version are otherwise identical**, and single-instance
/// makes that expensive: a fresh build launched while an installed copy is
/// running raises the old window and exits, so the app under test is the old
/// one and every symptom reads as the fix not working.
///
/// `commit` and `at` are `Option` because a tree with no git cannot answer, and
/// an absence is reported as one. `version` always exists - it is the crate's,
/// which `tauri.conf.json` and `Cargo.toml` agree on.
#[derive(Clone, Serialize)]
pub struct Build {
    pub version: String,
    pub commit: Option<String>,
    /// Milliseconds since the epoch, formatted by the window in the viewer's own
    /// locale rather than in the builder's.
    pub at: Option<i64>,
}

/// Read the stamp `build.rs` compiled in.
///
/// The empty string is the agreed spelling of *this tree could not say*, and it
/// becomes `None` here rather than reaching a window that would print it.
pub fn build_stamp() -> Build {
    let commit = env!("VIBE_BUILD_COMMIT");
    let at = env!("VIBE_BUILD_AT");
    Build {
        version: env!("CARGO_PKG_VERSION").to_string(),
        commit: if commit.is_empty() {
            None
        } else {
            Some(commit.to_string())
        },
        at: at.parse::<i64>().ok(),
    }
}

/// What the webview is told when it asks.
///
/// **The `ready` frame is in here because the window cannot have heard it.** The
/// host is started in `setup`, before a webview exists to listen, and Tauri
/// events emitted with no listener are simply gone. So the one frame that states
/// the protocol version is kept, and a window that missed it asks for it.
///
/// Nothing else needs the same treatment: every other frame is a consequence of
/// a request, and there are no requests before the window is up.
///
/// **The build stamp rides here rather than on a command of its own** (#201).
/// `keys.rs` pins the registered handler list precisely so a new door into this
/// process is a decision somebody makes on purpose, and this is not one: three
/// of the four facts the diagnostics panel shows already arrive on this call, so
/// they cannot disagree about which process they describe.
/// Renamed for the window's benefit, and safe to add now: every field that
/// existed before `uptime_secs` is one word, so camelCase leaves all of them
/// exactly as they were. A field added later gets the window's spelling for
/// free instead of arriving as a snake_case key nothing reads.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub pid: Option<u32>,
    /// How long the running host has been up, or null when none is. Measured
    /// from a monotonic clock on this side, so it carries no question about
    /// which process's wall clock is right.
    pub uptime_secs: Option<u64>,
    pub ready: Option<serde_json::Value>,
    /// Why there is no host, when there is none. Null while one is running.
    pub failure: Option<String>,
    /// Why a kill of this app would leave the host running, or null if it would
    /// not. Reported rather than assumed either way - see `reaper.rs`.
    pub uncontained: Option<String>,
    /// Which build the window is running in. Static; asked for with the rest.
    pub build: Build,
    /// The run hosts alive now (#246). Every field above describes the service
    /// host and nothing else; a run host is listed here until it has been
    /// reaped, so a host whose output ended but whose process has not is still
    /// shown, and still killable.
    pub runs: Vec<RunHost>,
}

/// One live run host, for the diagnostics popover (#246). The service host's
/// own facts stay in the fields above, so `Status` never describes a process
/// it does not name.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHost {
    pub handle: String,
    pub pid: u32,
    pub uptime_secs: u64,
    pub uncontained: Option<String>,
}

/// The handle of the one long-lived host that is not a run (#246): reads,
/// config writes, the pilot and commands. Every other handle is a run host,
/// named by the window when it sends the `invoke` that host exists to serve.
pub const SERVICE: &str = "service";

/// A frame, on its way to the webview, with the host that wrote it.
///
/// **The envelope is this crate's and the core never sees it** (#246). A run id
/// on the core's frames could not route a run's first frames - preflight
/// narrates before any run id exists - and the handle can, because the window
/// chose it before the host was spawned. So PROTOCOL does not move.
#[derive(Clone, Serialize)]
pub struct Relayed {
    pub host: String,
    pub frame: serde_json::Value,
}

/// A line of prose from a host: its stderr, or stdout that was not a frame.
#[derive(Clone, Serialize)]
pub struct Logged {
    pub host: String,
    pub line: String,
}

/// What the webview is told when a host ends.
#[derive(Clone, Serialize)]
pub struct Ended {
    pub host: String,
    /// The exit code, or null where the process was signalled and has none.
    /// Absent is reported as absent; a signalled process did not "exit 0".
    pub code: Option<i32>,
}

/// Where a host's output goes. The app emits Tauri events; the tests collect.
///
/// A seam rather than an `AppHandle` held by the reader threads, so the host
/// set - routing, closing, reaping - can be driven from `cargo test` against
/// real child processes with no window at all.
pub trait Relay: Send + Sync {
    fn frame(&self, host: &str, frame: serde_json::Value);
    fn log(&self, host: &str, line: String);
    fn exit(&self, host: &str, code: Option<i32>);
}

struct TauriRelay(AppHandle);

impl Relay for TauriRelay {
    fn frame(&self, host: &str, frame: serde_json::Value) {
        let _ = self.0.emit(FRAME_EVENT, Relayed { host: host.into(), frame });
    }
    fn log(&self, host: &str, line: String) {
        let _ = self.0.emit(LOG_EVENT, Logged { host: host.into(), line });
    }
    fn exit(&self, host: &str, code: Option<i32>) {
        let _ = self.0.emit(EXIT_EVENT, Ended { host: host.into(), code });
    }
}

/// The hosts that are running, by handle (#246).
///
/// **One host process per run, never two runs in one process.** `src/cancel.ts`
/// and `src/prompts.ts` hold per-process latches and `src/lock.ts` is written
/// expecting one run per process, so a second run gets a second process rather
/// than a second request to the first. The service host is the one started at
/// launch, as the single host always was; every `invoke` gets a run host of its
/// own, which serves exactly that invoke and is closed after its `result`.
#[derive(Clone)]
pub struct HostProcess {
    inner: Arc<Hosts>,
}

struct Hosts {
    hosts: Mutex<HashMap<String, Running>>,
    /// The service host's `ready`, kept for a window that was not up to hear it.
    ready: Mutex<Option<serde_json::Value>>,
    /// Why there is no service host, when there is none.
    failure: Mutex<Option<String>>,
    /// Why the service host is not contained, when it is not (#157).
    uncontained: Mutex<Option<String>>,
    /// Created on the first spawn and held for the app's lifetime, for every
    /// host alike.
    ///
    /// **Held here on purpose.** The Windows mechanism is "the kernel kills
    /// everything in the job when the last handle to it closes", so the handle's
    /// lifetime IS the guarantee. Dropping it early would kill the hosts; not
    /// holding it at all would do nothing.
    reaper: Mutex<Option<Reaper>>,
    /// How long a closed host is given to leave on its own. `QUIT_GRACE`; a field
    /// so the tests do not wait five seconds per case.
    grace: Duration,
    /// How a key is read. `keys::read` in the app; a test reads none, so it never
    /// touches the machine's keychain.
    keys: fn(crate::keys::Provider) -> Option<String>,
}

impl Default for HostProcess {
    fn default() -> Self {
        Self::with(QUIT_GRACE, |p| crate::keys::read(p).ok())
    }
}

impl HostProcess {
    fn with(grace: Duration, keys: fn(crate::keys::Provider) -> Option<String>) -> Self {
        Self {
            inner: Arc::new(Hosts {
                hosts: Mutex::default(),
                ready: Mutex::default(),
                failure: Mutex::default(),
                uncontained: Mutex::default(),
                reaper: Mutex::default(),
                grace,
                keys,
            }),
        }
    }
}

struct Running {
    child: Child,
    /// `None` once closed. Closing stdin is what `serve()` reads as the
    /// supervisor going away (#206), so dropping it is the graceful close.
    stdin: Option<ChildStdin>,
    pid: u32,
    /// When this host was spawned, on a monotonic clock (#201).
    started: Instant,
    /// What a `keys` frame must carry for the host to take it (#223). Put in
    /// the host's environment at spawn and never sent to the window, so the
    /// window - which can write frames - cannot forge one.
    secret: String,
    /// Why this host is not contained, when it is not (#157).
    uncontained: Option<String>,
    /// The id of the `invoke` this run host was started for. Its `result` is
    /// what closes the host; see `spawn`.
    invoke_id: Option<serde_json::Value>,
}

/// Whether the window may name a run host this. Refused rather than repaired: a
/// handle is echoed on every event, so it is kept to a shape that needs no
/// escaping anywhere, and it may never be the service host's own.
pub fn valid_run_handle(handle: &str) -> bool {
    !handle.is_empty()
        && handle.len() <= 64
        && handle != SERVICE
        && handle
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The id of the `invoke` a run host is started for, or why there is none.
///
/// The one field this crate reads off an inbound line, and only to know which
/// `result` ends the host. A line that is not an invoke with an id is refused
/// rather than started: a run host without one would sit waiting on stdin for a
/// request nothing is ever going to send.
fn invoke_id_of(line: Option<&str>) -> Result<serde_json::Value, String> {
    let line = line.ok_or("a run host is started with its invoke, and none was given")?;
    let request: serde_json::Value =
        serde_json::from_str(line).map_err(|_| "a run host's first line is not JSON".to_string())?;
    if request.get("type").and_then(|t| t.as_str()) != Some("invoke") {
        return Err("a run host's first line is not an invoke".into());
    }
    match request.get("id") {
        Some(id) if !id.is_null() => Ok(id.clone()),
        _ => Err("a run host's invoke carries no id".into()),
    }
}

/// The one way a host's command is built, so every host is contained alike.
///
/// The login environment first (#272), then the app's own variables so an rc
/// file cannot replace them. **A run host has `VIBE_APP_DATA` removed**, not
/// merely left unset: the variable is inherited from this process and could be
/// exported by the login shell, and a run host that saw it would adopt the
/// service host's command logs (`keepCommandLogs`) - two hosts following, and
/// able to stop, one dev server. A run uses no chats and no memory.
pub fn host_command(
    program: &Path,
    args: &[&std::ffi::OsStr],
    cwd: &Path,
    env: Vec<(String, String)>,
    secret: &str,
    app_data: Option<&Path>,
) -> Command {
    let mut command = Command::new(program);
    command.envs(env).args(args).env("VIBE_HOST_KEYS_SECRET", secret);
    match app_data {
        // Where the pilot's conversations and the window's memory are kept
        // (#223, `src/chatstore.ts`).
        Some(dir) => {
            command.env("VIBE_APP_DATA", dir);
        }
        None => {
            command.env_remove("VIBE_APP_DATA");
        }
    }
    command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // No console, so no console control event can reach it. See the constant
    // for the run this cost - and it applies to every host, not only the first.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(DETACHED_PROCESS);
    }
    command
}

/// A secret for one host's lifetime: 128 bits from the OS, through the random
/// keys every `RandomState` is seeded with - std has no other source, and this
/// guards a pipe between two of our own processes rather than anything at rest.
fn keys_secret() -> String {
    use std::hash::{BuildHasher, Hasher};
    let half = || {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(Instant::now().elapsed().as_nanos());
        h.finish()
    };
    format!("{:016x}{:016x}", half(), half())
}

/// Where the two staged pieces ended up in the bundle.
///
/// Both located through the runtime rather than assumed, because both differ
/// between a dev run and a bundle, and getting that wrong is the failure above.
fn locate(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    // The externalBin lands beside the app executable with its target triple
    // stripped - that is what makes it a *sidecar* rather than a resource, and
    // it is also what gets it the executable bit on macOS and Linux.
    let exe = std::env::current_exe().map_err(|e| format!("no current exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "the app executable has no directory".to_string())?;
    let node = strip_verbatim(&dir.join(if cfg!(windows) { "node.exe" } else { "node" }));

    let entry = app
        .path()
        .resolve(
            "host/dist/src/hostmain.js",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("no resource directory: {e}"))?;
    let entry = strip_verbatim(&entry);

    // Checked here, where both paths are still in hand and can be named. A
    // spawn failure would report only "the system cannot find the file", which
    // does not say which of the two was missing.
    if !node.exists() {
        return Err(format!("no node runtime at {}", node.display()));
    }
    if !entry.exists() {
        return Err(format!("no host entry point at {}", entry.display()));
    }
    Ok((node, entry))
}

/// Why `start` will not spawn this host, checked before anything is spawned.
///
/// One function for both roads into a start - `HostProcess::start` and the
/// `host_start` command's service branch, which goes through `launch` - so a
/// request line sent with no handle is refused rather than dropped (#246).
fn start_refusal(handle: &str, line: Option<&str>) -> Result<(), String> {
    if handle != SERVICE && !valid_run_handle(handle) {
        return Err(format!("{handle:?} is not a usable host handle"));
    }
    if handle == SERVICE && line.is_some() {
        return Err("the service host is not started with a request".into());
    }
    // A run host exists to serve one invoke, so it is not started without
    // one: refused before the spawn, not cleaned up after it.
    if handle != SERVICE {
        invoke_id_of(line)?;
    }
    Ok(())
}

impl HostProcess {
    /// Start a host and wire both of its output streams to the webview.
    ///
    /// `SERVICE` is the host started at launch; any other handle is a run host,
    /// started by the window for one `invoke` and handed it as `line`. Both are
    /// spawned by the same `host_command`, adopted by the same reaper and found
    /// by the same `locate` - containment applies to every host, not the first.
    pub fn start(&self, app: &AppHandle, handle: &str, line: Option<&str>) -> Result<u32, String> {
        start_refusal(handle, line)?;
        let (node, entry) = locate(app)?;
        // A neutral, predictable working directory. Every request carries its
        // own `-C`, so nothing depends on this - but a process inheriting
        // whatever directory the OS launched the app from is a thing that
        // behaves differently depending on how it was started, and that is worth
        // spending one line to remove.
        let cwd = app
            .path()
            .home_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        // Your terminal's environment, so the agents, the pilot and the
        // commands it runs have your `GH_TOKEN`, your ssh agent and your
        // `PATH` (#272). The values are never logged.
        let env = match crate::shellenv::login_env() {
            Ok((shell, vars)) => {
                crate::applog::app(&format!(
                    "host {handle} environment: {} variables from {shell} -l -i",
                    vars.len()
                ));
                vars
            }
            Err(why) => {
                crate::applog::app(&format!("host {handle} environment: the app's own ({why})"));
                Vec::new()
            }
        };
        let app_data = if handle == SERVICE {
            // Absent when the platform has none, and the host then refuses the
            // frames that need it by name rather than guessing a directory.
            app.path().app_data_dir().ok()
        } else {
            None
        };
        let secret = keys_secret();
        let command = host_command(
            &node,
            &[entry.as_os_str()],
            &cwd,
            env,
            &secret,
            app_data.as_deref(),
        );
        // The two paths, kept. `strip_verbatim` is the bug this resolves around,
        // and it is invisible from a dev build - so when the app is inert, what
        // the bundle actually resolved is the first thing worth being able to
        // read afterwards (#186).
        crate::applog::app(&format!(
            "host {handle} starting: {} {} (cwd {})",
            node.display(),
            entry.display(),
            cwd.display()
        ));
        self.launch_host(handle, line, command, secret, Arc::new(TauriRelay(app.clone())))
    }

    /// Spawn, then hand the new host what it needs before anything else.
    ///
    /// **Every failure after the spawn belongs to the new run host.** A run host
    /// exists to serve one invoke; if its keys or that invoke cannot be written,
    /// it is closed here and the error returned, so no host is ever left in the
    /// set waiting on stdin for a request that is never coming. The service
    /// host keeps the tolerance it always had: a key it did not receive is a key
    /// the next `key_set` sends again.
    fn launch_host(
        &self,
        handle: &str,
        line: Option<&str>,
        command: Command,
        secret: String,
        relay: Arc<dyn Relay>,
    ) -> Result<u32, String> {
        start_refusal(handle, line)?;
        let pid = self.spawn(handle, command, secret, relay)?;
        if handle == SERVICE {
            // First thing on the wire, so a run started the moment the window
            // is up is already billed the way Settings says.
            let _ = self.deliver(handle, None);
            return Ok(pid);
        }
        self.deliver_or_close(handle, line)?;
        Ok(pid)
    }

    /// `deliver`, and a run host that could not take it is closed rather than
    /// left in the set waiting for a request that is never coming.
    fn deliver_or_close(&self, handle: &str, line: Option<&str>) -> Result<(), String> {
        self.deliver(handle, line).inspect_err(|_| self.close(handle))
    }

    /// The keys, then the first request. One step, so it fails as one.
    fn deliver(&self, handle: &str, line: Option<&str>) -> Result<(), String> {
        self.send_keys(Some(handle))?;
        match line {
            Some(line) => self.send(handle, line),
            None => Ok(()),
        }
    }

    fn spawn(
        &self,
        handle: &str,
        mut command: Command,
        secret: String,
        relay: Arc<dyn Relay>,
    ) -> Result<u32, String> {
        let mut guard = self.inner.hosts.lock().map_err(|_| "host lock poisoned")?;
        // Idempotent by refusal, not by restart. Two processes under one handle
        // would be two writers the window cannot tell apart.
        if let Some(running) = guard.get(handle) {
            return Err(format!("host {handle} is already running as pid {}", running.pid));
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("could not start host {handle}: {e}"))?;
        let pid = child.id();
        crate::applog::app(&format!("host {handle} started as pid {pid}"));

        // Immediately after the spawn and before anything else touches the
        // child. There is a window between `spawn` and this in which a kill
        // would still orphan the host - it cannot be closed, because a process
        // has to exist before it can be assigned to a job - but it is
        // microseconds wide and it is the smallest this can be made (#157).
        let uncontained = {
            let mut slot = self.inner.reaper.lock().map_err(|_| "reaper lock poisoned")?;
            slot.get_or_insert_with(Reaper::new).adopt(&child)
        };
        if handle == SERVICE {
            if let Ok(mut record) = self.inner.uncontained.lock() {
                *record = uncontained.clone();
            }
        }
        // Said out loud as well as recorded. A host nothing will clean up is
        // worth a line, because the person who finds the orphan later will be
        // looking there.
        if let Some(reason) = &uncontained {
            crate::applog::app(&format!("host {handle} is not contained: {reason}"));
        }

        // A process that exists and cannot be talked to is killed here rather
        // than returned as an error and left running: nothing would ever reap
        // it, and it would hold whatever it had started on for ever.
        let (Some(stdout), Some(stderr), Some(stdin)) = (child.stdout.take(), child.stderr.take(), child.stdin.take())
        else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("host {handle} was started without all three of its streams; killed"));
        };
        guard.insert(
            handle.to_string(),
            Running {
                child,
                stdin: Some(stdin),
                pid,
                started: Instant::now(),
                secret,
                uncontained,
                invoke_id: None,
            },
        );
        drop(guard);

        // stdout: the protocol, forwarded a line at a time and uninterpreted.
        //
        // When the stream ends this thread also reaps the host and reports the
        // exit. A separate thread whose only job was to wait would be a second
        // claimant on the same child.
        let me = self.clone();
        let name = handle.to_string();
        let to_webview = Arc::clone(&relay);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                // The ONE thing this side parses, and only to label a line it
                // could not forward as a frame. A relay that interpreted a
                // message would be a second reader of the protocol, drifting
                // from the real one on the next field anybody adds.
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(frame) => {
                        let kind = frame.get("type").and_then(|t| t.as_str()).map(str::to_owned);
                        // Kept, for a window that was not up yet. See `Status`.
                        if name == SERVICE && kind.as_deref() == Some("ready") {
                            if let Ok(mut slot) = me.inner.ready.lock() {
                                *slot = Some(frame.clone());
                            }
                        }
                        let id = frame.get("id").cloned();
                        to_webview.frame(&name, frame);
                        // A run host serves one invoke, and its `result` is the
                        // end of it: closed here, through the same stdin close a
                        // quit uses (#206). Only a `result`, and only the
                        // invoke's own id - every `result` id on a run host was
                        // allocated by the window from one counter, so a
                        // pause's answer cannot be mistaken for it, where an
                        // `error`'s id may be a gate id the host allocated.
                        if name != SERVICE && kind.as_deref() == Some("result") && me.is_invoke(&name, id.as_ref()) {
                            me.close(&name);
                        }
                    }
                    // Reported, never dropped. An unparseable line on this stream
                    // is exactly the failure the stdout/stderr split exists to
                    // prevent, and dropping it is how that would go unnoticed.
                    Err(_) => {
                        let notice = format!("unparseable line on the protocol stream of host {name}: {line}");
                        crate::applog::host(&notice);
                        to_webview.log(&name, notice);
                    }
                }
            }
            // A host whose protocol stream has ended cannot be heard any more,
            // so it is closed like any other - and if the process is still
            // there after the grace, killed. It stays in the set, killable and
            // listed, until it has actually exited.
            me.close(&name);
            let code = me.reap(&name);
            crate::applog::app(&match code {
                Some(code) => format!("host {name} exited with code {code}"),
                // Not "code 0" and not a guess: on Windows a child killed from
                // outside closes without one, and that absence is the finding.
                None => format!("host {name} ended without an exit code"),
            });
            // Emitted whatever the code, and only once the host has left the
            // set, so a status read issued on this event cannot still list it.
            to_webview.exit(&name, code);
        });

        // stderr: the prose. The same sentences the CLI prints, kept as a log a
        // user can be shown when something has gone wrong.
        let name = handle.to_string();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                // Kept as well as shown. The window is the live view and it goes
                // away when the window does; a person debugging afterwards has
                // only the file (#186).
                crate::applog::host(&format!("[{name}] {line}"));
                relay.log(&name, line);
            }
        });

        Ok(pid)
    }

    fn is_invoke(&self, handle: &str, id: Option<&serde_json::Value>) -> bool {
        let Ok(guard) = self.inner.hosts.lock() else {
            return false;
        };
        match (guard.get(handle).and_then(|r| r.invoke_id.as_ref()), id) {
            (Some(invoke), Some(id)) => invoke == id,
            _ => false,
        }
    }

    /// Wait for a host whose output has ended, and only then clear it.
    ///
    /// **The entry stays until the process has exited.** Removing it first would
    /// hide a host that closed its stdout and kept running: `status()` would stop
    /// listing it and `close`'s grace kill would find nothing to kill. So this
    /// polls, taking the lock briefly and never across the sleep.
    fn reap(&self, handle: &str) -> Option<i32> {
        loop {
            {
                let Ok(mut guard) = self.inner.hosts.lock() else {
                    return None;
                };
                // Already taken by `stop`, which is the ordinary quit path.
                let running = guard.get_mut(handle)?;
                match running.child.try_wait() {
                    Ok(Some(status)) => {
                        guard.remove(handle);
                        return status.code();
                    }
                    Ok(None) => {}
                    // A status the OS will not report is not one to wait on for
                    // ever; the host is gone from what this process can manage.
                    Err(_) => {
                        guard.remove(handle);
                        return None;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Hand hosts both API keys from the keychain (#223).
    ///
    /// `Some(handle)` is the one host just spawned, and its failure is returned
    /// so the caller can close it. `None` is every host - a key changed - and is
    /// best-effort per host, so one broken pipe never stops another host getting
    /// its keys; the first failure is returned. Written straight to each host's
    /// stdin, never logged, never emitted, and an absent or unreadable key
    /// travels as null.
    pub fn send_keys(&self, only: Option<&str>) -> Result<(), String> {
        let anthropic = (self.inner.keys)(crate::keys::Provider::Anthropic);
        let openai = (self.inner.keys)(crate::keys::Provider::Openai);
        let mut guard = self.inner.hosts.lock().map_err(|_| "host lock poisoned")?;
        if let Some(handle) = only {
            if !guard.contains_key(handle) {
                return Err(format!("no host {handle} is running"));
            }
        }
        let mut first: Option<String> = None;
        for (handle, running) in guard.iter_mut() {
            if only.is_some_and(|h| h != handle) {
                continue;
            }
            let frame = serde_json::json!({
                "type": "keys",
                "secret": running.secret,
                "anthropic": anthropic,
                "openai": openai,
            });
            let sent = match running.stdin.as_mut() {
                Some(stdin) => stdin
                    .write_all(format!("{frame}\n").as_bytes())
                    .and_then(|()| stdin.flush())
                    // The error describes the pipe, never the frame.
                    .map_err(|e| format!("could not hand the keys to host {handle}: {e}")),
                None => Err(format!("host {handle} is closing")),
            };
            if let Err(why) = sent {
                first.get_or_insert(why);
            }
        }
        first.map_or(Ok(()), Err)
    }

    /// Write one line to a host's stdin.
    ///
    /// The newline is added here rather than trusted from the caller. The
    /// protocol is one object per line, and a caller that forgot would not
    /// produce a bad frame - it would produce a frame that never arrives, which
    /// is far harder to see.
    pub fn send(&self, handle: &str, line: &str) -> Result<(), String> {
        let mut guard = self.inner.hosts.lock().map_err(|_| "host lock poisoned")?;
        let running = guard
            .get_mut(handle)
            .ok_or_else(|| format!("no host {handle} is running"))?;
        // The id of the invoke this run host serves, read off the one line that
        // carries it - the same one-field read as keeping `ready`, and the only
        // thing this side learns from an inbound line.
        if handle != SERVICE && running.invoke_id.is_none() {
            if let Ok(request) = serde_json::from_str::<serde_json::Value>(line) {
                if request.get("type").and_then(|t| t.as_str()) == Some("invoke") {
                    running.invoke_id = request.get("id").cloned();
                }
            }
        }
        let stdin = running
            .stdin
            .as_mut()
            .ok_or_else(|| format!("host {handle} is closing"))?;
        stdin
            .write_all(format!("{}\n", line.trim_end_matches('\n')).as_bytes())
            .map_err(|e| format!("could not write to host {handle}: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("could not flush to host {handle}: {e}"))
    }

    /// Close one host's stdin, and kill it if it has not gone after the grace.
    ///
    /// Closing stdin is what `serve()` reads as the supervisor going away, so a
    /// run host whose invoke has returned leaves on its own and that expected
    /// exit is not an alarm. The kill is for a host that will not go. The entry
    /// is never removed here: the reader thread does that once the process has
    /// exited, so the exit code is kept and the event follows the removal.
    fn close(&self, handle: &str) {
        let pid = {
            let Ok(mut guard) = self.inner.hosts.lock() else {
                return;
            };
            let Some(running) = guard.get_mut(handle) else {
                return;
            };
            drop(running.stdin.take());
            running.pid
        };
        let me = self.clone();
        let handle = handle.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(me.inner.grace);
            let Ok(mut guard) = me.inner.hosts.lock() else {
                return;
            };
            // The same process, not merely the same handle: a service host
            // retried within the grace must not be killed for its predecessor.
            if let Some(running) = guard.get_mut(&handle).filter(|r| r.pid == pid) {
                if matches!(running.child.try_wait(), Ok(None)) {
                    crate::applog::app(&format!(
                        "host {handle} (pid {pid}) did not leave within {}s of stdin closing; killed",
                        me.inner.grace.as_secs_f32()
                    ));
                    let _ = running.child.kill();
                }
            }
        });
    }

    pub fn status(&self) -> Status {
        let ready = self.inner.ready.lock().ok().and_then(|slot| slot.clone());
        let failure = self.inner.failure.lock().ok().and_then(|slot| slot.clone());
        let uncontained = self.inner.uncontained.lock().ok().and_then(|slot| slot.clone());
        match self.inner.hosts.lock() {
            Ok(guard) => {
                let service = guard.get(SERVICE);
                let mut runs: Vec<RunHost> = guard
                    .iter()
                    .filter(|(handle, _)| handle.as_str() != SERVICE)
                    .map(|(handle, r)| RunHost {
                        handle: handle.clone(),
                        pid: r.pid,
                        uptime_secs: r.started.elapsed().as_secs(),
                        uncontained: r.uncontained.clone(),
                    })
                    .collect();
                runs.sort_by(|a, b| a.handle.cmp(&b.handle));
                Status {
                    running: service.is_some(),
                    pid: service.map(|r| r.pid),
                    uptime_secs: service.map(|r| r.started.elapsed().as_secs()),
                    ready,
                    failure,
                    uncontained,
                    build: build_stamp(),
                    runs,
                }
            }
            // A poisoned lock means a panic happened while it was held, which is
            // not the same fact as "no host is running" - so the reason says so
            // rather than the window being told a confident false.
            Err(_) => Status {
                running: false,
                pid: None,
                // Not zero. A lock nobody could read says nothing about how long
                // the host has been up, and zero would read as "just started".
                uptime_secs: None,
                ready,
                failure: Some("cannot tell: the host lock was poisoned by a panic".into()),
                uncontained,
                // Still answerable: the stamp is compiled in and needs no lock.
                build: build_stamp(),
                runs: Vec::new(),
            },
        }
    }

    /// Close every host's stdin, wait up to `QUIT_GRACE`, then kill.
    ///
    /// Every stdin is closed before any is waited on, so each host - the service
    /// host and every run - leaves at once under its own control: a run stops
    /// `HOST_EXIT_ABANDONED`, resumable, with its own `ending.json` beside its
    /// lock (#206). The kill is the fallback for a host that will not go, and
    /// reaching it is a fact worth recording rather than a normal quit.
    pub fn stop(&self) {
        let mut taken: Vec<(String, Running)> = match self.inner.hosts.lock() {
            Ok(mut guard) => guard.drain().collect(),
            Err(_) => return,
        };
        for (_, running) in taken.iter_mut() {
            drop(running.stdin.take());
        }
        let deadline = Instant::now() + self.inner.grace;
        loop {
            // Cannot tell is treated as "still there" and killed at the
            // deadline, which is the fail-closed direction: a process left
            // running is a second writer against a run directory.
            taken.retain_mut(|(_, running)| !matches!(running.child.try_wait(), Ok(Some(_))));
            if taken.is_empty() || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // Said out loud, because after #206 this is the path that should not
        // happen: the host leaving on its own is what writes the stamp, and a
        // kill writes none. Somebody looking at a run with no ending needs to be
        // able to find out here whether the quit is what did it.
        for (handle, mut running) in taken {
            crate::applog::app(&format!(
                "host {handle} (pid {}) did not leave within {}s of stdin closing; killed",
                running.pid,
                self.inner.grace.as_secs_f32()
            ));
            let _ = running.child.kill();
            let _ = running.child.wait();
        }
    }
}

/// Start the service host and remember what happened.
///
/// Called from `setup` at launch and again by the window if the first attempt
/// failed. **Not called by the window on the happy path**, and that is the
/// point: the service host is the app, so Rust owns its lifetime. Waiting to be
/// asked would mean a webview that failed to load leaves the app with no host
/// and - worse - no record of why.
pub fn launch(app: &AppHandle) -> Result<u32, String> {
    let state = app.state::<HostProcess>();
    let result = state.start(app, SERVICE, None);
    if let Ok(mut slot) = state.inner.failure.lock() {
        *slot = result.as_ref().err().cloned();
    }
    // To stderr as well as to the record. If the reason the host failed is that
    // the bundle is wrong, the window is exactly the thing that may not be able
    // to report it.
    if let Err(reason) = &result {
        crate::applog::app(&format!("host failed to start: {reason}"));
    }
    result
}

/// Start a host. No handle is the service host's retry, as it always was; a
/// handle is a run host for one `invoke`, which travels as `line` so the host is
/// never left spawned without it (#246). Extended rather than joined by a new
/// command, because `keys.test.ts` pins the list.
#[tauri::command]
pub fn host_start(app: AppHandle, handle: Option<String>, line: Option<String>) -> Result<u32, String> {
    match handle {
        None => {
            start_refusal(SERVICE, line.as_deref())?;
            launch(&app)
        }
        Some(handle) => app.state::<HostProcess>().start(&app, &handle, line.as_deref()),
    }
}

#[tauri::command]
pub fn host_send(handle: String, line: String, state: tauri::State<'_, HostProcess>) -> Result<(), String> {
    state.send(&handle, &line)
}

#[tauri::command]
pub fn host_status(state: tauri::State<'_, HostProcess>) -> Status {
    state.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serialises_the_keys_the_window_reads() {
        // The one failure mode that is silent in both directions. serde's
        // default is the Rust spelling, so `uptime_secs` would arrive at a
        // window reading `uptimeSecs` as `undefined` - which the panel would
        // render as "up for an unknown time" on a host that is up and fine.
        // Nothing goes red on either side; the number is simply always missing.
        let status = HostProcess::default().status();
        let json = serde_json::to_value(&status).expect("Status serialises");
        let object = json.as_object().expect("Status is an object");

        for key in [
            "running",
            "pid",
            "uptimeSecs",
            "ready",
            "failure",
            "uncontained",
            "build",
            "runs",
        ] {
            assert!(object.contains_key(key), "Status no longer sends {key}");
        }
        assert!(
            !object.contains_key("uptime_secs"),
            "Status is sending the Rust spelling; the window reads uptimeSecs"
        );

        // No host is running, so both of these are absences rather than zeroes.
        assert_eq!(object["pid"], serde_json::Value::Null);
        assert_eq!(object["uptimeSecs"], serde_json::Value::Null);

        let build = object["build"].as_object().expect("build is an object");
        for key in ["version", "commit", "at"] {
            assert!(build.contains_key(key), "Build no longer sends {key}");
        }
    }

    #[test]
    fn the_build_stamp_reports_an_absence_rather_than_a_placeholder() {
        // #201's whole point is that a reader can tell two builds apart, so a
        // value that cannot be established has to be visibly missing. A tree
        // with no git produces `None` here, never `"unknown"` and never `""` -
        // both of which a window would happily print beside the real fields.
        let build = build_stamp();
        assert_eq!(build.version, env!("CARGO_PKG_VERSION"));
        if let Some(commit) = &build.commit {
            assert!(!commit.is_empty(), "an empty commit must be None, not Some");
            assert!(
                commit.chars().all(|c| c.is_ascii_hexdigit()),
                "a commit that is not hex was not read from git: {commit}"
            );
        }
        // The build happened, so the clock was readable; a stamp of zero would
        // mean 1970 and is not something to report as a build time.
        assert!(build.at.is_none_or(|at| at > 0));
    }

    #[test]
    fn a_verbatim_drive_path_loses_its_prefix() {
        // The exact shape `BaseDirectory::Resource` returned in the spike, and
        // the exact shape Node refused with `EISDIR ... lstat 'C:'`.
        assert_eq!(
            strip_verbatim(Path::new(
                r"\\?\C:\Program Files\Vibe\host\dist\src\hostmain.js"
            )),
            PathBuf::from(r"C:\Program Files\Vibe\host\dist\src\hostmain.js")
        );
    }

    #[test]
    fn a_unc_path_keeps_its_prefix_because_it_needs_it() {
        // `\\?\UNC\server\share` is a real network path. Stripping it yields
        // `UNC\server\share`, which resolves nowhere - a fix that breaks the
        // case it was not written for.
        let unc = Path::new(r"\\?\UNC\build-server\share\Vibe\hostmain.js");
        assert_eq!(strip_verbatim(unc), unc.to_path_buf());
    }

    #[test]
    fn an_ordinary_path_is_left_alone() {
        for path in [
            r"C:\Users\a\vibe\hostmain.js",
            "/Applications/Vibe.app/Contents/Resources/host/dist/src/hostmain.js",
            "relative/host/dist/src/hostmain.js",
        ] {
            assert_eq!(strip_verbatim(Path::new(path)), PathBuf::from(path));
        }
    }

    #[test]
    fn a_prefix_with_nothing_usable_after_it_is_left_alone() {
        for path in [r"\\?\", r"\\?\C", r"\\?\C:", r"\\?\Volume{9f8a}\host"] {
            assert_eq!(strip_verbatim(Path::new(path)), PathBuf::from(path));
        }
    }
    // ---- the host set (#246) ------------------------------------------------
    //
    // Driven against real `node` children through `launch_host`, the same path
    // `start` takes after it has located the bundle, with a relay that collects
    // instead of emitting. Node is on PATH wherever this crate is built: the
    // sidecar it bundles is the same runtime.

    use std::ffi::OsStr;
    use std::sync::Condvar;

    #[derive(Clone, Debug, PartialEq)]
    enum Seen {
        Frame(String, serde_json::Value),
        Log(String, String),
        /// The handle, the code, and whether `status()` still listed the host
        /// at the moment its exit was relayed.
        Exit(String, Option<i32>, bool),
    }

    struct Collect {
        seen: Mutex<Vec<Seen>>,
        changed: Condvar,
        hosts: Mutex<Option<HostProcess>>,
    }

    impl Collect {
        fn new() -> Arc<Self> {
            Arc::new(Self { seen: Mutex::default(), changed: Condvar::new(), hosts: Mutex::default() })
        }
        fn push(&self, seen: Seen) {
            self.seen.lock().unwrap().push(seen);
            self.changed.notify_all();
        }
        fn wait(&self, what: &str, ready: impl Fn(&[Seen]) -> bool) -> Vec<Seen> {
            let deadline = Instant::now() + Duration::from_secs(20);
            let mut seen = self.seen.lock().unwrap();
            while !ready(&seen) {
                let left = deadline.saturating_duration_since(Instant::now());
                assert!(!left.is_zero(), "timed out waiting for {what}; saw {seen:?}");
                seen = self.changed.wait_timeout(seen, left).unwrap().0;
            }
            seen.clone()
        }
        fn exits(&self, handle: &str) -> usize {
            self.seen.lock().unwrap().iter().filter(|s| matches!(s, Seen::Exit(h, ..) if h == handle)).count()
        }
    }

    impl Relay for Collect {
        fn frame(&self, host: &str, frame: serde_json::Value) {
            self.push(Seen::Frame(host.into(), frame));
        }
        fn log(&self, host: &str, line: String) {
            self.push(Seen::Log(host.into(), line));
        }
        fn exit(&self, host: &str, code: Option<i32>) {
            let listed = self.hosts.lock().unwrap().as_ref().is_some_and(|h| {
                let status = h.status();
                if host == SERVICE {
                    status.running
                } else {
                    status.runs.iter().any(|r| r.handle == host)
                }
            });
            self.push(Seen::Exit(host.into(), code, listed));
        }
    }

    /// A host that answers like `serve()` does, without being it: `ready`, a
    /// `result` per request, an `error` for `fail`, nothing for an `invoke` until
    /// told `finish`, and gone when stdin closes.
    const ECHO: &str = r#"
        const out = (f) => process.stdout.write(JSON.stringify(f) + '\n');
        out({ type: 'ready', protocol: 1, pid: process.pid });
        const rl = require('readline').createInterface({ input: process.stdin });
        rl.on('line', (l) => {
          let m; try { m = JSON.parse(l); } catch { return; }
          if (m.type === 'keys' || m.type === 'invoke') return;
          if (m.type === 'env') return out({ type: 'env', id: m.id, appData: process.env.VIBE_APP_DATA ?? null });
          if (m.type === 'fail') return out({ type: 'error', id: m.id, message: 'refused' });
          if (m.type === 'finish') return out({ type: 'result', id: m.target, exit: 0 });
          out({ type: 'result', id: m.id, exit: 0 });
        });
        rl.on('close', () => process.exit(0));
    "#;

    fn hosts(collect: &Arc<Collect>) -> HostProcess {
        let hosts = HostProcess::with(Duration::from_millis(300), |_| None);
        *collect.hosts.lock().unwrap() = Some(hosts.clone());
        hosts
    }

    fn node(script: &str, env: Vec<(String, String)>, app_data: Option<&Path>) -> Command {
        host_command(
            Path::new("node"),
            &[OsStr::new("-e"), OsStr::new(script)],
            &std::env::temp_dir(),
            env,
            "test-secret",
            app_data,
        )
    }

    fn start(hosts: &HostProcess, collect: &Arc<Collect>, handle: &str, line: Option<&str>, script: &str) -> Result<u32, String> {
        let relay: Arc<dyn Relay> = collect.clone();
        hosts.launch_host(handle, line, node(script, Vec::new(), None), "test-secret".into(), relay)
    }

    fn has_frame(seen: &[Seen], handle: &str, kind: &str, id: i64) -> bool {
        seen.iter().any(|s| matches!(s, Seen::Frame(h, f)
            if h == handle && f["type"] == kind && f["id"] == id))
    }

    #[test]
    fn each_host_s_frames_arrive_under_its_own_handle() {
        let collect = Collect::new();
        let hosts = hosts(&collect);
        start(&hosts, &collect, SERVICE, None, ECHO).unwrap();
        start(&hosts, &collect, "run-1", Some(r#"{"type":"invoke","id":1,"argv":[]}"#), ECHO).unwrap();
        hosts.send(SERVICE, r#"{"type":"archive","id":21}"#).unwrap();
        hosts.send("run-1", r#"{"type":"pause","id":22}"#).unwrap();
        let seen = collect.wait("both answers", |s| has_frame(s, SERVICE, "result", 21) && has_frame(s, "run-1", "result", 22));
        assert!(!has_frame(&seen, "run-1", "result", 21), "the service host's answer arrived as the run's");
        assert!(!has_frame(&seen, SERVICE, "result", 22), "the run's answer arrived as the service host's");
        // The service host's ready is kept for a late window; a run host's is not.
        assert_eq!(hosts.status().ready.unwrap()["type"], "ready");
        hosts.stop();
    }

    #[test]
    fn a_run_host_closes_after_its_invoke_s_result_and_nothing_else() {
        let collect = Collect::new();
        let hosts = hosts(&collect);
        start(&hosts, &collect, SERVICE, None, ECHO).unwrap();
        start(&hosts, &collect, "run-1", Some(r#"{"type":"invoke","id":7,"argv":[]}"#), ECHO).unwrap();

        // A pause's result is not the invoke's.
        hosts.send("run-1", r#"{"type":"pause","id":8}"#).unwrap();
        collect.wait("the pause's result", |s| has_frame(s, "run-1", "result", 8));
        // An error carrying the invoke's id does not close it either.
        hosts.send("run-1", r#"{"type":"fail","id":7}"#).unwrap();
        collect.wait("the error", |s| has_frame(s, "run-1", "error", 7));
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(collect.exits("run-1"), 0);
        hosts.send("run-1", r#"{"type":"pause","id":9}"#).expect("still open after a pause and an error");

        hosts.send("run-1", r#"{"type":"finish","target":7}"#).unwrap();
        let seen = collect.wait("the run host's exit", |s| collect_exit(s, "run-1"));
        assert!(seen.contains(&Seen::Exit("run-1".into(), Some(0), false)), "{seen:?}");
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(collect.exits("run-1"), 1, "exactly one exit");
        assert_eq!(collect.exits(SERVICE), 0);
        assert!(hosts.status().runs.is_empty());
        // The service host is untouched and still answers.
        hosts.send(SERVICE, r#"{"type":"stats","id":30}"#).unwrap();
        collect.wait("the service host still answering", |s| has_frame(s, SERVICE, "result", 30));
        hosts.stop();
    }

    fn collect_exit(seen: &[Seen], handle: &str) -> bool {
        seen.iter().any(|s| matches!(s, Seen::Exit(h, ..) if h == handle))
    }

    /// Closes its own stdin, says so, and stays alive ignoring everything.
    const DEAF: &str = r#"
        require('fs').closeSync(0);
        process.stdout.write(JSON.stringify({ type: 'deaf' }) + '\n');
        setInterval(() => {}, 1000);
    "#;

    #[test]
    fn a_run_host_whose_keys_cannot_be_written_is_closed_before_its_invoke() {
        let collect = Collect::new();
        let hosts = hosts(&collect);
        let relay: Arc<dyn Relay> = collect.clone();
        hosts.spawn("run-2", node(DEAF, Vec::new(), None), "test-secret".into(), relay).unwrap();
        collect.wait("the child to close its stdin", |s| s.iter().any(|f| matches!(f, Seen::Frame(h, v) if h == "run-2" && v["type"] == "deaf")));
        let invoke = r#"{"type":"invoke","id":3,"argv":[]}"#;
        // `launch_host`'s own second step, against a host already deaf so the
        // failure is not a race with the child's start-up.
        let why = hosts.deliver_or_close("run-2", Some(invoke)).expect_err("the key write fails");
        assert!(why.contains("keys"), "it failed on the keys, before the invoke: {why}");
        let seen = collect.wait("the orphan to be killed and reaped", |s| collect_exit(s, "run-2"));
        assert!(seen.iter().any(|s| matches!(s, Seen::Exit(h, _, false) if h == "run-2")));
        assert!(hosts.status().runs.is_empty());
    }

    #[test]
    fn a_run_host_is_never_started_without_its_invoke() {
        let collect = Collect::new();
        let hosts = hosts(&collect);
        for line in [None, Some("not json"), Some(r#"{"type":"pause","id":1}"#), Some(r#"{"type":"invoke","argv":[]}"#)] {
            let started = start(&hosts, &collect, "run-10", line, ECHO);
            assert!(started.is_err(), "{line:?} started a run host");
            assert!(hosts.status().runs.is_empty(), "{line:?} left a host in the set");
        }
        // Nothing was spawned at all, so nothing ever exits.
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(collect.exits("run-10"), 0);
    }

    #[test]
    fn a_host_that_cannot_be_talked_to_is_killed_rather_than_left_running() {
        // The other post-spawn failure: the process exists and one of its
        // streams does not. It is killed and nothing is added to the set.
        let collect = Collect::new();
        let hosts = hosts(&collect);
        let mut command = node(DEAF, Vec::new(), None);
        command.stdin(Stdio::null());
        let relay: Arc<dyn Relay> = collect.clone();
        let started = hosts.launch_host("run-3", Some(r#"{"type":"invoke","id":4,"argv":[]}"#), command, "s".into(), relay);
        assert!(started.is_err(), "a host with no stdin cannot be handed its invoke");
        assert!(hosts.status().runs.is_empty());
        assert!(hosts.send("run-3", "{}").is_err());
    }

    #[test]
    fn a_host_that_closes_stdout_stays_listed_until_it_is_killed() {
        let collect = Collect::new();
        let hosts = hosts(&collect);
        let script = r#"
            process.stdout.write(JSON.stringify({ type: 'closing' }) + '\n', () => {
              require('fs').closeSync(1);
            });
            setInterval(() => {}, 1000);
        "#;
        let relay: Arc<dyn Relay> = collect.clone();
        hosts.spawn("run-4", node(script, Vec::new(), None), "s".into(), relay).unwrap();
        collect.wait("its last frame", |s| s.iter().any(|f| matches!(f, Seen::Frame(h, v) if h == "run-4" && v["type"] == "closing")));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(hosts.status().runs.len(), 1, "alive with no stdout, so still listed");
        assert_eq!(collect.exits("run-4"), 0);
        let seen = collect.wait("the grace kill", |s| collect_exit(s, "run-4"));
        assert!(seen.iter().any(|s| matches!(s, Seen::Exit(h, _, false) if h == "run-4")), "{seen:?}");
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(collect.exits("run-4"), 1);
        assert!(hosts.status().runs.is_empty());
    }

    #[test]
    fn every_spawn_is_handed_to_the_reaper() {
        let collect = Collect::new();
        let hosts = hosts(&collect);
        start(&hosts, &collect, SERVICE, None, ECHO).unwrap();
        start(&hosts, &collect, "run-5", Some(r#"{"type":"invoke","id":5,"argv":[]}"#), ECHO).unwrap();
        start(&hosts, &collect, "run-6", Some(r#"{"type":"invoke","id":6,"argv":[]}"#), ECHO).unwrap();
        let status = hosts.status();
        assert_eq!(status.runs.len(), 2);
        // Off Windows the reaper has no mechanism and says so for every host;
        // on Windows it contains every host and says nothing. Either way the
        // answer is per host, which is only true if each spawn was adopted.
        let contained = cfg!(windows);
        assert_eq!(status.uncontained.is_none(), contained);
        for run in &status.runs {
            assert_eq!(run.uncontained.is_none(), contained, "{}", run.handle);
        }
        hosts.stop();
    }

    #[test]
    fn a_run_host_never_sees_the_app_s_data_directory() {
        let data = std::env::temp_dir().join("vibe-app-data-test");
        let inherited = vec![("VIBE_APP_DATA".to_string(), "/from/the/login/shell".to_string())];

        let run = node("", inherited.clone(), None);
        assert!(
            run.get_envs().any(|(k, v)| k == "VIBE_APP_DATA" && v.is_none()),
            "a run host's command removes the variable, whatever the login env carried"
        );
        let service = node("", inherited, Some(&data));
        assert!(service.get_envs().any(|(k, v)| k == "VIBE_APP_DATA" && v == Some(data.as_os_str())));

        // And a real child: the variable as the login shell exported it, which is
        // what the app's own environment would hand down.
        let collect = Collect::new();
        let hosts = hosts(&collect);
        let relay: Arc<dyn Relay> = collect.clone();
        let login = vec![("VIBE_APP_DATA".to_string(), "/leaked".to_string())];
        hosts.spawn("run-7", node(ECHO, login.clone(), None), "s".into(), relay.clone()).unwrap();
        hosts.spawn(SERVICE, node(ECHO, login, Some(&data)), "s".into(), relay).unwrap();
        hosts.send("run-7", r#"{"type":"env","id":40}"#).unwrap();
        hosts.send(SERVICE, r#"{"type":"env","id":41}"#).unwrap();
        let seen = collect.wait("both environments", |s| has_frame(s, "run-7", "env", 40) && has_frame(s, SERVICE, "env", 41));
        for s in &seen {
            if let Seen::Frame(h, f) = s {
                if f["type"] == "env" && h == "run-7" {
                    assert_eq!(f["appData"], serde_json::Value::Null);
                }
                if f["type"] == "env" && h == SERVICE {
                    assert_eq!(f["appData"], data.to_string_lossy().as_ref());
                }
            }
        }
        hosts.stop();
    }

    #[test]
    fn a_run_handle_is_a_plain_name_and_never_the_service_host_s() {
        for bad in ["", SERVICE, "a/b", "run 1", &"x".repeat(65)] {
            assert!(!valid_run_handle(bad), "{bad:?}");
        }
        for good in ["run-12", "run_3", &"x".repeat(64)] {
            assert!(valid_run_handle(good), "{good:?}");
        }
        let collect = Collect::new();
        let hosts = hosts(&collect);
        start(&hosts, &collect, "run-8", Some(r#"{"type":"invoke","id":8,"argv":[]}"#), ECHO).unwrap();
        let again = start(&hosts, &collect, "run-8", Some(r#"{"type":"invoke","id":9,"argv":[]}"#), ECHO);
        assert!(again.is_err(), "two processes under one handle");
        hosts.stop();
    }

    #[test]
    fn a_start_is_refused_before_any_spawn_on_both_roads() {
        // The `host_start` command's no-handle road asks this too, so a line
        // sent to the service host is refused there rather than dropped.
        assert!(start_refusal(SERVICE, None).is_ok());
        assert!(start_refusal(SERVICE, Some(r#"{"type":"invoke","id":1,"argv":[]}"#)).is_err());
        assert!(start_refusal("run-1", Some(r#"{"type":"invoke","id":1,"argv":[]}"#)).is_ok());
        assert!(start_refusal("run-1", None).is_err(), "a run host with no invoke");
        assert!(start_refusal("run-1", Some(r#"{"type":"pause","id":1}"#)).is_err());
        assert!(start_refusal("a/b", Some(r#"{"type":"invoke","id":1,"argv":[]}"#)).is_err());
    }

    #[test]
    fn stop_closes_every_host_the_service_host_included() {
        let collect = Collect::new();
        let hosts = hosts(&collect);
        start(&hosts, &collect, SERVICE, None, ECHO).unwrap();
        start(&hosts, &collect, "run-9", Some(r#"{"type":"invoke","id":9,"argv":[]}"#), ECHO).unwrap();
        hosts.stop();
        let status = hosts.status();
        assert!(!status.running);
        assert!(status.runs.is_empty());
        // Both left on their own when stdin closed: the echo host exits 0 on it.
        collect.wait("both exits", |s| collect_exit(s, SERVICE) && collect_exit(s, "run-9"));
    }

    #[test]
    fn a_run_host_listed_in_status_serialises_the_window_s_spelling() {
        let run = RunHost { handle: "run-1".into(), pid: 7, uptime_secs: 3, uncontained: None };
        let json = serde_json::to_value(&run).unwrap();
        let object = json.as_object().unwrap();
        for key in ["handle", "pid", "uptimeSecs", "uncontained"] {
            assert!(object.contains_key(key), "RunHost no longer sends {key}");
        }
        assert!(!object.contains_key("uptime_secs"));
    }
}
