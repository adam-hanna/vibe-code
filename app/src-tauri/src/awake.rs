//! Keep awake (#344): while the setting is on and a run host is alive, hold the
//! platform's sleep inhibitor.
//!
//! **Decided under the host-set lock, done on a thread of its own.** `host.rs`
//! decides take or release where `spawn` admits a host and `reap` removes one,
//! with [`step`]; the decision becomes a message to the one thread that owns the
//! [`Inhibitor`] and makes the OS calls in the order they were decided. On
//! Linux those calls are blocking D-Bus requests to logind and the screen
//! saver, and a stalled bus must never hold up `spawn`.
//!
//! **Idle and system sleep, never the display.** The screen may still turn
//! off; the machine does not sleep under a run.
//!
//! **A failed take never stops a run.** It is a line in `vibe-desktop.log` and
//! a sentence in the settings section, through [`AwakeReport`].
//!
//! It reads one fact about runs - whether a run host is alive - and decides
//! nothing about any of them.

use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

use serde::Serialize;

/// The OS's sleep inhibitor. The app's is [`KeepAwakeOs`]; tests record calls.
pub(crate) trait Inhibitor: Send {
    fn take(&mut self) -> Result<(), String>;
    fn release(&mut self);
}

/// The `keepawake` crate: idle and system sleep held, the display not.
#[derive(Default)]
pub(crate) struct KeepAwakeOs(Option<keepawake::KeepAwake>);

impl Inhibitor for KeepAwakeOs {
    fn take(&mut self) -> Result<(), String> {
        let held = keepawake::Builder::default()
            .display(false)
            .idle(true)
            .sleep(true)
            .reason("A vibe run is going")
            .app_name("Vibe")
            .app_reverse_domain("dev.vibecode.desktop")
            .create()
            .map_err(|e| format!("the system would not keep this machine awake: {e}"))?;
        self.0 = Some(held);
        Ok(())
    }
    fn release(&mut self) {
        // Dropping the guard is the release.
        self.0 = None;
    }
}

/// One decision, in the order it was made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Msg {
    Take,
    Release,
}

/// What the settings section says about keep awake.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwakeReport {
    /// The inhibitor is held now.
    pub held: bool,
    /// Why the last take failed, until a take succeeds.
    pub error: Option<String>,
}

/// The decision, pure: take when on, a run host is alive and nothing is held;
/// release when held and either the setting is off or no run host is left.
pub(crate) fn step(on: bool, run_hosts: usize, held: bool) -> Option<Msg> {
    if on && run_hosts > 0 && !held {
        Some(Msg::Take)
    } else if held && (!on || run_hosts == 0) {
        Some(Msg::Release)
    } else {
        None
    }
}

/// The inhibitor's thread and what it last reported.
pub(crate) struct Awake {
    tx: Mutex<Sender<Msg>>,
    report: Arc<Mutex<AwakeReport>>,
}

impl Awake {
    pub(crate) fn new(mut inhibitor: Box<dyn Inhibitor>) -> Self {
        let (tx, rx) = channel::<Msg>();
        let report = Arc::new(Mutex::new(AwakeReport::default()));
        let shared = report.clone();
        std::thread::Builder::new()
            .name("keep-awake".into())
            .spawn(move || {
                for msg in rx {
                    let mut report = shared.lock().unwrap_or_else(|p| p.into_inner());
                    match msg {
                        Msg::Take => match inhibitor.take() {
                            Ok(()) => *report = AwakeReport { held: true, error: None },
                            Err(why) => {
                                crate::applog::app(&format!("keep awake: {why}"));
                                *report = AwakeReport { held: false, error: Some(why) };
                            }
                        },
                        Msg::Release => {
                            inhibitor.release();
                            report.held = false;
                        }
                    }
                }
            })
            .expect("the keep-awake thread starts");
        Awake { tx: Mutex::new(tx), report }
    }

    /// The OS's inhibitor. Nothing is asked of the OS until the first take.
    pub(crate) fn os() -> Self {
        Self::new(Box::new(KeepAwakeOs::default()))
    }

    /// Queue a decision. Never blocks on the OS.
    pub(crate) fn send(&self, msg: Msg) {
        let tx = self.tx.lock().unwrap_or_else(|p| p.into_inner());
        let _ = tx.send(msg);
    }

    pub(crate) fn report(&self) -> AwakeReport {
        self.report.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::thread::ThreadId;
    use std::time::{Duration, Instant};

    /// Every call, with the thread it was made on.
    #[derive(Clone, Default)]
    pub(crate) struct Recorder {
        pub(crate) calls: Arc<Mutex<Vec<(&'static str, ThreadId)>>>,
        pub(crate) fail: bool,
    }

    impl Recorder {
        pub(crate) fn names(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().iter().map(|(n, _)| *n).collect()
        }
        /// Wait for the thread to have made `n` calls.
        pub(crate) fn wait_for(&self, n: usize) -> Vec<&'static str> {
            let deadline = Instant::now() + Duration::from_secs(10);
            while self.calls.lock().unwrap().len() < n {
                assert!(Instant::now() < deadline, "only {:?} after waiting for {n}", self.names());
                std::thread::sleep(Duration::from_millis(5));
            }
            self.names()
        }
    }

    impl Inhibitor for Recorder {
        fn take(&mut self) -> Result<(), String> {
            self.calls.lock().unwrap().push(("take", std::thread::current().id()));
            if self.fail {
                Err("logind is not answering".into())
            } else {
                Ok(())
            }
        }
        fn release(&mut self) {
            self.calls.lock().unwrap().push(("release", std::thread::current().id()));
        }
    }

    #[test]
    fn the_decision() {
        assert_eq!(step(true, 1, false), Some(Msg::Take));
        assert_eq!(step(true, 2, true), None);
        assert_eq!(step(true, 0, true), Some(Msg::Release));
        assert_eq!(step(false, 3, true), Some(Msg::Release));
        assert_eq!(step(false, 3, false), None);
        assert_eq!(step(true, 0, false), None);
    }

    #[test]
    fn calls_happen_on_the_inhibitor_thread_in_order() {
        let rec = Recorder::default();
        let awake = Awake::new(Box::new(rec.clone()));
        for msg in [Msg::Take, Msg::Release, Msg::Take, Msg::Release] {
            awake.send(msg);
        }
        assert_eq!(rec.wait_for(4), ["take", "release", "take", "release"]);
        let me = std::thread::current().id();
        assert!(rec.calls.lock().unwrap().iter().all(|(_, t)| *t != me));
    }

    #[test]
    fn a_failed_take_is_reported_and_cleared_by_the_next_success() {
        let rec = Recorder { fail: true, ..Recorder::default() };
        let awake = Awake::new(Box::new(rec.clone()));
        awake.send(Msg::Take);
        rec.wait_for(1);
        let deadline = Instant::now() + Duration::from_secs(5);
        while awake.report().error.is_none() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(awake.report(), AwakeReport { held: false, error: Some("logind is not answering".into()) });
    }
}
