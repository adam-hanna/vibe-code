//! Where every event the window is sent is also handed to the connected phones,
//! and where a live run's frames are kept for a phone that joins late (#343).
//!
//! ## The seam, not `listen_any`
//!
//! The design said the bridge would subscribe with `app.listen_any`. It does
//! not, because in Tauri 2.11 a Rust listener is not called in emit order: the
//! listener table is taken with `try_lock`, a contended emit is parked in a
//! pending queue, and a later emit runs its own handlers before that queue is
//! drained. Two frames from one host's stdout could then reach a phone the
//! other way round from the window - which folds them through the same
//! `reduce` - and the buffer below could not promise no gap and no duplicate.
//!
//! So every event the app emits goes through [`emit`], [`emit_frame`] or
//! [`emit_exit`], and each takes **one lock** across all of it: keeping the
//! frame, queueing it for every phone, and emitting it to the window. The
//! window, the phones and the buffer therefore see one sequence. Holding the
//! lock across the window's emit is safe because nothing under it waits: a
//! phone's queue is unbounded, Tauri's emit to a webview posts and returns, and
//! no Rust listener is registered for any of these events, so nothing can call
//! back in here.
//!
//! ## The live-run buffer
//!
//! A phone that connects mid-run has missed every frame before it. The hub
//! keeps a copy of every frame each live **run** host has emitted - the bytes
//! the window was sent, parsed for nothing - in one list in emission order, so
//! the replay keeps the order between hosts as well as within one. No cap for
//! the life of the run, since a cap is a number nobody measured; a host's
//! frames go when its exit is emitted, which `host.rs` does only after the
//! host has been reaped. The service host is not kept: its frames answer
//! requests, and a phone makes its own.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::UnboundedSender;
use vibe_remote::control::{Return, REMOTE_EVENTS};

use crate::host::{Ended, Relayed, EXIT_EVENT, FRAME_EVENT, SERVICE};

/// What a phone's one writer sends, in the order it was queued: an event the
/// window was also sent - its name and the very bytes - or a call's answer.
#[derive(Clone, Debug)]
pub(crate) enum Outgoing {
    Event { name: &'static str, payload: Arc<str> },
    Return(Return),
}

#[derive(Default)]
pub(crate) struct Hub {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Every live run host's frames, in the order they were emitted.
    buffer: Vec<(String, Arc<str>)>,
    phones: Vec<(u64, UnboundedSender<Outgoing>)>,
    next_phone: u64,
}

impl State {
    /// Queue for every phone. A phone whose connection has gone has dropped
    /// its receiver, and is forgotten here.
    fn send(&mut self, name: &'static str, payload: &Arc<str>) {
        self.phones.retain(|(_, tx)| tx.send(Outgoing::Event { name, payload: payload.clone() }).is_ok());
    }
}

impl Hub {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A host's frame: kept if the host is a run host, sent to every phone,
    /// then to the window - all under the one lock.
    pub(crate) fn frame(&self, host: &str, payload: Arc<str>, window: impl FnOnce(&str)) {
        let mut state = self.state();
        if host != SERVICE {
            state.buffer.push((host.to_string(), payload.clone()));
        }
        state.send(FRAME_EVENT, &payload);
        window(&payload);
    }

    /// A host has been reaped: its frames are dropped, and its exit sent on.
    pub(crate) fn exit(&self, host: &str, payload: Arc<str>, window: impl FnOnce(&str)) {
        let mut state = self.state();
        state.buffer.retain(|(h, _)| h != host);
        state.send(EXIT_EVENT, &payload);
        window(&payload);
    }

    /// Any other event: sent to phones only if it is on the remote list.
    pub(crate) fn event(&self, name: &'static str, payload: Arc<str>, window: impl FnOnce(&str)) {
        let mut state = self.state();
        if REMOTE_EVENTS.contains(&name) {
            state.send(name, &payload);
        }
        window(&payload);
    }

    /// A phone joins: every kept frame is queued for it, then it is registered
    /// for what follows, under the same lock.
    ///
    /// **Why that is enough for no gap and no duplicate.** A frame is kept and
    /// sent to the registered phones under this lock, in one step. So every
    /// frame either took the lock before this join - and is in the buffer, so
    /// in the snapshot - or after it, and goes to the phone as a live event.
    /// There is no third case, and nothing is in both.
    pub(crate) fn join(&self, tx: UnboundedSender<Outgoing>) -> u64 {
        let mut state = self.state();
        for (_, payload) in &state.buffer {
            let _ = tx.send(Outgoing::Event { name: FRAME_EVENT, payload: payload.clone() });
        }
        state.next_phone += 1;
        let id = state.next_phone;
        state.phones.push((id, tx));
        id
    }

    pub(crate) fn leave(&self, id: u64) {
        self.state().phones.retain(|(phone, _)| *phone != id);
    }

    #[cfg(test)]
    pub(crate) fn phone_count(&self) -> usize {
        self.state().phones.len()
    }
}

fn hub(app: &AppHandle) -> Arc<Hub> {
    app.state::<super::Remote>().hub.clone()
}

fn to_json<S: Serialize>(payload: &S) -> Option<Arc<str>> {
    serde_json::to_string(payload).ok().map(Arc::from)
}

/// Emit an event to the window, and to every phone if it is a remote event.
pub(crate) fn emit<S: Serialize>(app: &AppHandle, name: &'static str, payload: &S) {
    let Some(json) = to_json(payload) else { return };
    hub(app).event(name, json, |json| {
        let _ = app.emit_str(name, json.to_string());
    });
}

/// Emit a host's frame, keeping it if the host is a run host.
pub(crate) fn emit_frame(app: &AppHandle, host: &str, frame: &Relayed) {
    let Some(json) = to_json(frame) else { return };
    hub(app).frame(host, json, |json| {
        let _ = app.emit_str(FRAME_EVENT, json.to_string());
    });
}

/// Emit a host's exit, dropping what was kept for it.
pub(crate) fn emit_exit(app: &AppHandle, host: &str, ended: &Ended) {
    let Some(json) = to_json(ended) else { return };
    hub(app).exit(host, json, |json| {
        let _ = app.emit_str(EXIT_EVENT, json.to_string());
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
    use vibe_remote::control::DESKTOP_ONLY_EVENTS;

    fn p(s: &str) -> Arc<str> {
        Arc::from(s)
    }

    fn drain(rx: &mut UnboundedReceiver<Outgoing>) -> Vec<(&'static str, String)> {
        let mut got = Vec::new();
        while let Ok(o) = rx.try_recv() {
            match o {
                Outgoing::Event { name, payload } => got.push((name, payload.to_string())),
                Outgoing::Return(_) => panic!("the hub queues events only"),
            }
        }
        got
    }

    fn frames(got: &[(&'static str, String)]) -> Vec<String> {
        got.iter().map(|(_, p)| p.clone()).collect()
    }

    #[test]
    fn a_join_gets_every_run_frame_in_emission_order_then_the_live_ones() {
        let hub = Hub::default();
        // Two run hosts interleaved, with the service host between them.
        hub.frame("run-a", p("a1"), |_| {});
        hub.frame("run-b", p("b1"), |_| {});
        hub.frame(SERVICE, p("s1"), |_| {});
        hub.frame("run-a", p("a2"), |_| {});
        let (tx, mut rx) = unbounded_channel();
        hub.join(tx);
        hub.frame(SERVICE, p("s2"), |_| {});
        hub.frame("run-b", p("b2"), |_| {});
        let got = drain(&mut rx);
        assert!(got.iter().all(|(name, _)| *name == FRAME_EVENT));
        // The service host is never kept, but its live frames are sent on: they
        // answer the phone's own requests.
        assert_eq!(frames(&got), ["a1", "b1", "a2", "s2", "b2"]);
    }

    #[test]
    fn an_exit_drops_only_that_host_s_frames_and_is_sent_on() {
        let hub = Hub::default();
        hub.frame("run-a", p("a1"), |_| {});
        hub.frame("run-b", p("b1"), |_| {});
        hub.exit("run-a", p("a-exit"), |_| {});
        let (tx, mut rx) = unbounded_channel();
        hub.join(tx);
        assert_eq!(frames(&drain(&mut rx)), ["b1"]);
        hub.exit("run-b", p("b-exit"), |_| {});
        assert_eq!(drain(&mut rx), [(EXIT_EVENT, "b-exit".to_string())]);
        let (tx, mut rx) = unbounded_channel();
        hub.join(tx);
        assert!(drain(&mut rx).is_empty(), "nothing is kept for a reaped host");
    }

    #[test]
    fn only_remote_events_reach_a_phone_and_every_event_reaches_the_window() {
        let hub = Hub::default();
        let (tx, mut rx) = unbounded_channel();
        hub.join(tx);
        let mut window = Vec::new();
        for name in ["pilot://event", "app://quit-requested", "remote://pair-request", "remote://pair-ended"] {
            hub.event(name, p(name), |json| window.push(json.to_string()));
        }
        assert_eq!(window.len(), 4, "the window is sent everything");
        let names: Vec<_> = drain(&mut rx).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, ["pilot://event", "remote://pair-request", "remote://pair-ended"]);
    }

    #[test]
    fn a_phone_that_has_gone_is_forgotten() {
        let hub = Hub::default();
        let (tx, rx) = unbounded_channel();
        hub.join(tx);
        let (tx2, _rx2) = unbounded_channel();
        let kept = hub.join(tx2);
        drop(rx);
        hub.frame("run-a", p("a1"), |_| {});
        assert_eq!(hub.phone_count(), 1);
        hub.leave(kept);
        assert_eq!(hub.phone_count(), 0);
    }

    /// Several hosts emitting at once while phones join: every phone receives
    /// exactly the window's sequence - its snapshot, then the live frames -
    /// with no gap and no duplicate.
    #[test]
    fn under_concurrent_emitters_every_phone_sees_the_window_s_sequence() {
        let hub = Arc::new(Hub::default());
        let window = Arc::new(Mutex::new(Vec::<String>::new()));
        let mut feeders = Vec::new();
        for host in 0..4 {
            let hub = hub.clone();
            let window = window.clone();
            feeders.push(std::thread::spawn(move || {
                for n in 0..500 {
                    let name = format!("run-{host}");
                    let payload = format!("{host}:{n}");
                    hub.frame(&name, p(&payload), |json| window.lock().unwrap().push(json.to_string()));
                }
            }));
        }
        let mut phones = Vec::new();
        for _ in 0..20 {
            let (tx, rx) = unbounded_channel();
            hub.join(tx);
            phones.push(rx);
            std::thread::yield_now();
        }
        for f in feeders {
            f.join().unwrap();
        }
        let window = window.lock().unwrap().clone();
        assert_eq!(window.len(), 2000);
        for mut rx in phones {
            assert_eq!(frames(&drain(&mut rx)), window, "a phone saw another order than the window");
        }
    }

    /// Every event name the desktop emits has a decision: forwarded to phones,
    /// or held on the desktop. Walks the sources rather than naming files, so
    /// a new file with a new event cannot be missed.
    #[test]
    fn every_event_the_desktop_emits_has_a_remote_decision() {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).expect("readable") {
                let path = entry.expect("entry").path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let mut files = Vec::new();
        walk(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
        let mut seen = 0;
        for file in files {
            let text = std::fs::read_to_string(&file).expect("readable");
            // Production code only: tests name events they never emit.
            let text = text.split("#[cfg(test)]").next().unwrap_or("");
            for scheme in ["host://", "pilot://", "app://", "remote://"] {
                for (at, _) in text.match_indices(&format!("\"{scheme}")) {
                    let rest = &text[at + 1..];
                    let name = &rest[..rest.find('"').expect("a closed literal")];
                    seen += 1;
                    assert!(
                        REMOTE_EVENTS.contains(&name) || DESKTOP_ONLY_EVENTS.contains(&name),
                        "{} emits {name}, which is neither in REMOTE_EVENTS nor in DESKTOP_ONLY_EVENTS",
                        file.display()
                    );
                }
            }
        }
        assert!(seen >= 7, "found only {seen} event names; the walk is broken");
    }
}
