use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// The file `npm run stage:sidecar` writes, read here. Gitignored.
const STAMP: &str = ".build-stamp";

/// Stamp the build with what it is, then hand over to Tauri (#201).
///
/// **Two builds of one version are otherwise identical**, and single-instance
/// makes that expensive: launching a fresh build while an installed copy is
/// running raises the old window and exits, so the app under test is the old one
/// and every symptom reads as the fix not working. It has cost a test cycle here
/// once already.
///
/// ## Where the stamp comes from, and why not an env var
///
/// `stage:sidecar` runs inside `beforeBuildCommand`, in a child process, so
/// anything it exports dies with it - it cannot hand cargo an env var. It writes
/// a file instead, and `rerun-if-changed` on that file is what makes this rerun.
///
/// That is not a workaround, it is the accurate trigger. Cargo rebuilds when
/// *Rust* changes; the thing that usually changes here is the **webview**, and
/// cargo cannot see it. Without this, a bundle built from new web assets and
/// unchanged Rust would carry the previous stamp - which is exactly the stale
/// build #201 is about, reintroduced by the mechanism meant to reveal it.
///
/// The file carries a fresh timestamp every time it is written, so it always
/// differs and this always reruns on `npm run app:build`.
///
/// ## What it does when it cannot answer
///
/// An ordinary `cargo build` writes no file, so this falls back to asking git,
/// and a tree with no git answers nothing at all. The variables are set to the
/// empty string and `build_stamp` in `host.rs` turns that into an absence -
/// never `unknown`, never a zero hash, never anything a reader could take for a
/// real value. That is the repo's standing rule and it is the whole point here:
/// a build that cannot say which one it is must say *that*.
fn main() {
    println!("cargo:rerun-if-changed={STAMP}");

    let written = std::fs::read_to_string(STAMP).ok();
    let mut lines = written.iter().flat_map(|text| text.lines());
    let commit = lines
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(git_commit)
        .unwrap_or_default();
    let at = lines
        .next()
        .and_then(|line| line.trim().parse::<u128>().ok())
        .or_else(now_millis)
        .map(|ms| ms.to_string())
        .unwrap_or_default();

    println!("cargo:rustc-env=VIBE_BUILD_COMMIT={commit}");
    // Milliseconds since the epoch, formatted by the window in the viewer's own
    // locale. A string formatted here would be formatted in the *builder's*.
    println!("cargo:rustc-env=VIBE_BUILD_AT={at}");

    tauri_build::build()
}

fn now_millis() -> Option<u128> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis())
}

/// The short commit, or `None` if this tree cannot answer.
///
/// Never a partial answer: a failed invocation, a non-zero exit and unparseable
/// output all become `None`, because a caller cannot tell a bad hash from a good
/// one and would print whatever it was handed.
fn git_commit() -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--short=7", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    let short = text.trim();
    if short.is_empty() || !short.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(short.to_string())
}
