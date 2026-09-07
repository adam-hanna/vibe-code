//! The app's own prose, and where it goes when there is no console to take it.
//!
//! A release build is `windows_subsystem = "windows"` - no console - so every
//! `eprintln!` this crate makes is written to a handle nothing is reading. That
//! is precisely the state in which the app is hardest to debug: the window
//! opens, nothing invokes, and the two sentences that would say why are gone.
//! `transcript.log` does not cover it either, because `attachTranscript` happens
//! once a *run* exists and everything here happens before one does.
//!
//! So the same lines are also appended to a file. Four rules travel with it, and
//! none of them is incidental:
//!
//! - **Prose, never protocol.** A frame is not written here. What lands here is
//!   the host's stderr, this crate's own sentences, and a line of the host's
//!   stdout that could not be parsed as a frame - which is prose by virtue of
//!   having failed. The stdout/stderr split is the whole reason the host works
//!   at all, and a log that blurred it would be the same defect one layer up.
//! - **Nothing from the pilot.** A vendor's error message can quote the API key
//!   it was sent - OpenAI's 401 does, in full - and `redact` handles that on the
//!   way to the window. A file is a second destination and a durable one, so the
//!   pilot's stream does not come here at all. One less place a key can be, and
//!   an absence is a stronger guarantee than a second redaction.
//! - **Appended, never rotated.** A run's worth of host stderr is the few hundred
//!   lines the CLI prints to a terminal. A cap needs a size or an age, there is
//!   no measurement here to choose one from, and #130 already settled what this
//!   repo does when a retention rule would have to be invented: say what is there
//!   and delete nothing. The growth is unbounded and this sentence is the notice.
//! - **A failure to log is never a failure to run.** Every write is best-effort,
//!   for the reason `log.ts` gives about its own transcript: the only channel
//!   available to report a broken log is the one that just broke.

use std::fs::{create_dir_all, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Manager};

/// The open file, or the fact that there is not one. Set once per process.
static SINK: OnceLock<Option<Sink>> = OnceLock::new();

struct Sink {
    path: PathBuf,
    file: Mutex<File>,
}

impl Sink {
    /// Open the log inside `dir`, creating the directory if it is not there.
    ///
    /// Takes a path rather than an `AppHandle` so it can be tested: resolving
    /// where the log belongs and writing to it are two different jobs, and only
    /// the first one needs a running Tauri app.
    fn open_at(dir: &Path) -> Option<Sink> {
        create_dir_all(dir).ok()?;
        let path = dir.join(LOG_NAME);
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()?;
        Some(Sink {
            path,
            file: Mutex::new(file),
        })
    }

    /// One line, flushed.
    ///
    /// Flushed per line rather than buffered, because the lines that matter most
    /// are the last ones before a crash - and a buffer is exactly what loses
    /// those. The volume does not justify doing anything cleverer.
    fn write(&self, tag: &str, line: &str) {
        let Ok(mut file) = self.file.lock() else {
            return;
        };
        let _ = writeln!(file, "[{}] {tag}  {line}", stamp());
        let _ = file.flush();
    }
}

const LOG_NAME: &str = "vibe-desktop.log";

/// Open the log beside the app's other data, and report where it went.
///
/// `None` means there is nowhere to write - an unresolvable log directory or a
/// file that would not open. The app runs exactly as it would have; the caller
/// is expected to say so on stderr, which is all there was before this existed.
pub fn open(app: &AppHandle) -> Option<PathBuf> {
    SINK.get_or_init(|| {
        let dir = app.path().app_log_dir().ok()?;
        Sink::open_at(&dir)
    })
    .as_ref()
    .map(|sink| sink.path.clone())
}

/// Where the log is, once it has been opened.
pub fn path() -> Option<PathBuf> {
    SINK.get().and_then(|s| s.as_ref()).map(|s| s.path.clone())
}

/// This crate's own sentence: said on stderr **and** kept.
///
/// Both, in that order, for the reason `log.ts` gives about the same pair - a
/// debug build has a console and it is worth having, and the file is the durable
/// copy for the build that does not.
pub fn app(line: &str) {
    eprintln!("{line}");
    keep("app ", line);
}

/// A line the host wrote, kept but not re-printed.
///
/// The window is already being shown these; stderr would be a third copy of the
/// same sentence in a debug build, interleaved with the host's own.
pub fn host(line: &str) {
    keep("host", line);
}

fn keep(tag: &str, line: &str) {
    if let Some(Some(sink)) = SINK.get() {
        sink.write(tag, line);
    }
}

/// The same shape `transcript.log` stamps its lines with, so the two can be read
/// against each other when a run is what went wrong.
fn stamp() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::read_to_string;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vibe-applog-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn opening_creates_the_directory_and_the_file() {
        let dir = scratch("create");
        let sink = Sink::open_at(&dir).expect("the log should open under a fresh directory");
        assert_eq!(sink.path, dir.join(LOG_NAME));
        assert!(sink.path.exists());
    }

    #[test]
    fn every_line_is_tagged_stamped_and_on_disk_immediately() {
        let dir = scratch("write");
        let sink = Sink::open_at(&dir).expect("open");
        sink.write("app ", "host failed to start: no node runtime");
        // Read back before anything is dropped: the claim is that a line is on
        // disk the moment it is written, which is what makes the last lines
        // before a crash worth having.
        let text = read_to_string(&sink.path).expect("read");
        assert!(text.contains("app "), "the source of the line is tagged");
        assert!(text.contains("host failed to start: no node runtime"));
        assert!(text.ends_with('\n'), "one line per line");
    }

    #[test]
    fn a_second_open_appends_rather_than_truncating() {
        let dir = scratch("append");
        Sink::open_at(&dir).expect("first").write("app ", "first launch");
        Sink::open_at(&dir).expect("second").write("app ", "second launch");

        let text = read_to_string(dir.join(LOG_NAME)).expect("read");
        assert!(text.contains("first launch"), "the earlier session survived");
        assert!(text.contains("second launch"));
    }

    #[test]
    fn the_stamp_is_the_shape_transcript_log_uses() {
        // Not a fixed instant - that is the wall-clock fixture this repo has a
        // rule about. The claim is the shape, which is what makes the app log and
        // a run's transcript readable side by side.
        let s = stamp();
        assert_eq!(s.len(), 24, "YYYY-MM-DDTHH:MM:SS.mmmZ, got {s}");
        assert!(s.ends_with('Z'));
        assert_eq!(s.as_bytes()[10], b'T');
    }
}
