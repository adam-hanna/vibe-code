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
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// A line the host process wrote to stdout, on its way to the webview.
pub const FRAME_EVENT: &str = "host://frame";
/// A line the host process wrote to stderr, or a line of stdout that was not a
/// frame. Prose either way, never protocol.
pub const LOG_EVENT: &str = "host://log";
/// The host process ended. Emitted exactly once per start.
pub const EXIT_EVENT: &str = "host://exit";

/// How long a quit waits for the host to leave on its own before killing it.
///
/// Closing stdin is a request, not a guarantee: the host finishes the turn it is
/// in first, and a Claude turn can run for half an hour. Waiting that long on a
/// quit would look like a hang. Killing after this is safe *because* the run is
/// resumable - `vibe resume` picks up a killed process, which is a guarantee the
/// CLI already gives and the app inherits unchanged.
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

/// What the webview is told when the host ends.
#[derive(Clone, Serialize)]
pub struct Ended {
    /// The exit code, or null where the process was signalled and has none.
    /// Absent is reported as absent; a signalled process did not "exit 0".
    pub code: Option<i32>,
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
#[derive(Clone, Serialize)]
pub struct Status {
    pub running: bool,
    pub pid: Option<u32>,
    pub ready: Option<serde_json::Value>,
    /// Why there is no host, when there is none. Null while one is running.
    pub failure: Option<String>,
}

/// The running host, if there is one.
#[derive(Default)]
pub struct HostProcess {
    inner: Mutex<Option<Running>>,
    ready: Mutex<Option<serde_json::Value>>,
    failure: Mutex<Option<String>>,
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    pid: u32,
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

impl HostProcess {
    /// Start the host and wire both of its output streams to the webview.
    ///
    /// Idempotent by refusal, not by restart. A second host is a second writer,
    /// and `src/lock.ts` is written expecting one process per run.
    pub fn start(&self, app: &AppHandle) -> Result<u32, String> {
        let mut guard = self.inner.lock().map_err(|_| "host lock poisoned")?;
        if let Some(running) = guard.as_ref() {
            return Err(format!("the host is already running as pid {}", running.pid));
        }

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

        let mut child = Command::new(&node)
            .arg(&entry)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", node.display()))?;

        let pid = child.id();
        let stdout = child.stdout.take().ok_or("the host has no stdout")?;
        let stderr = child.stderr.take().ok_or("the host has no stderr")?;
        let stdin = child.stdin.take().ok_or("the host has no stdin")?;

        // stdout: the protocol, forwarded a line at a time and uninterpreted.
        //
        // When the stream ends the process has ended too, so this thread also
        // reaps it and reports the exit. A separate thread whose only job was to
        // wait would be a second claimant on the same child.
        let to_webview = app.clone();
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
                        // Kept, for a window that was not up yet. See `Status`.
                        if frame.get("type").and_then(|t| t.as_str()) == Some("ready") {
                            if let Ok(mut slot) = to_webview.state::<HostProcess>().ready.lock() {
                                *slot = Some(frame.clone());
                            }
                        }
                        let _ = to_webview.emit(FRAME_EVENT, frame);
                    }
                    // Reported, never dropped. An unparseable line on this stream
                    // is exactly the failure the stdout/stderr split exists to
                    // prevent, and dropping it is how that would go unnoticed.
                    Err(_) => {
                        let _ = to_webview.emit(
                            LOG_EVENT,
                            format!("unparseable line on the protocol stream: {line}"),
                        );
                    }
                }
            }
            let state = to_webview.state::<HostProcess>();
            let code = state.reap();
            // Emitted whatever the code, and emitted even for an ordinary quit.
            // A host that ends is a fact the window owns - the run is resumable
            // and the user is the one who has to be told that is what happened.
            let _ = to_webview.emit(EXIT_EVENT, Ended { code });
        });

        // stderr: the prose. The same sentences the CLI prints, kept as a log a
        // user can be shown when something has gone wrong.
        let to_log = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                let _ = to_log.emit(LOG_EVENT, line);
            }
        });

        *guard = Some(Running { child, stdin, pid });
        Ok(pid)
    }

    /// Wait for a host whose output has ended, and clear it. Returns its code.
    fn reap(&self) -> Option<i32> {
        let Ok(mut guard) = self.inner.lock() else {
            return None;
        };
        // Already taken by `stop`, which is the ordinary quit path.
        let mut running = guard.take()?;
        drop(running.stdin);
        running.child.wait().ok().and_then(|s| s.code())
    }

    /// Write one line to the host's stdin.
    ///
    /// The newline is added here rather than trusted from the caller. The
    /// protocol is one object per line, and a caller that forgot would not
    /// produce a bad frame - it would produce a frame that never arrives, which
    /// is far harder to see.
    pub fn send(&self, line: &str) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|_| "host lock poisoned")?;
        let running = guard.as_mut().ok_or("the host is not running")?;
        running
            .stdin
            .write_all(format!("{}\n", line.trim_end_matches('\n')).as_bytes())
            .map_err(|e| format!("could not write to the host: {e}"))?;
        running
            .stdin
            .flush()
            .map_err(|e| format!("could not flush to the host: {e}"))
    }

    pub fn status(&self) -> Status {
        let ready = self.ready.lock().ok().and_then(|slot| slot.clone());
        let failure = self.failure.lock().ok().and_then(|slot| slot.clone());
        match self.inner.lock() {
            Ok(guard) => Status {
                running: guard.is_some(),
                pid: guard.as_ref().map(|r| r.pid),
                ready,
                failure,
            },
            // A poisoned lock means a panic happened while it was held, which is
            // not the same fact as "no host is running" - so the reason says so
            // rather than the window being told a confident false.
            Err(_) => Status {
                running: false,
                pid: None,
                ready,
                failure: Some("cannot tell: the host lock was poisoned by a panic".into()),
            },
        }
    }

    /// Close stdin, wait `QUIT_GRACE`, then kill.
    ///
    /// Closing stdin is what `serve()` reads as a shutdown, so the host finishes
    /// the turn it is in and leaves the run resumable. The kill is the fallback
    /// for a host that will not go.
    pub fn stop(&self) {
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        let Some(mut running) = guard.take() else {
            return;
        };
        drop(running.stdin);
        let deadline = Instant::now() + QUIT_GRACE;
        loop {
            match running.child.try_wait() {
                Ok(Some(_)) => return,
                // Cannot tell. Treated as "still there" and killed at the
                // deadline, which is the fail-closed direction: a process left
                // running is a second writer against a run directory.
                Ok(None) | Err(_) => {}
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
}

/// Start the host and remember what happened.
///
/// Called from `setup` at launch and again by the window if the first attempt
/// failed. **Not called by the window on the happy path**, and that is the
/// point: the host process is the app, so Rust owns its lifetime. Waiting to be
/// asked would mean a webview that failed to load leaves the app with no host
/// and - worse - no record of why.
pub fn launch(app: &AppHandle) -> Result<u32, String> {
    let state = app.state::<HostProcess>();
    let result = state.start(app);
    if let Ok(mut slot) = state.failure.lock() {
        *slot = result.as_ref().err().cloned();
    }
    // To stderr as well as to the record. If the reason the host failed is that
    // the bundle is wrong, the window is exactly the thing that may not be able
    // to report it. A debug build has a console; a release build's stderr is
    // still capturable by whatever launched it.
    if let Err(reason) = &result {
        eprintln!("host failed to start: {reason}");
    }
    result
}

#[tauri::command]
pub fn host_start(app: AppHandle) -> Result<u32, String> {
    launch(&app)
}

#[tauri::command]
pub fn host_send(line: String, state: tauri::State<'_, HostProcess>) -> Result<(), String> {
    state.send(&line)
}

#[tauri::command]
pub fn host_status(state: tauri::State<'_, HostProcess>) -> Status {
    state.status()
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
