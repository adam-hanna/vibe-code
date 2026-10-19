//! The environment your terminal has, for a process a desktop launcher started (#272).
//!
//! A desktop launcher does not run your shell, so an app started from one has
//! none of what `~/.zshrc` sets up: no `GH_TOKEN`, so `gh` is logged out; no
//! `SSH_AUTH_SOCK`, so every `git push` reads the key off disk and asks for its
//! passphrase although an agent already holds it; and a `PATH` without nvm,
//! which is how the verify gate came to run the system's Node (#251). Every one
//! of those reaches the run's agents, the pilot and the commands it runs,
//! because they are all children of the host.
//!
//! So the host is given the **login shell's environment**, read once at start,
//! which is what VS Code does for the same reason. Running the agents *in* a
//! terminal is not the alternative it looks like: vibe reads their output over
//! pipes as structured JSON, and a terminal is a TTY with no way to hand it back.
//!
//! Three rules, each one load-bearing:
//!
//! - **Between markers.** An interactive rc file can print anything - a banner,
//!   a prompt, the clear-screen escape this machine's does - so the environment
//!   is printed between two markers with `env -0` and only that is read.
//! - **Bounded.** A slow rc file, or one waiting on input it will never get,
//!   costs at most `TIMEOUT` and then the app's own environment is used, with a
//!   line in the app log saying so. A host that never starts is worse than a
//!   host without `GH_TOKEN`.
//! - **Values are never logged.** Some are secrets - `GH_TOKEN` is the case that
//!   asked for this - so the log says how many variables came from which shell
//!   and nothing about what they were.
//! - **A session of its own** (#357). `-i` makes bash set up job control, and a
//!   bash started in the *background* of a terminal stops its whole process
//!   group with `SIGTTIN` until it is brought to the foreground. Sharing the
//!   app's group, that froze the window, every host and the run in flight, for
//!   as long as nobody typed `fg`, and `TIMEOUT` could not help because its own
//!   thread was stopped too. `setsid()` gives the shell no terminal at all, so
//!   it skips job control and still reads the rc files `-l -i` are there for.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a login shell may take to print its environment.
///
/// A choice, not a measurement: an interactive zsh with oh-my-zsh starts in
/// well under a second here, and this is the ceiling on a broken one, paid once
/// per app start.
pub const TIMEOUT: Duration = Duration::from_secs(10);

/// Brackets the environment in the shell's output. Nothing an rc file prints
/// will contain it.
const MARK: &str = "__VIBE_SHELL_ENV_c4f19a__";

/// Variables that describe the shell that printed them, not your environment.
const SKIP: &[&str] = &["PWD", "OLDPWD", "SHLVL", "_"];

/// What the login shell said, as `(name, value)` pairs, or why it did not.
#[cfg(unix)]
pub fn login_env() -> Result<(String, Vec<(String, String)>), String> {
    if std::env::var_os("VIBE_NO_SHELL_ENV").is_some_and(|v| !v.is_empty()) {
        return Err("VIBE_NO_SHELL_ENV is set".into());
    }
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(account_shell)
        .unwrap_or_else(|| "/bin/sh".into());
    let script = format!("printf '%s' '{MARK}'; env -0; printf '%s' '{MARK}'");
    let mut command = Command::new(&shell);
    command
        .args(["-l", "-i", "-c", &script])
        // No terminal and no input: an rc file that asks for something gets
        // end-of-file rather than waiting on a person who cannot see it.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    own_session(&mut command);
    let mut child = command.spawn().map_err(|e| format!("could not start {shell}: {e}"))?;

    // Read on a thread and watch for the closing marker rather than for
    // end-of-file: an rc file that starts a daemon (an ssh agent) can leave it
    // holding the pipe open long after the shell itself has exited.
    let seen = Arc::new(Mutex::new(Vec::<u8>::new()));
    let mut out = child.stdout.take().ok_or("the shell's output was not piped")?;
    let into = Arc::clone(&seen);
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        while let Ok(n) = out.read(&mut chunk) {
            if n == 0 {
                break;
            }
            if let Ok(mut buf) = into.lock() {
                buf.extend_from_slice(&chunk[..n]);
            }
        }
    });

    let deadline = Instant::now() + TIMEOUT;
    loop {
        let parsed = seen.lock().ok().and_then(|buf| parse(&buf));
        if let Some(vars) = parsed {
            let _ = child.kill();
            let _ = child.wait();
            return Ok((shell, vars));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{shell} did not print its environment within {}s", TIMEOUT.as_secs()));
        }
        if let Ok(Some(status)) = child.try_wait() {
            // Exited. One last look, since the reader may have caught up.
            std::thread::sleep(Duration::from_millis(50));
            if let Some(vars) = seen.lock().ok().and_then(|buf| parse(&buf)) {
                return Ok((shell, vars));
            }
            return Err(format!("{shell} exited ({status}) without printing its environment"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Start the child as the leader of a new session, with no controlling terminal.
///
/// Without it the shell is in the app's process group and on the app's terminal,
/// if the app was started from one, and an interactive bash in the background
/// stops that whole group (see the module header). A new session leaves it no
/// terminal to wait for, and no group of the app's to stop.
#[cfg(unix)]
fn own_session(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: the closure runs in the child between fork and exec, and calls
    // only `setsid`, which is async-signal-safe. A forked child is never a
    // process-group leader, so `setsid` cannot fail with EPERM here; if it
    // fails anyway, the spawn fails and `login_env` falls back as for any
    // shell that would not start.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// The login shell on the user's own account record, for when `SHELL` is unset.
///
/// A terminal always sets `SHELL`, and a desktop session on Linux usually does,
/// but an app launchd starts on macOS may have none, and falling straight back
/// to `/bin/sh` would read no `.zshrc` at all - the whole point lost on the
/// platform that needs this most. `getpwuid` answers from the directory service
/// on macOS and from `/etc/passwd` or NSS on Linux, which is what `login` reads.
#[cfg(unix)]
fn account_shell() -> Option<String> {
    // SAFETY: `getpwuid` returns a pointer into static storage or null; the
    // field is read and copied out at once, before any other call could reuse it.
    unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() || (*entry).pw_shell.is_null() {
            return None;
        }
        let shell = std::ffi::CStr::from_ptr((*entry).pw_shell).to_string_lossy().into_owned();
        (!shell.trim().is_empty()).then_some(shell)
    }
}

/// Windows has one environment for every process a user starts, so there is
/// nothing a shell knows that the app does not.
#[cfg(not(unix))]
pub fn login_env() -> Result<(String, Vec<(String, String)>), String> {
    Err("not needed on this platform".into())
}

/// The variables between the two markers, or None until both have arrived.
///
/// `env -0` separates entries with NUL, so a value holding a newline - a
/// multi-line exported function, a certificate - survives whole. An entry with
/// no `=` or an empty name is not an assignment and is dropped.
pub fn parse(out: &[u8]) -> Option<Vec<(String, String)>> {
    let mark = MARK.as_bytes();
    let open = find(out, mark, 0)? + mark.len();
    // The closing marker is the one straight after a NUL, since `env -0` ends
    // every entry with one - or straight after the opening marker, for an empty
    // environment. Any other occurrence is inside a value: dash exports `_` as
    // the previous command's last argument, which is the opening marker itself.
    let close = if out[open..].starts_with(mark) {
        open
    } else {
        let mut ended = Vec::with_capacity(mark.len() + 1);
        ended.push(0);
        ended.extend_from_slice(mark);
        find(out, &ended, open)? + 1
    };
    let body = &out[open..close];
    let vars = body
        .split(|b| *b == 0)
        .filter_map(|entry| {
            let entry = String::from_utf8_lossy(entry);
            let (name, value) = entry.split_once('=')?;
            if name.is_empty() || SKIP.contains(&name) {
                return None;
            }
            Some((name.to_string(), value.to_string()))
        })
        .collect();
    Some(vars)
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from > hay.len() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn framed(noise_before: &str, body: &[&str], noise_after: &str) -> Vec<u8> {
        let mut out = noise_before.as_bytes().to_vec();
        out.extend_from_slice(MARK.as_bytes());
        for entry in body {
            out.extend_from_slice(entry.as_bytes());
            out.push(0);
        }
        out.extend_from_slice(MARK.as_bytes());
        out.extend_from_slice(noise_after.as_bytes());
        out
    }

    #[test]
    fn reads_only_between_the_markers() {
        // The clear-screen escape this machine's rc prints, and a banner after.
        let out = framed("\x1b[H\x1b[Jwelcome\n", &["GH_TOKEN=abc", "SSH_AUTH_SOCK=/tmp/agent.1"], "bye\n");
        assert_eq!(
            parse(&out),
            Some(vec![
                ("GH_TOKEN".to_string(), "abc".to_string()),
                ("SSH_AUTH_SOCK".to_string(), "/tmp/agent.1".to_string()),
            ])
        );
    }

    #[test]
    fn waits_for_the_closing_marker() {
        let mut out = MARK.as_bytes().to_vec();
        out.extend_from_slice(b"PATH=/usr/bin\0");
        assert_eq!(parse(&out), None, "half an environment is not one");
        assert_eq!(parse(b"no markers at all"), None);
    }

    #[test]
    fn a_marker_inside_a_value_does_not_close_the_list() {
        // dash exports `_` as the last argument of the previous command, which
        // is the opening `printf`'s marker - so `env -0` prints `_=<marker>` in
        // the middle of the list. Closing there cut off every variable after it:
        // the first CI run, on ubuntu-22.04, got 57 of its variables and no PATH.
        let marker_value = format!("_={MARK}");
        let out = framed("", &["HOME=/home/me", &marker_value, "PATH=/usr/bin", "GH_TOKEN=abc"], "");
        assert_eq!(
            parse(&out),
            Some(vec![
                ("HOME".to_string(), "/home/me".to_string()),
                ("PATH".to_string(), "/usr/bin".to_string()),
                ("GH_TOKEN".to_string(), "abc".to_string()),
            ])
        );
        let half = framed("", &["HOME=/home/me", &marker_value], "");
        let half = &half[..half.len() - MARK.len()];
        assert_eq!(parse(half), None, "a marker inside a value is not the closing one");
    }

    #[test]
    fn an_empty_environment_still_parses() {
        assert_eq!(parse(&framed("", &[], "")), Some(vec![]));
    }

    #[test]
    fn keeps_newlines_and_equals_inside_a_value() {
        let out = framed("", &["CERT=line one\nline two", "OPTS=a=b=c"], "");
        let vars = parse(&out).unwrap();
        assert!(vars.contains(&("CERT".to_string(), "line one\nline two".to_string())));
        assert!(vars.contains(&("OPTS".to_string(), "a=b=c".to_string())));
    }

    #[test]
    fn drops_the_shells_own_variables_and_non_assignments() {
        let out = framed("", &["PWD=/home/me", "SHLVL=2", "_=/usr/bin/env", "OLDPWD=/", "noequals", "=empty", "KEEP=1"], "");
        assert_eq!(parse(&out), Some(vec![("KEEP".to_string(), "1".to_string())]));
    }

    #[cfg(unix)]
    #[test]
    fn the_account_names_a_shell_when_shell_is_unset() {
        // Whatever this machine's account says - only that it says something
        // that exists, since that is what the fallback hands to `Command`.
        let shell = account_shell().expect("the account record names a login shell");
        assert!(std::path::Path::new(&shell).exists(), "{shell} does not exist");
    }

    /// The three roles of `a_background_app_is_not_stopped_by_its_own_probe`,
    /// told apart by this variable: the test binary is run again for each.
    #[cfg(unix)]
    const ROLE: &str = "VIBE_SHELLENV_TEST_ROLE";

    /// #357, as it happened: an app started from a terminal, not the foreground
    /// job, runs the probe with bash as the login shell. Before the fix, bash
    /// stopped the app's whole process group with `SIGTTIN`.
    ///
    /// Three processes, because job control needs all three. A **leader** owns a
    /// fresh pseudo-terminal and is its foreground; a **job** is in a group of its
    /// own on that terminal, so it is in the background, as `app &` is; and the
    /// job calls `login_env`. The leader watches the job and reports whether it
    /// finished or was stopped. Each role is this test binary run again, so the
    /// probe under test is the real one.
    #[cfg(unix)]
    #[test]
    fn a_background_app_is_not_stopped_by_its_own_probe() {
        match std::env::var(ROLE).as_deref() {
            Ok("leader") => background_leader(),
            Ok("job") => background_job(),
            _ => background_orchestrate(),
        }
    }

    #[cfg(unix)]
    fn rerun(role: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().expect("the test binary"));
        command
            .args(["--exact", "shellenv::tests::a_background_app_is_not_stopped_by_its_own_probe"])
            .args(["--nocapture", "--test-threads=1"])
            .env(ROLE, role);
        command
    }

    /// The test as run by `cargo test`: open a pty and start the leader on it.
    #[cfg(unix)]
    fn background_orchestrate() {
        use std::os::fd::FromRawFd;
        use std::os::unix::process::CommandExt;
        assert!(std::path::Path::new("/bin/bash").exists(), "the case needs bash");

        let (mut master, mut slave) = (-1, -1);
        // SAFETY: openpty writes two descriptors it opened; null name, termios
        // and winsize are allowed.
        let opened = unsafe {
            libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null(), std::ptr::null())
        };
        assert_eq!(opened, 0, "openpty: {}", std::io::Error::last_os_error());
        // SAFETY: both descriptors were just opened and are owned here alone.
        let master = unsafe { std::fs::File::from_raw_fd(master) };
        let slave = unsafe { std::fs::File::from_raw_fd(slave) };

        let mut leader = rerun("leader");
        leader
            .stdin(slave.try_clone().unwrap())
            .stdout(slave.try_clone().unwrap())
            .stderr(slave.try_clone().unwrap());
        // SAFETY: setsid and ioctl are async-signal-safe. The new session takes
        // the pty, on its stdin, as its controlling terminal, which also makes
        // the leader's group the terminal's foreground.
        unsafe {
            leader.pre_exec(|| {
                if libc::setsid() == -1 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut leader = leader.spawn().expect("the leader starts");
        drop(slave);

        // Drain the terminal, so nothing the children print can fill it and
        // block them, and keep it for the failure message.
        let said = Arc::new(Mutex::new(Vec::new()));
        let into = Arc::clone(&said);
        std::thread::spawn(move || {
            let mut master = master;
            let mut chunk = [0u8; 4096];
            while let Ok(n) = master.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                into.lock().unwrap().extend_from_slice(&chunk[..n]);
            }
        });

        let deadline = Instant::now() + TIMEOUT + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = leader.try_wait().expect("the leader can be waited on") {
                break status;
            }
            if Instant::now() > deadline {
                let _ = leader.kill();
                panic!("the leader neither finished nor reported");
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let said = String::from_utf8_lossy(&said.lock().unwrap()).into_owned();
        assert!(
            status.success(),
            "the probe, run from a background job, did not finish ({status}). The pty said:\n{said}"
        );
    }

    /// The terminal's foreground: start the job in a group of its own, and say
    /// whether it was stopped.
    #[cfg(unix)]
    fn background_leader() {
        use std::os::unix::process::CommandExt;
        let home = std::env::temp_dir().join(format!("vibe-shellenv-home-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let mut job = rerun("job");
        // bash with an empty home, so no rc file on this machine decides it.
        job.env("SHELL", "/bin/bash").env("HOME", &home).env_remove("VIBE_NO_SHELL_ENV");
        // SAFETY: setpgid is async-signal-safe. Its own group, which is not the
        // terminal's foreground: a background job.
        unsafe {
            job.pre_exec(|| {
                if libc::setpgid(0, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let job = job.spawn().expect("the job starts");
        let pid = job.id() as libc::pid_t;
        let deadline = Instant::now() + TIMEOUT + Duration::from_secs(10);
        let code = loop {
            let mut status = 0;
            // SAFETY: waits on our own child; WUNTRACED reports a stop.
            let got = unsafe { libc::waitpid(pid, &mut status, libc::WUNTRACED | libc::WNOHANG) };
            if got == pid {
                if libc::WIFSTOPPED(status) {
                    println!("the job was stopped by signal {}", libc::WSTOPSIG(status));
                    // SAFETY: the job's own group, which nothing else is in.
                    unsafe { libc::killpg(pid, libc::SIGKILL) };
                    break 3;
                }
                break if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 4 };
            }
            if Instant::now() > deadline {
                println!("the job neither finished nor stopped");
                unsafe { libc::killpg(pid, libc::SIGKILL) };
                break 5;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let _ = std::fs::remove_dir_all(&home);
        std::process::exit(code);
    }

    /// The background job: run the probe, as the app does at every host start.
    #[cfg(unix)]
    fn background_job() {
        match login_env() {
            Ok((_, vars)) if !vars.is_empty() => std::process::exit(0),
            Ok(_) => {
                println!("bash printed an empty environment");
                std::process::exit(1)
            }
            Err(why) => {
                println!("the probe failed: {why}");
                std::process::exit(1)
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_real_shell_round_trips_a_variable() {
        // `sh` rather than the user's shell, so the test is about this code and
        // not about whatever this machine's rc files print.
        std::env::set_var("SHELL", "/bin/sh");
        std::env::set_var("VIBE_SHELLENV_PROBE", "it came back");
        std::env::remove_var("VIBE_NO_SHELL_ENV");
        let (shell, vars) = login_env().expect("sh prints its environment");
        assert_eq!(shell, "/bin/sh");
        // Said in full on failure: a first CI run lost the variable while the
        // framing still parsed, and a bare `contains` could not say what came
        // back instead.
        let probe = vars.iter().find(|(name, _)| name == "VIBE_SHELLENV_PROBE");
        let names: Vec<&String> = vars.iter().map(|(name, _)| name).collect();
        assert_eq!(
            probe.map(|(_, value)| value.as_str()),
            Some("it came back"),
            "{shell} returned {} variables, by name: {names:?}",
            vars.len(),
        );
    }
}
