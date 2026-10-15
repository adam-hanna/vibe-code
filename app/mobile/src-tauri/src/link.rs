//! The iroh connection to a paired desktop (#346): the third [`Desktop`].
//!
//! A thin wrapper over `vibe_remote::client`, which holds the dialling, the
//! pairing exchange, the control stream and the reading of a close. What is
//! here is what belongs to a phone: one endpoint, the paired list, keeping the
//! open desktop connected, and saying so to the webview.
//!
//! ## Staying connected
//!
//! One loop per open desktop, [`drive`]: dial, serve the connection until it
//! ends, wait, dial again. **It checks the desktop is still paired and still
//! the one open before every dial**, and re-reads its entry each time, so a
//! relay hint replaced by the last connection is the one used next. The wait is
//! [`retry_after`]'s backoff, cut short by a poke: the app coming to the
//! foreground, or the OS saying the network changed - each of which also calls
//! `endpoint.network_change()`, the mobile hint iroh asks for. A close the
//! desktop explained (`NOT_PAIRED`, `VERSION_MISMATCH`, `REMOTE_OFF`) waits for
//! a poke only: dialling again on a timer would get the same answer.
//!
//! ## The replay barrier
//!
//! The desktop replays every live run's frames to a phone that joins, on every
//! connection. The webview has to start its live runs from nothing before that
//! replay is folded, or a reconnect draws doubled turns. So each connection has
//! a **generation**, and its events are held in an [`EventGate`] from the
//! `Welcome` until the webview says it is ready for that generation
//! (`phone_release`). `phone://connected` carries the generation and nothing
//! else.

// A mock build answers from a recording and never dials.
#![cfg_attr(feature = "mock-desktop", allow(dead_code))]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use iroh_base::SecretKey;
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Notify, OnceCell};
use vibe_remote::client::{self, retry_after, Client, Net, PathKind, Probe, Reason, Session, Timeouts};
use vibe_remote::control::{Hello, REMOTE_EVENTS, REMOTE_PROTOCOL};
use vibe_remote::paired::PairedList;
use vibe_remote::wire::PairPayload;

use crate::desktop::{Answer, Desktop, Later, UNCONNECTED};
use crate::pairing::{pair_flow, PairCode, PairSlot, Real};

/// Held events for one connection, until the webview is ready for them.
#[derive(Debug, Default)]
pub struct EventGate {
    generation: u64,
    held: Vec<(String, Box<RawValue>)>,
    open: bool,
    closed: bool,
}

impl EventGate {
    /// A new connection: hold everything until it is released.
    pub fn reset(&mut self, generation: u64) {
        *self = EventGate { generation, ..EventGate::default() };
    }

    /// An event from connection `generation`. Returned when it is to be
    /// emitted now; held while the gate is shut; dropped when it belongs to
    /// another connection or this one has closed.
    pub fn push(&mut self, generation: u64, name: String, payload: Box<RawValue>) -> Option<(String, Box<RawValue>)> {
        if generation != self.generation || self.closed {
            return None;
        }
        if self.open {
            return Some((name, payload));
        }
        self.held.push((name, payload));
        None
    }

    /// The webview is ready for `generation`: what was held, in order. A
    /// release for any other generation, or after a close, releases nothing.
    pub fn release(&mut self, generation: u64) -> Vec<(String, Box<RawValue>)> {
        if generation != self.generation || self.closed {
            return Vec::new();
        }
        self.open = true;
        std::mem::take(&mut self.held)
    }

    /// Connection `generation` ended: nothing more of it is forwarded.
    pub fn close(&mut self, generation: u64) {
        if generation == self.generation {
            self.closed = true;
            self.held.clear();
        }
    }
}

/// Whether the phone passes an event on: the desktop's forwarded list only.
pub fn forwarded(name: &str) -> bool {
    REMOTE_EVENTS.contains(&name)
}

/// The phone's `Hello`. `app_version` is `package_info().version`, the app's
/// own version, which is what the desktop compares; never this crate's.
pub fn hello_for(app_version: &str, phone_name: &str) -> Hello {
    Hello { remote_protocol: REMOTE_PROTOCOL, app_version: app_version.into(), phone_name: phone_name.into() }
}

/// A close the desktop explained: dialling again on a timer would get the
/// same answer, so the loop waits for a poke.
pub fn terminal(reason: &Reason) -> bool {
    matches!(reason, Reason::NotPaired | Reason::VersionMismatch { .. } | Reason::RemoteOff)
}

/// What the OS last said about the network, and what wakes the loop.
#[derive(Debug)]
pub struct NetState {
    online: AtomicBool,
    pokes: AtomicU64,
    wake: Notify,
}

impl Default for NetState {
    fn default() -> Self {
        // Online until the webview says otherwise: `networkSignals` sends the
        // OS's word as soon as the app boots.
        NetState { online: AtomicBool::new(true), pokes: AtomicU64::new(0), wake: Notify::new() }
    }
}

impl NetState {
    pub fn online(&self) -> bool {
        self.online.load(Ordering::SeqCst)
    }

    /// The OS said something about the network. **Always a poke**, whether or
    /// not `online` moved: a Wi-Fi to cellular handover is online both sides.
    pub fn changed(&self, online: Option<bool>) {
        if let Some(online) = online {
            self.online.store(online, Ordering::SeqCst);
        }
        self.poke();
    }

    pub fn poke(&self) {
        self.pokes.fetch_add(1, Ordering::SeqCst);
        // A stored permit: a poke during a dial ends the next wait at once.
        self.wake.notify_one();
    }

    #[cfg(test)]
    pub fn pokes(&self) -> u64 {
        self.pokes.load(Ordering::SeqCst)
    }

    /// The loop's wait after an attempt that ended with `reason`.
    pub async fn wait(&self, reason: &Reason, failures: u32) {
        if terminal(reason) {
            self.wake.notified().await;
        } else {
            tokio::select! {
                () = tokio::time::sleep(retry_after(failures)) => {}
                () = self.wake.notified() => {}
            }
        }
    }
}

/// One dial and the connection it served, if any.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ran {
    /// A `Welcome` arrived: the backoff starts again.
    pub connected: bool,
    pub reason: Reason,
}

/// The reconnect loop: dial while the desktop is still paired and open,
/// waiting between attempts.
pub async fn drive<D, DF, W, WF>(still_paired: impl Fn() -> bool, mut dial: D, mut wait: W)
where
    D: FnMut() -> DF,
    DF: std::future::Future<Output = Ran>,
    W: FnMut(Reason, u32) -> WF,
    WF: std::future::Future<Output = ()>,
{
    let mut failures = 0u32;
    loop {
        if !still_paired() {
            return;
        }
        let ran = dial().await;
        if ran.connected {
            failures = 0;
        }
        wait(ran.reason, failures).await;
        if !ran.connected {
            failures = failures.saturating_add(1);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Idle,
    Connecting,
    Up,
    Down,
}

/// How a desktop that is not the open one was last found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
enum Reach {
    Checking,
    Reachable,
    Down { reason: Reason },
}

struct LinkState {
    target: Option<String>,
    session: Option<Arc<Session>>,
    generation: u64,
    phase: Phase,
    reason: Option<Reason>,
    path: PathKind,
    connect_ms: Option<u64>,
    gate: EventGate,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    probes: HashMap<String, Reach>,
}

impl Default for LinkState {
    fn default() -> Self {
        LinkState {
            target: None,
            session: None,
            generation: 0,
            phase: Phase::Idle,
            reason: None,
            path: PathKind::None,
            connect_ms: None,
            gate: EventGate::default(),
            task: None,
            probes: HashMap::new(),
        }
    }
}

struct Inner {
    app: AppHandle,
    key: SecretKey,
    client: OnceCell<Result<Client, String>>,
    list: Arc<PairedList>,
    app_version: String,
    name: Arc<dyn Fn() -> String + Send + Sync>,
    net: Arc<NetState>,
    generation: AtomicU64,
    state: Mutex<LinkState>,
    pairing: Mutex<PairSlot>,
}

/// The phone's link to its desktops.
#[derive(Clone)]
pub struct Link(Arc<Inner>);

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn path_word(path: PathKind) -> &'static str {
    match path {
        PathKind::Direct => "direct",
        PathKind::Relayed => "relayed",
        PathKind::None => "none",
    }
}

impl Link {
    pub fn new(
        app: AppHandle,
        key: SecretKey,
        list: Arc<PairedList>,
        app_version: String,
        name: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        Link(Arc::new(Inner {
            app,
            key,
            client: OnceCell::new(),
            list,
            app_version,
            name,
            net: Arc::new(NetState::default()),
            generation: AtomicU64::new(0),
            state: Mutex::new(LinkState::default()),
            pairing: Mutex::new(PairSlot::default()),
        }))
    }
}

impl Inner {
    fn state(&self) -> std::sync::MutexGuard<'_, LinkState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn emit<S: Serialize + Clone>(&self, name: &str, payload: S) {
        if let Err(e) = self.app.emit(name, payload) {
            log::warn!("vibe-mobile: could not emit {name}: {e}");
        }
    }

    /// Something a Desktops row reads changed: the webview re-reads.
    fn changed(&self) {
        self.emit("phone://link", ());
    }

    /// The endpoint, bound on first use: n0's preset and mDNS, exactly as the
    /// desktop reaches the internet (`vibe_remote::reach`).
    async fn client(&self) -> Result<&Client, String> {
        let made = self
            .client
            .get_or_init(|| async {
                let ep = vibe_remote::reach::internet(None, true)
                    .secret_key(self.key.clone())
                    .bind()
                    .await
                    .map_err(|e| format!("this phone's network endpoint could not start: {e}"))?;
                let relays = vibe_remote::reach::relays(None);
                let net = self.net.clone();
                let reading = ep.clone();
                let reader: client::NetReader = Arc::new(move || Net::of(&reading, net.online(), relays.clone()));
                Ok(Client::new(ep, reader, Timeouts::default()))
            })
            .await;
        made.as_ref().map_err(Clone::clone)
    }

    fn hello(&self) -> Hello {
        hello_for(&self.app_version, &(self.name)())
    }

    fn is_target(&self, id: &str) -> bool {
        self.state().target.as_deref() == Some(id)
    }

    /// End the open desktop's loop and connection.
    fn stop_loop(&self) {
        let mut st = self.state();
        if let Some(task) = st.task.take() {
            task.abort();
        }
        let generation = st.generation;
        st.gate.close(generation);
        st.session = None;
        st.target = None;
        st.phase = Phase::Idle;
        st.reason = None;
        st.path = PathKind::None;
        st.connect_ms = None;
    }

    fn down(&self, reason: Reason) {
        {
            let mut st = self.state();
            st.phase = Phase::Down;
            st.reason = Some(reason);
            st.path = PathKind::None;
        }
        self.changed();
    }

    /// One attempt: dial, and serve the connection until it ends.
    async fn attempt(self: &Arc<Self>, id: &str, first: &Mutex<Option<oneshot::Sender<Result<u64, Reason>>>>) -> Ran {
        let tell = |r: Result<u64, Reason>| {
            if let Some(tx) = first.lock().unwrap_or_else(|p| p.into_inner()).take() {
                let _ = tx.send(r);
            }
        };
        let failed = |reason: Reason| {
            self.down(reason.clone());
            tell(Err(reason.clone()));
            Ran { connected: false, reason }
        };
        let client = match self.client().await {
            Ok(c) => c,
            Err(why) => {
                log::error!("vibe-mobile: {why}");
                return failed(Reason::Unreachable);
            }
        };
        // Re-read every attempt: the last connection may have replaced the hint.
        let entry = match self.list.get(id) {
            Ok(Some(entry)) => entry,
            _ => return failed(Reason::Unreachable),
        };
        {
            let mut st = self.state();
            st.phase = Phase::Connecting;
        }
        self.changed();
        let started = Instant::now();
        let session = match client::connect(client, &entry, self.hello()).await {
            Ok(s) => Arc::new(s),
            Err(reason) => {
                log::info!("vibe-mobile: could not reach {id}: {reason:?}");
                return failed(reason);
            }
        };
        let ms = started.elapsed().as_millis() as u64;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut events = session.events();
        {
            let mut st = self.state();
            st.session = Some(session.clone());
            st.generation = generation;
            st.phase = Phase::Up;
            st.reason = None;
            st.connect_ms = Some(ms);
            st.path = session.path();
            st.gate.reset(generation);
        }
        if let Err(why) = self.list.seen(id, now()).and_then(|_| self.list.set_relay(id, session.relay())) {
            log::warn!("vibe-mobile: {why}");
        }
        log::info!("vibe-mobile: connected to {id} in {ms} ms");
        // The first path measurement, in the same form as every change after it.
        log::info!("vibe-mobile: path to {id} is now {} after {ms} ms", path_word(session.path()));
        self.emit("phone://connected", json!({ "generation": generation }));
        self.changed();
        tell(Ok(generation));

        let forward = async {
            if let Some(events) = events.as_mut() {
                while let Some(event) = events.recv().await {
                    if !forwarded(&event.name) {
                        continue;
                    }
                    // Emitted under the lock, so a release draining the held
                    // events and a new one arriving cannot cross.
                    {
                        let mut st = self.state();
                        if let Some((name, payload)) = st.gate.push(generation, event.name, event.payload) {
                            self.emit(&name, &*payload);
                        }
                    }
                }
            }
            std::future::pending::<()>().await;
        };
        let paths = async {
            let mut last = session.path();
            loop {
                let next = session.path_changed(last).await;
                log::info!(
                    "vibe-mobile: path to {id} is now {} after {} ms",
                    path_word(next),
                    started.elapsed().as_millis()
                );
                self.state().path = next;
                self.changed();
                last = next;
            }
        };
        let ended = tokio::select! {
            ended = session.closed() => ended,
            () = forward => unreachable!("the forwarder never returns"),
            () = paths => unreachable!("the path watcher never returns"),
        };
        log::info!("vibe-mobile: connection to {id} closed: {}", ended.raw);
        {
            let mut st = self.state();
            st.gate.close(generation);
            if st.generation == generation {
                st.session = None;
            }
        }
        self.down(ended.reason.clone());
        Ran { connected: true, reason: ended.reason }
    }

    async fn run(self: Arc<Self>, id: String, first: oneshot::Sender<Result<u64, Reason>>) {
        let first = Mutex::new(Some(first));
        let net = self.net.clone();
        drive(
            || self.list.contains(&id) && self.is_target(&id),
            || self.attempt(&id, &first),
            |reason, failures| {
                let net = net.clone();
                async move { net.wait(&reason, failures).await }
            },
        )
        .await;
    }

    fn reach_of(&self, id: &str, st: &LinkState) -> Value {
        if st.target.as_deref() == Some(id) {
            return json!({ "state": "open" });
        }
        match st.probes.get(id) {
            Some(reach) => serde_json::to_value(reach).unwrap_or(Value::Null),
            None => json!({ "state": "unchecked" }),
        }
    }
}

impl Desktop for Link {
    fn call(&self, command: &str, args: Value) -> Answer<'_> {
        let session = self.0.state().session.clone();
        let command = command.to_string();
        Box::pin(async move {
            match session {
                Some(s) => s.call(&command, args).await,
                None => Err(UNCONNECTED.to_string()),
            }
        })
    }

    fn desktops(&self) -> Value {
        let inner = &self.0;
        let (desktops, problem, current) = match inner.list.read() {
            Ok(file) => (file.desktops, Value::Null, file.current),
            Err(why) => (Vec::new(), Value::String(why), None),
        };
        let st = inner.state();
        let rows: Vec<Value> = desktops
            .iter()
            .map(|d| {
                let mut row = serde_json::to_value(d).unwrap_or(Value::Null);
                row["reach"] = inner.reach_of(&d.id, &st);
                row
            })
            .collect();
        json!({
            "desktops": rows,
            "problem": problem,
            "current": current,
            "link": {
                "id": st.target,
                "phase": st.phase,
                "reason": st.reason,
                "path": st.path,
                "connectMs": st.connect_ms,
            },
        })
    }

    fn probe(&self) {
        let inner = self.0.clone();
        let Ok(file) = inner.list.read() else { return };
        let target = inner.state().target.clone();
        for entry in file.desktops.into_iter().filter(|d| Some(&d.id) != target.as_ref()) {
            inner.state().probes.insert(entry.id.clone(), Reach::Checking);
            let inner = inner.clone();
            tauri::async_runtime::spawn(async move {
                let found = match inner.client().await {
                    Ok(c) => client::probe(c, &entry).await,
                    Err(_) => Probe::Down { reason: Reason::Unreachable },
                };
                let reach = match found {
                    Probe::Reachable { relay } => match inner.list.seen(&entry.id, now()) {
                        // Unpaired while it was being probed: nothing to say.
                        Ok(false) | Err(_) => None,
                        Ok(true) => {
                            let _ = inner.list.set_relay(&entry.id, relay);
                            Some(Reach::Reachable)
                        }
                    },
                    Probe::Down { reason } => Some(Reach::Down { reason }),
                };
                {
                    let mut st = inner.state();
                    match reach {
                        Some(r) => st.probes.insert(entry.id.clone(), r),
                        None => st.probes.remove(&entry.id),
                    };
                }
                inner.changed();
            });
        }
        self.0.changed();
    }

    fn open(&self, id: Option<String>) -> Answer<'_> {
        let inner = self.0.clone();
        Box::pin(async move {
            inner.stop_loop();
            inner.list.set_current(id.as_deref())?;
            inner.changed();
            let Some(id) = id else { return Ok(json!({ "generation": null })) };
            if !inner.list.contains(&id) {
                return Err("that desktop is not paired with this phone".into());
            }
            let (first, answered) = oneshot::channel();
            {
                let mut st = inner.state();
                st.target = Some(id.clone());
                st.phase = Phase::Connecting;
                st.probes.remove(&id);
            }
            let task = tauri::async_runtime::spawn(inner.clone().run(id, first));
            inner.state().task = Some(task);
            Ok(match answered.await {
                Ok(Ok(generation)) => json!({ "generation": generation }),
                Ok(Err(reason)) => json!({ "reason": reason }),
                // The loop was stopped before its first attempt finished.
                Err(_) => json!({ "reason": Reason::Unreachable }),
            })
        })
    }

    fn session(&self) -> Result<Value, String> {
        let st = self.0.state();
        match &st.session {
            Some(s) => Ok(json!({ "generation": st.generation, "idBase": s.welcome().id_base })),
            None => Err(UNCONNECTED.to_string()),
        }
    }

    fn release(&self, generation: u64) {
        let mut st = self.0.state();
        for (name, payload) in st.gate.release(generation) {
            self.0.emit(&name, &*payload);
        }
    }

    fn pair(&self, payload: String, phone_name: String, attempt: u64) -> Answer<'_> {
        let inner = self.0.clone();
        Box::pin(async move {
            let payload = match PairPayload::parse(payload.trim()) {
                Ok(p) => p,
                Err(e) => return Ok(json!({ "reason": Reason::PairRefused { reason: e.to_string() } })),
            };
            // A Back that reached Rust before this future ran is kept by the
            // slot, and nothing is dialled. A second pairing replaces the
            // first, whose sender drops: Back.
            let Some(cancel) = inner.pairing.lock().unwrap_or_else(|p| p.into_inner()).start(attempt) else {
                return Ok(json!({ "reason": Reason::PairCancelled }));
            };
            // An endpoint that could not start is a pairing that could not
            // reach anything, said as such rather than as a raw error.
            let client = match inner.client().await {
                Ok(c) => c,
                Err(why) => {
                    log::error!("vibe-mobile: {why}");
                    return Ok(json!({ "reason": Reason::Unreachable }));
                }
            };
            let list = &*inner.list;
            let emitter = inner.clone();
            let got = pair_flow(
                async { client::pair(client, list, &payload, &phone_name).await.map(|challenged| Real { challenged, list, now: now() }) },
                move |code| emitter.emit("phone://pair-code", PairCode { attempt, code }),
                cancel,
            )
            .await;
            inner.changed();
            Ok(match got {
                Ok(entry) => json!({ "ok": entry }),
                Err(reason) => json!({ "reason": reason }),
            })
        })
    }

    fn pair_cancel(&self, attempt: u64) {
        self.0.pairing.lock().unwrap_or_else(|p| p.into_inner()).cancel(attempt);
    }

    fn unpair(&self, id: String) -> Answer<'_> {
        let inner = self.0.clone();
        Box::pin(async move {
            // The open desktop's loop ends before the list is touched, so it
            // cannot dial again; its session is kept long enough to say Unpair.
            let session = if inner.is_target(&id) {
                let session = inner.state().session.clone();
                inner.stop_loop();
                session
            } else {
                None
            };
            let entry = inner.list.get(&id)?.ok_or("that desktop is not paired with this phone")?;
            let told = match inner.client().await {
                Ok(client) => client::unpair(client, &inner.list, &entry, session.as_deref(), inner.hello()).await?,
                // With no endpoint the desktop cannot be told, and the entry
                // goes all the same, as it does for a desktop that is off.
                Err(why) => {
                    log::error!("vibe-mobile: {why}");
                    inner.list.remove(&id)?;
                    client::Unpaired::Unreachable
                }
            };
            drop(session);
            inner.state().probes.remove(&id);
            inner.changed();
            Ok(json!({ "unpaired": told }))
        })
    }

    fn rename(&self, id: &str, name: Option<String>) -> Result<(), String> {
        if !self.0.list.rename(id, name.as_deref())? {
            return Err("that desktop is not paired with this phone".into());
        }
        self.0.changed();
        Ok(())
    }

    fn network_changed(&self, online: Option<bool>) -> Later<'_, ()> {
        let inner = self.0.clone();
        Box::pin(async move {
            inner.net.changed(online);
            if let Some(Ok(client)) = inner.client.get() {
                client.endpoint().network_change().await;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use vibe_remote::paired::DesktopEntry;

    fn raw(s: &str) -> Box<RawValue> {
        RawValue::from_string(s.into()).unwrap()
    }

    fn names(events: &[(String, Box<RawValue>)]) -> Vec<&str> {
        events.iter().map(|(n, _)| n.as_str()).collect()
    }

    #[test]
    fn the_gate_holds_until_its_own_generation_is_released() {
        let mut gate = EventGate::default();
        gate.reset(1);
        assert!(gate.push(1, "a".into(), raw("1")).is_none());
        assert!(gate.push(1, "b".into(), raw("2")).is_none());
        assert!(gate.release(0).is_empty(), "a stale release releases nothing");
        assert_eq!(names(&gate.release(1)), ["a", "b"], "in order");
        assert_eq!(gate.push(1, "c".into(), raw("3")).map(|(n, _)| n), Some("c".into()), "then straight through");
        assert!(gate.push(2, "x".into(), raw("0")).is_none(), "another connection's event is dropped");

        gate.close(1);
        assert!(gate.push(1, "d".into(), raw("4")).is_none());
        assert!(gate.release(1).is_empty(), "nothing after a close");

        gate.reset(2);
        assert!(gate.push(2, "e".into(), raw("5")).is_none(), "a new connection holds again");
        assert_eq!(names(&gate.release(2)), ["e"]);
    }

    #[test]
    fn only_the_desktop_s_forwarded_events_are_passed_on() {
        assert!(forwarded("host://frame"));
        assert!(forwarded("remote://connections"));
        assert!(!forwarded("app://quit-requested"));
        assert!(!forwarded("phone://connected"));
    }

    #[test]
    fn the_hello_carries_the_version_it_is_given() {
        let hello = hello_for("1.7.0", "Pixel");
        assert_eq!(hello, Hello { remote_protocol: REMOTE_PROTOCOL, app_version: "1.7.0".into(), phone_name: "Pixel".into() });
    }

    #[test]
    fn a_close_the_desktop_explained_waits_for_a_poke() {
        assert!(terminal(&Reason::NotPaired));
        assert!(terminal(&Reason::RemoteOff));
        assert!(terminal(&Reason::VersionMismatch { desktop_app_version: None, phone_app_version: "1".into() }));
        assert!(!terminal(&Reason::Unreachable));
        assert!(!terminal(&Reason::Offline));
        assert!(!terminal(&Reason::RelaysUnreachable));

        let net = NetState::default();
        tauri::async_runtime::block_on(async {
            let waited = tokio::time::timeout(Duration::from_millis(1_500), net.wait(&Reason::NotPaired, 0)).await;
            assert!(waited.is_err(), "no timer ends a terminal wait");
            net.poke();
            tokio::time::timeout(Duration::from_secs(1), net.wait(&Reason::NotPaired, 0)).await.expect("a poke does");
            tokio::time::timeout(Duration::from_millis(1_500), net.wait(&Reason::Unreachable, 0))
                .await
                .expect("an unexplained one retries after the backoff");
        });
    }

    #[test]
    fn every_network_change_pokes_and_offline_is_kept() {
        let net = NetState::default();
        net.changed(Some(true));
        net.changed(Some(true));
        assert_eq!(net.pokes(), 2, "the same answer twice is two pokes");
        net.changed(Some(false));
        assert!(!net.online());
        net.changed(None);
        assert!(!net.online(), "a resume says nothing about the network");
        assert_eq!(net.pokes(), 4);
    }

    #[test]
    fn the_loop_stops_dialling_once_the_desktop_is_unpaired() {
        let paired = AtomicBool::new(true);
        let dials = AtomicU64::new(0);
        tauri::async_runtime::block_on(drive(
            || paired.load(Ordering::SeqCst),
            || {
                dials.fetch_add(1, Ordering::SeqCst);
                // The connection ended because the desktop was unpaired here.
                paired.store(false, Ordering::SeqCst);
                async { Ran { connected: true, reason: Reason::Unreachable } }
            },
            |_, _| async {},
        ));
        assert_eq!(dials.load(Ordering::SeqCst), 1, "no second dial after an unpair");
    }

    #[test]
    fn the_backoff_resets_after_a_connection_and_grows_after_failures() {
        let left = AtomicU64::new(5);
        let waits = Mutex::new(Vec::new());
        let outcomes = [false, false, true, false, false];
        let n = AtomicU64::new(0);
        tauri::async_runtime::block_on(drive(
            || left.load(Ordering::SeqCst) > 0,
            || {
                let i = n.fetch_add(1, Ordering::SeqCst) as usize;
                left.fetch_sub(1, Ordering::SeqCst);
                let connected = outcomes[i];
                async move { Ran { connected, reason: Reason::Unreachable } }
            },
            |_, failures| {
                waits.lock().unwrap().push(failures);
                async {}
            },
        ));
        assert_eq!(*waits.lock().unwrap(), [0, 1, 0, 0, 1]);
    }

    /// Each attempt reads the entry again, so a hint the last connection
    /// replaced is the one dialled next.
    #[test]
    fn each_attempt_dials_the_hint_as_the_list_has_it_now() {
        let dir = crate::settings::tests::Scratch::new("link-rehint");
        let list = PairedList::in_dir(&dir.0);
        let id = SecretKey::from_bytes(&[3; 32]).public().to_string();
        list.add(DesktopEntry { id: id.clone(), relay: Some("https://old.example./".into()), desktop_name: None, name: None, paired_at: 0, last_seen: None })
            .unwrap();
        let dialled = Mutex::new(Vec::new());
        tauri::async_runtime::block_on(drive(
            || dialled.lock().unwrap().len() < 2,
            || {
                let hint = list.get(&id).unwrap().unwrap().relay;
                dialled.lock().unwrap().push(hint);
                list.set_relay(&id, Some("https://new.example./".into())).unwrap();
                async { Ran { connected: true, reason: Reason::Unreachable } }
            },
            |_, _| async {},
        ));
        assert_eq!(
            *dialled.lock().unwrap(),
            [Some("https://old.example./".to_string()), Some("https://new.example./".to_string())]
        );
    }
}
