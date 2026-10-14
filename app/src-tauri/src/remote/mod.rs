//! Remote access: the desktop's half of identity, pairing and the endpoint
//! (#341, #342).
//!
//! A phone controls this app over iroh, a QUIC link addressed by an ed25519
//! public key. This module holds:
//!
//! - **the device key** (`identity.rs`), one per install, in the OS keychain
//!   beside the two vendor keys. Its public half is the endpoint id. **No
//!   command reads it, deletes it or names it** - `remote_status` reports the
//!   public id and nothing else - for the reason `keys.rs` gives about the
//!   vendor keys: the window must have nothing to steal.
//! - **pairing** (`pairing.rs`), a pure state machine: a one-time secret in a
//!   QR code, burnt by any attempt, and a six-digit matching code both screens
//!   show, so a yes is a yes to the device in the owner's hand.
//! - **the paired list** (`store.rs`), a file Rust owns.
//! - **the wire**, everything the phone also needs, in the shared crate
//!   `app/remote/` (#345) along with the framing, the two ALPNs and how an
//!   endpoint reaches n0.
//! - **the endpoint** (`endpoint.rs`), what a phone dials, and **the pairing
//!   handler** (`handshake.rs`), which carries `attempt` and `answer` over it.
//! - **the bridge** (`bridge.rs`, #343), what a paired phone's connection on
//!   `vibe/remote/1` is used for: its control stream, the allowed commands run
//!   through the same code as the window's, and the events fanned out to it.
//! - **the hub** (`hub.rs`, #343), the one seam every event leaves through, to
//!   the window and to every phone in one order, and the live-run buffer.
//!
//! - **the settings** (`settings.rs`, #344), `remote.json`: the switch, start
//!   at login, keep awake and a relay of one's own, in a file Rust owns and
//!   reads in `setup`, before any window exists.
//!
//! **The endpoint runs only while the switch in `remote.json` is on**, and only
//! once a device key exists. With it off nothing binds, nothing reaches a
//! relay and nothing is published; a file that cannot be read is off.
//!
//! **Every change to the endpoint is one [`reconcile_locked`]**, under one
//! async lock: it makes the endpoint match the settings, stopping an old
//! endpoint completely before it builds a new one, so there is never more than
//! one. The window's `remote_set` answers once that has happened; a phone's
//! answers first when the change would close its own connection, and the stop
//! waits until its answer has reached it.
//!
//! **No timer here.** An unanswered prompt is closed by the window when its
//! clock reaches `expiresAt`, which it already holds; Rust says `expired` only
//! when an answer arrives too late. The phone's side of the wait is bounded by
//! the code's own life in `handshake.rs`.

pub mod pairing;
pub mod qr;
/// Everything the phone also needs, in the shared crate (#345). Re-exported
/// so the desktop's side names it as it always has.
pub use vibe_remote::wire;
pub(crate) mod bridge;
pub mod endpoint;
pub mod handshake;
pub(crate) mod hub;
pub(crate) mod identity;
pub(crate) mod settings;
pub(crate) mod store;

use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use iroh::{EndpointId, RelayUrl, SecretKey};
use iroh_base::PublicKey;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::autostart::Autostart;
use crate::awake::AwakeReport;
use crate::host::HostProcess;
use bridge::{Bridge, StoreUnpair, TauriCommands, Written};
use endpoint::{Config, Gate, LinkInfo, Live, Reach, RelayInfo, RemoteEndpoint};
use hub::Hub;
use handshake::{Desk, PairHandler, Shared};
use identity::{Keychain, Vault};
use pairing::{Answer, Pairing};
use qr::QrMatrix;
use settings::{Loaded, Patch, Settings, SettingsFile};
use store::{Phone, Store};
use wire::{PairPayload, PairResult};

/// Live connections from paired phones. Empty until the endpoint exists (#342),
/// which drops a revoked phone's connection with `NOT_PAIRED`.
pub(crate) trait Connections {
    fn close(&self, id: &str);
    fn connected(&self, id: &str) -> bool;
}

/// No endpoint, so nothing is ever connected and nothing needs closing.
pub(crate) struct NoConnections;

impl Connections for NoConnections {
    fn close(&self, _id: &str) {}
    fn connected(&self, _id: &str) -> bool {
        false
    }
}

/// `remote://pair-request`: *Allow `<phoneName>`?* with the six digits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub phone_name: String,
    pub code: String,
    pub expires_at: u64,
}

/// How a prompt ended, so the window dismisses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Paired,
    Declined,
    Expired,
}

#[derive(Clone, Serialize)]
struct Ended {
    outcome: Outcome,
}

/// Where the two events go. A trait so the tests can record them.
pub(crate) trait Emit {
    fn pair_request(&self, request: &PairRequest);
    fn pair_ended(&self, outcome: Outcome);
}

struct TauriEmit(AppHandle);

/// Through the hub, like every event: both reach the connected phones as well
/// as the window (#343), so a prompt any client answers closes on all of them.
impl Emit for TauriEmit {
    fn pair_request(&self, request: &PairRequest) {
        hub::emit(&self.0, "remote://pair-request", request);
    }
    fn pair_ended(&self, outcome: Outcome) {
        hub::emit(&self.0, "remote://pair-ended", &Ended { outcome });
    }
}

/// What the commands and the endpoint share: the pairing state, the phone
/// waiting on a prompt, the endpoint when it runs, and the hub every event
/// leaves through (#343) - which runs whether or not remote access is on, so a
/// phone that connects mid-run is sent the whole run.
#[derive(Default)]
pub struct Remote {
    shared: Arc<Shared>,
    endpoint: Mutex<Running>,
    hub: Arc<Hub>,
    /// `remote.json` as last read or written (#344). Held across a patch's
    /// load, merge and write, so two patches - the window's and a phone's, or
    /// two phones' - apply one after the other and neither is lost.
    settings: Mutex<Loaded>,
    /// Every change to `endpoint` that binds or stops one holds this, so there
    /// is never more than one endpoint and a stop always finishes before the
    /// next bind. An `Arc` so a phone's closing call can hand its guard to the
    /// task that stops the endpoint once the phone has its answer.
    transition: Arc<tokio::sync::Mutex<()>>,
    /// The OS login item. Set once, in `setup`, to the plugin's; tests never
    /// reach the plugin.
    autostart: OnceLock<Arc<dyn Autostart>>,
    /// Why the last change to start at login failed, until one succeeds.
    login_error: Mutex<Option<String>>,
}

/// Where the endpoint is. `Off` is the default and the whole of it while
/// remote access is off: nothing has been bound or asked of the network.
#[derive(Default)]
enum Running {
    #[default]
    Off,
    /// On, but no device key yet: the first pairing code makes one, and the
    /// endpoint starts then.
    NoKey,
    Starting,
    /// Bound, with the relay setting it was started with: a different one in
    /// the settings means a restart.
    Up { ep: RemoteEndpoint, relay: Option<String> },
    Failed(String),
}

/// The endpoint as the diagnostics draw it. Read off iroh when asked; nothing
/// is remembered between asks.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum EndpointReport {
    /// Remote access is off: no socket, no relay, no record.
    Off,
    /// On, waiting for a device key.
    NoKey,
    Starting,
    /// Bound. `relays` is the home relay and whether it is connected; `links`
    /// is each paired phone connected now and whether its path is direct.
    Up { relays: Vec<RelayInfo>, links: Vec<LinkInfo> },
    Failed { reason: String },
}

impl Running {
    fn report(&self) -> EndpointReport {
        match self {
            Running::Off => EndpointReport::Off,
            Running::NoKey => EndpointReport::NoKey,
            Running::Starting => EndpointReport::Starting,
            Running::Up { ep, .. } => {
                let s = ep.status();
                EndpointReport::Up { relays: s.relays, links: s.links }
            }
            Running::Failed(reason) => EndpointReport::Failed { reason: reason.clone() },
        }
    }
}

/// What `remote_pair_begin` answers: the payload, when it stops working, and
/// the QR code to draw. The live secret is in the payload because showing it is
/// what this command is for; `remote_status` never carries it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairBegin {
    pub payload: String,
    pub expires_at: u64,
    pub qr: QrMatrix,
}

/// One paired phone, as the window draws it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneStatus {
    pub id: String,
    pub name: String,
    pub paired_at: u64,
    pub last_seen: Option<u64>,
    pub connected: bool,
}

/// What the window knows about remote access. **No field carries a secret
/// key or a pairing secret**, and a test pins the names so a new one is a
/// decision rather than an accident.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    /// The device's public id, or null when no key has been made yet.
    pub endpoint_id: Option<String>,
    /// Why the keychain could not say. Distinct from a null id: a locked
    /// keychain is not a desktop that has never paired.
    pub identity_unreadable: Option<String>,
    pub phones: Vec<PhoneStatus>,
    /// Why the list could not be read. Never drawn as *no phones paired*.
    pub phones_unreadable: Option<String>,
    /// `remote.json` as read (#344). The defaults - off - when it could not be.
    pub settings: Settings,
    /// Why `remote.json` could not be read, which is why remote access is off.
    pub settings_unreadable: Option<String>,
    /// What the OS says about the login item, which wins over the file.
    pub start_at_login: LoginReport,
    /// Whether keep awake holds the inhibitor, and why it could not.
    pub awake: AwakeReport,
    /// The endpoint a phone dials (#342). `off` whenever the switch is.
    pub endpoint: EndpointReport,
}

/// Start at login as the OS reports it, not as the file remembers it: the
/// person may have removed the entry by hand.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginReport {
    /// Null when the OS could not say.
    pub enabled: Option<bool>,
    /// Why the OS could not say, or why the last change failed.
    pub error: Option<String>,
}

/// Ask the OS, through the trait. With no login item available at all - a
/// build that never set one - that is said rather than guessed.
pub(crate) fn login_report(autostart: Option<&dyn Autostart>, last_error: Option<String>) -> LoginReport {
    let Some(autostart) = autostart else {
        return LoginReport { enabled: None, error: Some("start at login is not available in this build".into()) };
    };
    match autostart.is_enabled() {
        Ok(enabled) => LoginReport { enabled: Some(enabled), error: last_error },
        Err(why) => LoginReport { enabled: None, error: Some(why) },
    }
}

/// What `status` reports beside the paired phones and the identity.
pub(crate) struct Facts {
    pub(crate) settings: Loaded,
    pub(crate) start_at_login: LoginReport,
    pub(crate) awake: AwakeReport,
}

/// `n` bytes from the OS CSPRNG, or the reason there are none. No fallback.
fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|e| format!("the system's random source failed: {e}"))?;
    Ok(bytes)
}

/// Make a code. Creates the device key the first time, and only when the
/// keychain says it holds none.
pub(crate) fn begin(
    pairing: &mut Pairing,
    vault: &dyn Vault,
    emit: &dyn Emit,
    hostname: Option<String>,
    relay: Option<String>,
    secret: [u8; 32],
    now: u64,
) -> Result<PairBegin, String> {
    let key = identity::read_or_create(vault)?;
    let begun = pairing.begin(now, secret);
    // The prompt a new code replaced is gone; tell the window so it does not
    // stay up over a code Rust has already forgotten.
    if begun.replaced_prompt {
        emit.pair_ended(Outcome::Declined);
    }
    let payload = PairPayload { id: key.public(), relay, secret, name: hostname }.to_uri();
    let qr = qr::matrix(&payload)?;
    Ok(PairBegin { payload, expires_at: begun.expires_at, qr })
}

/// A phone presents a secret. `phone_id` is the id the QUIC handshake
/// authenticated.
///
/// Called by the `vibe/pair/1` handler (`handshake.rs`) and by nothing else:
/// there is deliberately no command that reaches it.
#[allow(clippy::too_many_arguments)]
pub(crate) fn attempt(
    pairing: &mut Pairing,
    vault: &dyn Vault,
    store: &Store,
    emit: &dyn Emit,
    secret: &[u8],
    phone_id: PublicKey,
    phone_name: &str,
    nonce: [u8; 16],
    now: u64,
) -> Result<[u8; 16], String> {
    let desktop = identity::read(vault)?.ok_or("this desktop has no device key yet")?.public();
    let id = phone_id.to_string();
    let already = store.load()?.iter().any(|p| p.id == id);
    let pending = pairing
        .attempt(secret, phone_id, phone_name, &desktop, already, nonce, now)
        .map_err(|r| r.to_string())?;
    emit.pair_request(&PairRequest {
        phone_name: pending.phone_name.clone(),
        code: pending.code.clone(),
        expires_at: pending.expires_at,
    });
    Ok(pending.nonce)
}

/// The window's yes or no. Every path says how the prompt ended.
///
/// The store is needed only to add a phone, so it arrives unresolved: a
/// missing data directory makes a yes end as `declined` with its reason, and
/// leaves a no, an expiry and an empty answer saying what they are.
pub(crate) fn answer(
    pairing: &mut Pairing,
    store: Result<&Store, String>,
    emit: &dyn Emit,
    yes: bool,
    now: u64,
) -> Result<Outcome, String> {
    match pairing.answer(yes, now) {
        Answer::Paired { id, name } => {
            let phone = Phone { id: id.to_string(), name, paired_at: now, last_seen: None };
            match store.and_then(|s| s.add(phone)) {
                Ok(()) => {
                    emit.pair_ended(Outcome::Paired);
                    Ok(Outcome::Paired)
                }
                // The prompt is over either way; the sentence goes back to the
                // window, which shows it in the settings section.
                Err(why) => {
                    emit.pair_ended(Outcome::Declined);
                    Err(why)
                }
            }
        }
        Answer::Declined | Answer::NothingPending => {
            emit.pair_ended(Outcome::Declined);
            Ok(Outcome::Declined)
        }
        Answer::Expired => {
            emit.pair_ended(Outcome::Expired);
            Ok(Outcome::Expired)
        }
    }
}

/// Remove a phone and drop it if it is connected. An id not on the list is
/// success: absence is what was asked for.
pub(crate) fn revoke(store: &Store, connections: &dyn Connections, id: &str) -> Result<(), String> {
    store.remove(id)?;
    connections.close(id);
    Ok(())
}

/// What the window draws. **Never fails and never creates a key**, so the
/// section always has its answer, a file or a keychain that cannot be read
/// included.
pub(crate) fn status(
    vault: &dyn Vault,
    store: Result<Store, String>,
    connections: &dyn Connections,
    facts: Facts,
) -> RemoteStatus {
    let (endpoint_id, identity_unreadable) = match identity::read(vault) {
        Ok(key) => (key.map(|k| k.public().to_string()), None),
        Err(why) => (None, Some(why)),
    };
    let (phones, phones_unreadable) = match store.and_then(|s| s.load()) {
        Ok(phones) => (
            phones
                .into_iter()
                .map(|p| PhoneStatus {
                    connected: connections.connected(&p.id),
                    id: p.id,
                    name: p.name,
                    paired_at: p.paired_at,
                    last_seen: p.last_seen,
                })
                .collect(),
            None,
        ),
        Err(why) => (Vec::new(), Some(why)),
    };
    RemoteStatus {
        endpoint_id,
        identity_unreadable,
        phones,
        phones_unreadable,
        settings: facts.settings.settings,
        settings_unreadable: facts.settings.unreadable,
        start_at_login: facts.start_at_login,
        awake: facts.awake,
        endpoint: EndpointReport::Off,
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn store_of(app: &AppHandle) -> Result<Store, String> {
    app.path()
        .app_data_dir()
        .map(|dir| Store::in_dir(&dir))
        .map_err(|e| format!("this platform gave the app no data directory for the paired phones list: {e}"))
}

/// The machine's name for the QR code, or none. Never invented.
fn hostname() -> Option<String> {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer is valid for its length, and gethostname writes
        // at most that many bytes.
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
        if rc != 0 {
            return None;
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        let name = String::from_utf8_lossy(&buf[..end]).trim().to_string();
        (!name.is_empty()).then_some(name)
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").ok().filter(|n| !n.trim().is_empty())
    }
}

/// `begin`, ending any phone's wait on the prompt the new code replaces.
pub(crate) fn begin_code(
    shared: &Shared,
    vault: &dyn Vault,
    emit: &dyn Emit,
    hostname: Option<String>,
    relay: Option<String>,
    secret: [u8; 32],
    now: u64,
) -> Result<PairBegin, String> {
    let mut pairing = shared.pairing();
    shared.tell(PairResult::Declined);
    begin(&mut pairing, vault, emit, hostname, relay, secret, now)
}

/// `answer`, and the phone waiting on the prompt told how it ended.
pub(crate) fn answer_prompt(
    shared: &Shared,
    store: Result<&Store, String>,
    emit: &dyn Emit,
    desktop_name: Option<String>,
    yes: bool,
    now: u64,
) -> Result<Outcome, String> {
    let mut pairing = shared.pairing();
    let answered = answer(&mut pairing, store, emit, yes, now);
    shared.tell(match &answered {
        Ok(Outcome::Paired) => PairResult::Paired { desktop_name },
        Ok(Outcome::Declined | Outcome::Expired) => PairResult::Declined,
        // The sentence names a path on this desktop; the phone is told only
        // that the desktop could not keep the pairing.
        Err(_) => PairResult::Refused { reason: "the desktop could not save the pairing".into() },
    });
    answered
}

impl Remote {
    fn running(&self) -> std::sync::MutexGuard<'_, Running> {
        self.endpoint.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn loaded(&self) -> std::sync::MutexGuard<'_, Loaded> {
        self.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The settings the endpoint should match now.
    fn desired(&self) -> Settings {
        self.loaded().settings.clone()
    }

    fn autostart(&self) -> Option<&dyn Autostart> {
        self.autostart.get().map(|a| &**a)
    }

    fn facts(&self, hosts: Option<&HostProcess>) -> Facts {
        let last = self.login_error.lock().unwrap_or_else(|p| p.into_inner()).clone();
        Facts {
            settings: self.loaded().clone(),
            start_at_login: login_report(self.autostart(), last),
            awake: hosts.map(HostProcess::awake_report).unwrap_or_default(),
        }
    }
}

/// Who may open `vibe/remote/1`: the paired list, read when asked, so a revoke
/// is seen by the next dial. **A list that cannot be read admits nobody**, and
/// neither does a missing data directory.
#[derive(Debug)]
struct PairedList(Result<Store, String>);

impl Gate for PairedList {
    fn is_paired(&self, id: &EndpointId) -> bool {
        let id = id.to_string();
        matches!(&self.0, Ok(store) if store.load().is_ok_and(|phones| phones.iter().any(|p| p.id == id)))
    }
}

/// What a start does, decided before anything is bound.
#[derive(Debug)]
enum Decision {
    /// Remote access is off: nothing is read, bound or published.
    Off,
    NoKey,
    Failed(String),
    Start(SecretKey),
}

/// With remote access off the keychain is not even asked, so there is no key,
/// no endpoint, no socket and no relay connection.
fn start_decision(enabled: bool, read_key: impl FnOnce() -> Result<Option<SecretKey>, String>) -> Decision {
    if !enabled {
        return Decision::Off;
    }
    match read_key() {
        Ok(Some(key)) => Decision::Start(key),
        Ok(None) => Decision::NoKey,
        Err(why) => Decision::Failed(why),
    }
}

/// Make the endpoint match the settings, with the transition lock held by the
/// caller.
///
/// - **Off**: an endpoint that is up is stopped - after `after` resolves, when
///   a phone's answer has to reach it first - and every other state becomes
///   `Off`, so the window never reads *waiting for a key* or *failed* about a
///   switch that is off.
/// - **On**: an endpoint up under a different relay is stopped, **completely**,
///   and then one is started; `NoKey` and `Failed` are tried again. After a
///   bind the settings are read once more, and an endpoint bound for settings
///   that have since changed is stopped rather than installed; the change that
///   moved them has its own reconcile queued behind this one.
///
/// `build` binds an endpoint; the app's is the real one, the tests' a loopback.
async fn reconcile_locked<K, B, F>(remote: &Remote, read_key: K, build: B, after: Option<Written>)
where
    K: FnOnce() -> Result<Option<SecretKey>, String>,
    B: FnOnce(SecretKey, Option<RelayUrl>) -> F,
    F: Future<Output = Result<RemoteEndpoint, String>>,
{
    let desired = remote.desired();
    let stopping = {
        let mut running = remote.running();
        let restart = match &*running {
            Running::Up { relay, .. } => !desired.enabled || *relay != desired.relay,
            _ => !desired.enabled,
        };
        if restart {
            match std::mem::take(&mut *running) {
                Running::Up { ep, .. } => Some(ep),
                _ => None,
            }
        } else {
            None
        }
    };
    if let Some(ep) = stopping {
        if let Some(after) = after {
            after.wait().await;
        }
        let id = ep.id();
        ep.stop().await;
        crate::applog::app(&format!("remote access: endpoint {id} stopped"));
    }
    if !desired.enabled {
        return;
    }
    if matches!(*remote.running(), Running::Up { .. }) {
        return;
    }
    let key = match start_decision(true, read_key) {
        Decision::Start(key) => key,
        Decision::Off => return,
        Decision::NoKey => {
            *remote.running() = Running::NoKey;
            return;
        }
        Decision::Failed(why) => {
            *remote.running() = Running::Failed(why);
            return;
        }
    };
    *remote.running() = Running::Starting;
    let built = build(key, settings::relay_url(&desired)).await;
    let now = remote.desired();
    let current = now.enabled && now.relay == desired.relay;
    match built {
        Ok(ep) if current => {
            crate::applog::app(&format!("remote access: endpoint {} is up", ep.id()));
            *remote.running() = Running::Up { ep, relay: desired.relay };
        }
        Ok(ep) => {
            *remote.running() = Running::Off;
            ep.stop().await;
        }
        Err(why) => {
            crate::applog::app(&format!("remote access: {why}"));
            *remote.running() = if current { Running::Failed(why) } else { Running::Off };
        }
    }
}

/// `reconcile_locked`, taking the lock.
async fn reconcile_with<K, B, F>(remote: &Remote, read_key: K, build: B)
where
    K: FnOnce() -> Result<Option<SecretKey>, String>,
    B: FnOnce(SecretKey, Option<RelayUrl>) -> F,
    F: Future<Output = Result<RemoteEndpoint, String>>,
{
    let _guard = remote.transition.lock().await;
    reconcile_locked(remote, read_key, build, None).await;
}

/// The app's endpoint: n0's DNS and relays (or the person's own relay), plus
/// mDNS, as #340 decided, carrying pairing and the bridge.
async fn build_endpoint(app: AppHandle, key: SecretKey, relay: Option<RelayUrl>) -> Result<RemoteEndpoint, String> {
    let remote = app.state::<Remote>();
    let store = store_of(&app);
    let desk = Desk {
        shared: remote.shared.clone(),
        vault: Box::new(Keychain),
        store: store.clone(),
        emit: Box::new(TauriEmit(app.clone())),
        now,
        nonce: random::<16>,
    };
    let config = Config { key, reach: Reach::Internet { relay, mdns: true } };
    // One set of live connections, shared by the endpoint (which registers
    // each), a revoke (which closes them) and the bridge's Unpair (which is the
    // same revoke). It announces each paired phone's connect and disconnect,
    // and is the only thing that does.
    let announce = app.clone();
    let live = Live::notifying(move || hub::emit(&announce, CONNECTIONS_EVENT, &()));
    let bridge = Bridge::new(
        Arc::new(TauriCommands(app.clone())),
        remote.hub.clone(),
        Arc::new(StoreUnpair(store.clone(), live.clone())),
        app.package_info().version.to_string(),
        hostname(),
    );
    RemoteEndpoint::start_with(config, Arc::new(PairedList(store)), live, PairHandler(Arc::new(desk)), bridge).await
}

/// A paired phone connected or went. It carries nothing: whoever holds a
/// status re-reads `remote_status`.
const CONNECTIONS_EVENT: &str = "remote://connections";

/// Make the app's endpoint match its settings, waiting for it.
async fn reconcile(app: &AppHandle, remote: &Remote) {
    let built = app.clone();
    reconcile_with(remote, || identity::read(&Keychain), move |key, relay| build_endpoint(built, key, relay)).await;
}

/// Start the endpoint, if remote access is on and there is a key to start it
/// with, without waiting. Called at launch and after the first pairing code
/// makes the key.
pub(crate) fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let remote = app.state::<Remote>();
        reconcile(&app, &remote).await;
    });
}

/// Read `remote.json` into the state. Called in `setup`, before any window is
/// shown or host exists; no data directory is off, with the reason.
pub(crate) fn load_settings(app: &AppHandle) -> Settings {
    let loaded = match settings_file(app) {
        Ok(file) => file.load(),
        Err(why) => Loaded::unreadable(why),
    };
    if let Some(why) = &loaded.unreadable {
        crate::applog::app(&format!("remote access: {why}"));
    }
    let settings = loaded.settings.clone();
    *app.state::<Remote>().loaded() = loaded;
    settings
}

/// Install the OS login item. Once, in `setup`.
pub(crate) fn set_autostart(app: &AppHandle, autostart: Arc<dyn Autostart>) {
    let _ = app.state::<Remote>().autostart.set(autostart);
}

fn settings_file(app: &AppHandle) -> Result<SettingsFile, String> {
    app.path()
        .app_data_dir()
        .map(|dir| SettingsFile::in_dir(&dir))
        .map_err(|e| format!("this platform gave the app no data directory for the remote access settings: {e}"))
}

/// Apply a patch to `remote.json` and then to the login item, with the
/// settings lock held throughout so two patches apply one after the other.
///
/// **A refused patch writes nothing and calls nothing.** A login item that
/// could not be changed is recorded and reported, not returned as an error:
/// the file is already written, and the section shows what the OS says.
pub(crate) fn set_settings(
    remote: &Remote,
    file: Result<SettingsFile, String>,
    patch: &Patch,
    autostart: Option<&dyn Autostart>,
) -> Result<Settings, String> {
    let mut loaded = remote.loaded();
    let next = file?.apply_patch(patch)?;
    *loaded = Loaded { settings: next.clone(), unreadable: None };
    if let Some(on) = patch.start_at_login {
        let changed = match autostart {
            Some(a) if on => a.enable(),
            Some(a) => a.disable(),
            None => Err("start at login is not available in this build".into()),
        };
        if let Err(why) = &changed {
            crate::applog::app(&format!("remote access: {why}"));
        }
        *remote.login_error.lock().unwrap_or_else(|p| p.into_inner()) = changed.err();
    }
    Ok(next)
}

/// Write the patch and apply what it changed outside the endpoint.
fn apply_patch(app: &AppHandle, remote: &Remote, patch: &Patch) -> Result<Settings, String> {
    let next = set_settings(remote, settings_file(app), patch, remote.autostart())?;
    // Keep awake is about runs, not phones: on or off whatever the switch says.
    app.state::<HostProcess>().set_keep_awake(next.keep_awake);
    Ok(next)
}

/// `remote_set`: the switch, start at login, keep awake and the relay (#344).
///
/// **The window's call answers once the endpoint has reached the new state**,
/// so *off* means nothing is listening any more.
#[tauri::command]
pub async fn remote_set(patch: Patch, app: AppHandle, remote: State<'_, Remote>) -> Result<RemoteStatus, String> {
    apply_patch(&app, &remote, &patch)?;
    reconcile(&app, &remote).await;
    Ok(status_now(&app, &remote))
}

/// Whether reconciling these settings would close every connection: an
/// endpoint that is up and will be stopped.
fn closes_connections(running: &Running, desired: &Settings) -> bool {
    matches!(running, Running::Up { relay, .. } if !desired.enabled || *relay != desired.relay)
}

/// `remote_set` from a phone, through the bridge.
///
/// A change that keeps the endpoint is applied before the answer, as the
/// window's is. **A change that stops it would close the phone's own
/// connection**, so the transition lock is taken first - nothing else can
/// stop or start the endpoint from here on - the answer describes the state
/// that has been decided, and the stop waits for `written`: until the phone's
/// answer has reached it.
pub(crate) async fn set_remote_from_phone(
    app: &AppHandle,
    remote: &Remote,
    patch: Patch,
    written: Written,
) -> Result<RemoteStatus, String> {
    apply_patch(app, remote, &patch)?;
    let guard = remote.transition.clone().lock_owned().await;
    let desired = remote.desired();
    if !closes_connections(&remote.running(), &desired) {
        drop(written);
        reconcile_locked(remote, || identity::read(&Keychain), |key, relay| build_endpoint(app.clone(), key, relay), None)
            .await;
        drop(guard);
        return Ok(status_now(app, remote));
    }
    let mut decided = status_now(app, remote);
    decided.endpoint = if desired.enabled { EndpointReport::Starting } else { EndpointReport::Off };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let remote = app.state::<Remote>();
        let built = app.clone();
        reconcile_locked(
            &remote,
            || identity::read(&Keychain),
            move |key, relay| build_endpoint(built, key, relay),
            Some(written),
        )
        .await;
        drop(guard);
    });
    Ok(decided)
}

#[tauri::command]
pub fn remote_status(app: AppHandle, remote: State<'_, Remote>) -> RemoteStatus {
    status_now(&app, &remote)
}

/// `remote_status`'s body, shared with a phone's call through the bridge (#343).
pub(crate) fn status_now(app: &AppHandle, remote: &Remote) -> RemoteStatus {
    let facts = remote.facts(Some(&app.state::<HostProcess>()));
    let running = remote.running();
    let report = running.report();
    match &*running {
        Running::Up { ep, .. } => RemoteStatus { endpoint: report, ..status(&Keychain, store_of(app), ep.connections(), facts) },
        _ => RemoteStatus { endpoint: report, ..status(&Keychain, store_of(app), &NoConnections, facts) },
    }
}

#[tauri::command]
pub fn remote_pair_begin(app: AppHandle, remote: State<'_, Remote>) -> Result<PairBegin, String> {
    pair_begin(&app, &remote)
}

/// `remote_pair_begin`'s body, shared with a phone's call through the bridge.
pub(crate) fn pair_begin(app: &AppHandle, remote: &Remote) -> Result<PairBegin, String> {
    let secret = random::<32>()?;
    // The home relay, as an address hint, when the endpoint is up and has one.
    let relay = match &*remote.running() {
        Running::Up { ep, .. } => ep.relay_hint().map(|url| url.to_string()),
        _ => None,
    };
    let begun = begin_code(&remote.shared, &Keychain, &TauriEmit(app.clone()), hostname(), relay, secret, now());
    // The first code makes the device key, and an endpoint waiting for one
    // can start now.
    if begun.is_ok() {
        start(app);
    }
    begun
}

#[tauri::command]
pub fn remote_pair_answer(yes: bool, app: AppHandle, remote: State<'_, Remote>) -> Result<Outcome, String> {
    pair_answer(&app, &remote, yes)
}

/// `remote_pair_answer`'s body, shared with a phone's call through the bridge.
pub(crate) fn pair_answer(app: &AppHandle, remote: &Remote, yes: bool) -> Result<Outcome, String> {
    let store = store_of(app);
    answer_prompt(&remote.shared, store.as_ref().map_err(Clone::clone), &TauriEmit(app.clone()), hostname(), yes, now())
}

#[tauri::command]
pub fn remote_revoke(id: String, app: AppHandle, remote: State<'_, Remote>) -> Result<(), String> {
    revoke_phone(&app, &remote, &id)
}

/// `remote_revoke`'s body, shared with a phone's call through the bridge.
pub(crate) fn revoke_phone(app: &AppHandle, remote: &Remote, id: &str) -> Result<(), String> {
    let store = store_of(app)?;
    match &*remote.running() {
        Running::Up { ep, .. } => revoke(&store, ep.connections(), id),
        _ => revoke(&store, &NoConnections, id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use identity::tests::FakeVault;
    use iroh_base::SecretKey;
    use std::cell::RefCell;
    use store::tests::{phone, Scratch};

    #[derive(Debug, PartialEq, Eq)]
    enum Sent {
        Request(PairRequest),
        Ended(Outcome),
    }

    #[derive(Default)]
    struct FakeEmit(RefCell<Vec<Sent>>);

    impl Emit for FakeEmit {
        fn pair_request(&self, r: &PairRequest) {
            self.0.borrow_mut().push(Sent::Request(r.clone()));
        }
        fn pair_ended(&self, o: Outcome) {
            self.0.borrow_mut().push(Sent::Ended(o));
        }
    }

    #[derive(Default)]
    struct FakeConnections {
        closed: RefCell<Vec<String>>,
    }

    impl Connections for FakeConnections {
        fn close(&self, id: &str) {
            self.closed.borrow_mut().push(id.to_string());
        }
        fn connected(&self, _: &str) -> bool {
            false
        }
    }

    const SECRET: [u8; 32] = [5; 32];
    const NONCE: [u8; 16] = [6; 16];

    fn phone_key() -> PublicKey {
        SecretKey::from_bytes(&[42; 32]).public()
    }

    struct World {
        pairing: Pairing,
        vault: FakeVault,
        emit: FakeEmit,
        store: Store,
        _dir: Scratch,
    }

    fn world(tag: &str) -> World {
        let dir = Scratch::new(tag);
        World {
            pairing: Pairing::default(),
            vault: FakeVault::default(),
            emit: FakeEmit::default(),
            store: Store::in_dir(&dir.0),
            _dir: dir,
        }
    }

    impl World {
        fn begin(&mut self, now: u64) -> PairBegin {
            begin(&mut self.pairing, &self.vault, &self.emit, Some("desk".into()), None, SECRET, now).expect("begins")
        }
        fn attempt(&mut self, now: u64) -> Result<[u8; 16], String> {
            attempt(&mut self.pairing, &self.vault, &self.store, &self.emit, &SECRET, phone_key(), "Pixel", NONCE, now)
        }
        fn answer(&mut self, yes: bool, now: u64) -> Result<Outcome, String> {
            answer(&mut self.pairing, Ok(&self.store), &self.emit, yes, now)
        }
        fn sent(&self) -> Vec<Sent> {
            std::mem::take(&mut *self.emit.0.borrow_mut())
        }
    }

    #[test]
    fn a_successful_attempt_asks_the_window_with_the_code() {
        let mut w = world("request");
        let begun = w.begin(0);
        assert_eq!(w.sent(), vec![], "a first code replaces no prompt");
        assert_eq!(w.attempt(1_000), Ok(NONCE));
        let desktop = identity::read(&w.vault).unwrap().unwrap().public();
        assert_eq!(
            w.sent(),
            vec![Sent::Request(PairRequest {
                phone_name: "Pixel".into(),
                code: wire::matching_code_for(&desktop, &phone_key(), &NONCE),
                expires_at: begun.expires_at,
            })]
        );
    }

    #[test]
    fn a_refused_attempt_asks_nothing() {
        let mut w = world("refused");
        w.begin(0);
        w.store.add(Phone { id: phone_key().to_string(), ..phone(1) }).unwrap();
        let why = w.attempt(1_000).expect_err("already paired");
        assert!(why.contains("already paired"), "{why}");
        assert_eq!(w.sent(), vec![]);
    }

    #[test]
    fn yes_pairs_and_says_paired() {
        let mut w = world("yes");
        w.begin(0);
        w.attempt(1_000).unwrap();
        w.sent();
        assert_eq!(w.answer(true, 2_000), Ok(Outcome::Paired));
        assert_eq!(w.sent(), vec![Sent::Ended(Outcome::Paired)]);
        let stored = w.store.load().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, phone_key().to_string());
        assert_eq!(stored[0].name, "Pixel");
        assert_eq!(stored[0].paired_at, 2_000);
        assert_eq!(stored[0].last_seen, None);
    }

    #[test]
    fn no_says_declined() {
        let mut w = world("no");
        w.begin(0);
        w.attempt(1_000).unwrap();
        w.sent();
        assert_eq!(w.answer(false, 2_000), Ok(Outcome::Declined));
        assert_eq!(w.sent(), vec![Sent::Ended(Outcome::Declined)]);
        assert_eq!(w.store.load(), Ok(vec![]));
    }

    #[test]
    fn an_answer_after_expiry_says_expired_and_pairs_nothing() {
        let mut w = world("expired");
        let begun = w.begin(0);
        w.attempt(1_000).unwrap();
        w.sent();
        assert_eq!(w.answer(true, begun.expires_at), Ok(Outcome::Expired));
        assert_eq!(w.sent(), vec![Sent::Ended(Outcome::Expired)]);
        assert_eq!(w.store.load(), Ok(vec![]));
    }

    #[test]
    fn an_answer_with_nothing_pending_says_declined() {
        let mut w = world("nothing");
        assert_eq!(w.answer(true, 0), Ok(Outcome::Declined));
        assert_eq!(w.sent(), vec![Sent::Ended(Outcome::Declined)]);
    }

    #[test]
    fn a_failed_write_ends_the_prompt_and_returns_the_reason() {
        let mut w = world("unwritable");
        w.begin(0);
        w.attempt(1_000).unwrap();
        w.sent();
        let path = w._dir.0.join(store::FILE);
        std::fs::write(&path, "garbage").unwrap();
        let why = w.answer(true, 2_000).expect_err("refuses");
        assert!(why.contains(&path.display().to_string()), "{why}");
        assert_eq!(w.sent(), vec![Sent::Ended(Outcome::Declined)]);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "garbage");
    }

    #[test]
    fn with_no_data_directory_only_a_yes_needs_the_store() {
        // The store is the paired list's home; nothing but adding a phone needs
        // it, so an expiry still says expired and a no still says declined.
        let gone = || Err("no data directory".to_string());

        let mut w = world("nostore-expired");
        let begun = w.begin(0);
        w.attempt(1_000).unwrap();
        w.sent();
        let got = answer(&mut w.pairing, gone(), &w.emit, true, begun.expires_at);
        assert_eq!(got, Ok(Outcome::Expired));
        assert_eq!(w.sent(), vec![Sent::Ended(Outcome::Expired)]);

        let mut w = world("nostore-no");
        w.begin(0);
        w.attempt(1_000).unwrap();
        w.sent();
        assert_eq!(answer(&mut w.pairing, gone(), &w.emit, false, 2_000), Ok(Outcome::Declined));
        assert_eq!(w.sent(), vec![Sent::Ended(Outcome::Declined)]);

        let mut w = world("nostore-yes");
        w.begin(0);
        w.attempt(1_000).unwrap();
        w.sent();
        assert_eq!(answer(&mut w.pairing, gone(), &w.emit, true, 2_000), Err("no data directory".into()));
        assert_eq!(w.sent(), vec![Sent::Ended(Outcome::Declined)]);
        assert_eq!(answer(&mut w.pairing, gone(), &w.emit, true, 2_000), Ok(Outcome::Declined), "the prompt is gone");
    }

    #[test]
    fn a_new_code_over_a_waiting_prompt_ends_it() {
        let mut w = world("replace");
        w.begin(0);
        w.attempt(1_000).unwrap();
        w.sent();
        w.begin(2_000);
        assert_eq!(w.sent(), vec![Sent::Ended(Outcome::Declined)]);
    }

    #[test]
    fn begin_on_an_unreadable_keychain_refuses_and_makes_no_key() {
        let mut w = world("locked");
        w.vault.unreadable = Some("the keychain is locked".into());
        let got = begin(&mut w.pairing, &w.vault, &w.emit, None, None, SECRET, 0);
        assert!(got.unwrap_err().contains("the keychain is locked"));
        assert_eq!(w.vault.writes.get(), 0);
    }

    #[test]
    fn the_payload_names_this_desktop_and_carries_the_secret() {
        let mut w = world("payload");
        let begun = w.begin(0);
        let parsed = PairPayload::parse(&begun.payload).expect("parses");
        assert_eq!(parsed.id, identity::read(&w.vault).unwrap().unwrap().public());
        assert_eq!(parsed.secret, SECRET);
        assert_eq!(parsed.name.as_deref(), Some("desk"));
        assert_eq!(parsed.relay, None);
        assert_eq!(begun.expires_at, pairing::CODE_TTL_MS);
        assert_eq!(begun.qr.rows.len(), begun.qr.size);
    }

    #[test]
    fn revoke_removes_the_phone_and_closes_its_connection() {
        let w = world("revoke");
        let conns = FakeConnections::default();
        w.store.add(phone(1)).unwrap();
        w.store.add(phone(2)).unwrap();
        assert_eq!(revoke(&w.store, &conns, &phone(1).id), Ok(()));
        assert_eq!(w.store.load(), Ok(vec![phone(2)]));
        assert_eq!(revoke(&w.store, &conns, "not-on-the-list"), Ok(()));
        assert_eq!(*conns.closed.borrow(), vec![phone(1).id, "not-on-the-list".to_string()]);
    }

    #[test]
    fn revoke_refuses_on_an_unreadable_list() {
        let w = world("revoke-bad");
        std::fs::write(w._dir.0.join(store::FILE), "garbage").unwrap();
        let conns = FakeConnections::default();
        assert!(revoke(&w.store, &conns, &phone(1).id).is_err());
        assert!(conns.closed.borrow().is_empty());
    }

    fn keys_of(value: &serde_json::Value) -> Vec<String> {
        let mut names: Vec<String> = value.as_object().expect("an object").keys().cloned().collect();
        names.sort();
        names
    }

    #[test]
    fn the_status_shape_never_carries_a_secret() {
        // The guard a future field would quietly break, as in `keys.rs`.
        let mut w = world("shape");
        let begun = w.begin(0);
        w.store.add(phone(1)).unwrap();
        let s = status(&w.vault, Ok(Store::in_dir(&w._dir.0)), &NoConnections, facts(Loaded::default()));
        let json = serde_json::to_value(&s).unwrap();
        // Case 2 (#344): `preview` went with the env var it reported, and the
        // settings, why they could not be read, the login item and keep awake
        // came in. None is a key; the device key stays in the keychain.
        assert_eq!(
            keys_of(&json),
            [
                "awake",
                "endpoint",
                "endpointId",
                "identityUnreadable",
                "phones",
                "phonesUnreadable",
                "settings",
                "settingsUnreadable",
                "startAtLogin",
            ]
        );
        assert_eq!(keys_of(&json["settings"]), ["enabled", "keepAwake", "relay", "startAtLogin"]);
        assert_eq!(keys_of(&json["startAtLogin"]), ["enabled", "error"]);
        assert_eq!(keys_of(&json["awake"]), ["error", "held"]);
        assert_eq!(keys_of(&json["phones"][0]), ["connected", "id", "lastSeen", "name", "pairedAt"]);

        let text = json.to_string();
        let device_secret = wire::hex(w.vault.stored.borrow().as_deref().unwrap());
        let pairing_secret = wire::hex(&PairPayload::parse(&begun.payload).unwrap().secret);
        assert!(!text.contains(&device_secret), "the device key must never be in the status");
        assert!(!text.contains(&pairing_secret), "nor the live pairing secret");
        assert_eq!(json["endpointId"], identity::read(&w.vault).unwrap().unwrap().public().to_string());
    }

    #[test]
    fn status_never_creates_a_key() {
        let w = world("nokey");
        let s = status(&w.vault, Ok(Store::in_dir(&w._dir.0)), &NoConnections, facts(Loaded::default()));
        assert_eq!(s.endpoint_id, None);
        assert_eq!(s.identity_unreadable, None);
        assert_eq!(w.vault.writes.get(), 0);
        assert!(w.vault.stored.borrow().is_none());
    }

    /// Case 2 (#344): this said *whether to draw*, which was `preview`. The
    /// section is always drawn now, so what has to always arrive is the rest of
    /// what it draws: the settings, and why they could not be read.
    #[test]
    fn status_never_fails_and_always_carries_the_settings() {
        let w = world("unreadable-status");
        let locked = FakeVault { unreadable: Some("locked".into()), ..FakeVault::default() };

        let off = Loaded::unreadable("remote.json could not be read".into());
        let s = status(&locked, Err("no data directory".into()), &NoConnections, facts(off));
        assert_eq!(s.phones_unreadable.as_deref(), Some("no data directory"));
        assert!(s.identity_unreadable.as_deref().unwrap().contains("locked"));
        assert!(s.phones.is_empty());
        assert!(!s.settings.enabled);
        assert_eq!(s.settings_unreadable.as_deref(), Some("remote.json could not be read"));

        std::fs::write(w._dir.0.join(store::FILE), "garbage").unwrap();
        let on = Loaded { settings: Settings { enabled: true, ..Settings::default() }, unreadable: None };
        let s = status(&w.vault, Ok(Store::in_dir(&w._dir.0)), &NoConnections, facts(on));
        assert!(s.phones_unreadable.is_some());
        assert!(s.phones.is_empty());
        assert!(s.settings.enabled);
        assert_eq!(s.settings_unreadable, None);
    }

    #[test]
    fn the_paired_list_admits_only_its_phones_and_fails_closed() {
        let w = world("gate");
        let listed = phone(1);
        w.store.add(listed.clone()).unwrap();
        let id: EndpointId = listed.id.parse().unwrap();
        let other: EndpointId = phone(2).id.parse().unwrap();

        let gate = PairedList(Ok(Store::in_dir(&w._dir.0)));
        assert!(gate.is_paired(&id));
        assert!(!gate.is_paired(&other));

        // A list that cannot be read admits nobody, the listed phone included.
        std::fs::write(w._dir.0.join(store::FILE), "garbage").unwrap();
        assert!(!gate.is_paired(&id));
        assert!(!PairedList(Err("no data directory".into())).is_paired(&id));
    }

    #[test]
    fn the_endpoint_report_has_the_window_s_shape() {
        use endpoint::PathKind;
        assert_eq!(serde_json::to_value(EndpointReport::Off).unwrap(), serde_json::json!({ "state": "off" }));
        assert_eq!(serde_json::to_value(EndpointReport::NoKey).unwrap(), serde_json::json!({ "state": "noKey" }));
        assert_eq!(serde_json::to_value(EndpointReport::Starting).unwrap(), serde_json::json!({ "state": "starting" }));
        assert_eq!(
            serde_json::to_value(EndpointReport::Failed { reason: "r".into() }).unwrap(),
            serde_json::json!({ "state": "failed", "reason": "r" })
        );
        let up = EndpointReport::Up {
            relays: vec![RelayInfo { url: "https://relay.example".into(), connected: true, error: None }],
            links: vec![LinkInfo { id: "p".into(), path: PathKind::Direct }],
        };
        assert_eq!(
            serde_json::to_value(up).unwrap(),
            serde_json::json!({
                "state": "up",
                "relays": [{ "url": "https://relay.example", "connected": true, "error": null }],
                "links": [{ "id": "p", "path": "direct" }],
            })
        );
    }

    /// Remote access off: the keychain is not asked, so no key is read and no
    /// endpoint is built - nothing binds, nothing reaches a relay. Case 2
    /// (#344): the flag is the switch in `remote.json`, not the env var.
    #[test]
    fn with_remote_access_off_nothing_is_read_or_started() {
        let decided = start_decision(false, || panic!("the keychain must not be asked"));
        assert!(matches!(decided, Decision::Off));
        assert_eq!(Running::default().report(), EndpointReport::Off);
        assert!(matches!(start_decision(true, || Ok(None)), Decision::NoKey));
        assert!(matches!(start_decision(true, || Err("locked".into())), Decision::Failed(ref w) if w == "locked"));
        assert!(matches!(start_decision(true, || Ok(Some(SecretKey::generate()))), Decision::Start(_)));
    }

    #[test]
    fn the_events_have_the_window_s_shape() {
        let request = PairRequest { phone_name: "p".into(), code: "012345".into(), expires_at: 9 };
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            serde_json::json!({ "phoneName": "p", "code": "012345", "expiresAt": 9 })
        );
        for (o, s) in [(Outcome::Paired, "paired"), (Outcome::Declined, "declined"), (Outcome::Expired, "expired")] {
            assert_eq!(serde_json::to_value(Ended { outcome: o }).unwrap(), serde_json::json!({ "outcome": s }));
        }
    }

    fn facts(settings: Loaded) -> Facts {
        Facts { settings, start_at_login: LoginReport::default(), awake: AwakeReport::default() }
    }

    // ---- #344: the settings, the login item, and the endpoint following them ----

    use endpoint::tests::{addr_of, key, phone as dialler, settle, Count, List};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// The OS login item, recorded. `fail` makes every change fail.
    #[derive(Default)]
    struct FakeLogin {
        calls: Mutex<Vec<&'static str>>,
        enabled: Mutex<bool>,
        fail: bool,
    }

    impl Autostart for FakeLogin {
        fn enable(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("enable");
            if self.fail {
                return Err("no autostart directory".into());
            }
            *self.enabled.lock().unwrap() = true;
            Ok(())
        }
        fn disable(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("disable");
            *self.enabled.lock().unwrap() = false;
            Ok(())
        }
        fn is_enabled(&self) -> Result<bool, String> {
            Ok(*self.enabled.lock().unwrap())
        }
    }

    fn patch(json: &str) -> Patch {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn setting_start_at_login_writes_the_file_and_asks_the_os_once() {
        let dir = Scratch::new("set-login");
        let remote = Remote::default();
        let login = FakeLogin::default();
        let next = set_settings(&remote, Ok(SettingsFile::in_dir(&dir.0)), &patch(r#"{"startAtLogin":true}"#), Some(&login))
            .unwrap();
        assert!(next.start_at_login);
        assert_eq!(*login.calls.lock().unwrap(), ["enable"]);
        assert_eq!(SettingsFile::in_dir(&dir.0).load().settings, next);
        assert_eq!(remote.desired(), next);
        assert_eq!(login_report(Some(&login), None), LoginReport { enabled: Some(true), error: None });

        // A patch that does not name it leaves the OS alone.
        set_settings(&remote, Ok(SettingsFile::in_dir(&dir.0)), &patch(r#"{"keepAwake":true}"#), Some(&login)).unwrap();
        assert_eq!(*login.calls.lock().unwrap(), ["enable"]);
    }

    #[test]
    fn a_login_item_that_cannot_be_changed_is_reported_and_the_file_is_still_written() {
        let dir = Scratch::new("set-login-fail");
        let remote = Remote::default();
        let login = FakeLogin { fail: true, ..FakeLogin::default() };
        let next = set_settings(&remote, Ok(SettingsFile::in_dir(&dir.0)), &patch(r#"{"startAtLogin":true}"#), Some(&login))
            .unwrap();
        assert!(SettingsFile::in_dir(&dir.0).load().settings.start_at_login);
        assert!(next.start_at_login);
        let last = remote.login_error.lock().unwrap().clone();
        // What the OS says wins over the file, with the reason beside it.
        assert_eq!(
            login_report(Some(&login), last),
            LoginReport { enabled: Some(false), error: Some("no autostart directory".into()) }
        );
        // And with no login item at all, that is said rather than guessed.
        assert_eq!(login_report(None, None).enabled, None);
    }

    #[test]
    fn a_refused_patch_writes_nothing_and_calls_nothing() {
        let dir = Scratch::new("set-refused");
        let remote = Remote::default();
        let login = FakeLogin::default();
        let why = set_settings(
            &remote,
            Ok(SettingsFile::in_dir(&dir.0)),
            &patch(r#"{"startAtLogin":true,"relay":"http://insecure.example"}"#),
            Some(&login),
        )
        .unwrap_err();
        assert!(why.contains("https"), "{why}");
        assert!(login.calls.lock().unwrap().is_empty());
        assert!(!dir.0.join(settings::FILE).exists());
        assert_eq!(remote.desired(), Settings::default());
        assert!(set_settings(&remote, Err("no data directory".into()), &patch("{}"), Some(&login)).is_err());
    }

    #[test]
    fn two_patches_at_once_both_persist() {
        let dir = Scratch::new("set-concurrent");
        let remote = Remote::default();
        for _ in 0..20 {
            std::thread::scope(|s| {
                s.spawn(|| set_settings(&remote, Ok(SettingsFile::in_dir(&dir.0)), &patch(r#"{"enabled":true}"#), None));
                s.spawn(|| set_settings(&remote, Ok(SettingsFile::in_dir(&dir.0)), &patch(r#"{"keepAwake":true}"#), None));
            });
            let on_disk = SettingsFile::in_dir(&dir.0).load().settings;
            assert!(on_disk.enabled && on_disk.keep_awake, "{on_disk:?}");
            assert_eq!(remote.desired(), on_disk);
            set_settings(&remote, Ok(SettingsFile::in_dir(&dir.0)), &patch(r#"{"enabled":false,"keepAwake":false}"#), None)
                .unwrap();
        }
    }

    // The endpoint following the settings, over loopback.

    fn want(remote: &Remote, enabled: bool, relay: Option<&str>) {
        *remote.loaded() =
            Loaded { settings: Settings { enabled, relay: relay.map(str::to_string), ..Settings::default() }, unreadable: None };
    }

    /// A loopback endpoint admitting `gate`, its connections announced into
    /// `announced`, and its address recorded once bound.
    fn loopback(
        gate: Arc<dyn Gate>,
        announced: Arc<AtomicUsize>,
        built: Arc<Mutex<Vec<iroh::EndpointAddr>>>,
    ) -> impl FnOnce(SecretKey, Option<RelayUrl>) -> std::pin::Pin<Box<dyn Future<Output = Result<RemoteEndpoint, String>> + Send>>
    {
        move |key, _relay| {
            Box::pin(async move {
                let live = Live::notifying(move || {
                    announced.fetch_add(1, Ordering::SeqCst);
                });
                let ep = RemoteEndpoint::start_with(
                    Config { key, reach: Reach::Loopback },
                    gate,
                    live,
                    Count::default(),
                    Count::default(),
                )
                .await?;
                built.lock().unwrap().push(addr_of(&ep));
                Ok(ep)
            })
        }
    }

    struct Rig {
        remote: Remote,
        gate: Arc<List>,
        announced: Arc<AtomicUsize>,
        built: Arc<Mutex<Vec<iroh::EndpointAddr>>>,
        key: SecretKey,
        phone_key: SecretKey,
    }

    impl Rig {
        fn new() -> Self {
            let phone_key = key();
            Rig {
                remote: Remote::default(),
                gate: List::with(&[phone_key.public()]),
                announced: Arc::default(),
                built: Arc::default(),
                key: key(),
                phone_key,
            }
        }
        async fn reconcile(&self) {
            let key = self.key.clone();
            reconcile_with(&self.remote, move || Ok(Some(key)), self.build()).await;
        }
        fn build(&self) -> impl FnOnce(SecretKey, Option<RelayUrl>) -> std::pin::Pin<Box<dyn Future<Output = Result<RemoteEndpoint, String>> + Send>> {
            loopback(self.gate.clone(), self.announced.clone(), self.built.clone())
        }
        fn report(&self) -> EndpointReport {
            self.remote.running().report()
        }
        fn addr(&self) -> iroh::EndpointAddr {
            match &*self.remote.running() {
                Running::Up { ep, .. } => addr_of(ep),
                _ => panic!("not up"),
            }
        }
        fn live(&self) -> Live {
            match &*self.remote.running() {
                Running::Up { ep, .. } => ep.connections().clone(),
                _ => panic!("not up"),
            }
        }
        /// A paired phone, connected.
        async fn connect(&self) -> (iroh::Endpoint, iroh::endpoint::Connection) {
            let p = dialler(self.phone_key.clone()).await;
            let conn = p.connect(self.addr(), endpoint::REMOTE_ALPN).await.expect("a paired phone connects");
            settle().await;
            (p, conn)
        }
    }

    async fn closed(conn: &iroh::endpoint::Connection) {
        tokio::time::timeout(Duration::from_secs(10), conn.closed()).await.expect("the connection closes");
    }

    /// Nothing answers at `addr` any more: a dial fails or never completes.
    async fn nothing_listening(addr: iroh::EndpointAddr) {
        let p = dialler(key()).await;
        let dialled = tokio::time::timeout(Duration::from_secs(3), p.connect(addr, endpoint::REMOTE_ALPN)).await;
        assert!(!matches!(dialled, Ok(Ok(_))), "something still answers at the old address");
    }

    #[tokio::test]
    async fn turning_remote_access_off_drops_a_connected_phone_and_leaves_nothing_listening() {
        let rig = Rig::new();
        want(&rig.remote, true, None);
        rig.reconcile().await;
        assert!(matches!(rig.report(), EndpointReport::Up { .. }));
        let addr = rig.addr();
        let (_p, conn) = rig.connect().await;
        assert_eq!(rig.announced.load(Ordering::SeqCst), 1);

        want(&rig.remote, false, None);
        // Off asks nothing of the keychain.
        reconcile_with(&rig.remote, || panic!("off reads no key"), rig.build()).await;
        assert_eq!(rig.report(), EndpointReport::Off);
        closed(&conn).await;
        settle().await;
        assert_eq!(rig.announced.load(Ordering::SeqCst), 2, "one disconnect, from the connection's guard");
        nothing_listening(addr).await;
    }

    #[tokio::test]
    async fn turning_off_from_waiting_for_a_key_or_failed_is_off() {
        let rig = Rig::new();
        want(&rig.remote, true, None);
        reconcile_with(&rig.remote, || Ok(None), rig.build()).await;
        assert_eq!(rig.report(), EndpointReport::NoKey);
        want(&rig.remote, false, None);
        reconcile_with(&rig.remote, || panic!("off reads no key"), rig.build()).await;
        assert_eq!(rig.report(), EndpointReport::Off);

        want(&rig.remote, true, None);
        reconcile_with(&rig.remote, || Ok(Some(key())), |_, _| async { Err::<RemoteEndpoint, _>("no socket".to_string()) })
            .await;
        assert_eq!(rig.report(), EndpointReport::Failed { reason: "no socket".into() });
        want(&rig.remote, false, None);
        reconcile_with(&rig.remote, || panic!("off reads no key"), rig.build()).await;
        assert_eq!(rig.report(), EndpointReport::Off);
    }

    #[tokio::test]
    async fn a_relay_change_stops_the_old_endpoint_completely_before_binding_the_new_one() {
        let rig = Rig::new();
        want(&rig.remote, true, Some("https://a.example"));
        rig.reconcile().await;
        let old = rig.addr();
        let old_live = rig.live();
        let (_p, conn) = rig.connect().await;
        assert!(old_live.connected(&rig.phone_key.public()));

        want(&rig.remote, true, Some("https://b.example"));
        let seen_old_open = Arc::new(Mutex::new(None));
        let seen = seen_old_open.clone();
        let phone_id = rig.phone_key.public();
        let build = rig.build();
        let k = rig.key.clone();
        reconcile_with(&rig.remote, move || Ok(Some(k)), move |key, relay| {
            *seen.lock().unwrap() = Some(old_live.connected(&phone_id));
            build(key, relay)
        })
        .await;
        assert_eq!(*seen_old_open.lock().unwrap(), Some(false), "the old endpoint had stopped before the new bind");
        match &*rig.remote.running() {
            Running::Up { relay, .. } => assert_eq!(relay.as_deref(), Some("https://b.example")),
            _ => panic!("not up after the restart"),
        }
        closed(&conn).await;
        nothing_listening(old).await;
    }

    #[tokio::test]
    async fn rapid_toggles_end_with_exactly_one_endpoint() {
        let rig = Arc::new(Rig::new());
        let mut tasks = Vec::new();
        for on in [true, false, true, false, true] {
            want(&rig.remote, on, None);
            let rig = rig.clone();
            tasks.push(tokio::spawn(async move { rig.reconcile().await }));
            tokio::task::yield_now().await;
        }
        for t in tasks {
            t.await.unwrap();
        }
        assert!(matches!(rig.report(), EndpointReport::Up { .. }));
        let up = rig.addr();
        let built = rig.built.lock().unwrap().clone();
        assert!(!built.is_empty());
        for addr in built.into_iter().filter(|a| a.id != up.id || *a != up) {
            nothing_listening(addr).await;
        }
    }

    #[tokio::test]
    async fn an_endpoint_bound_after_the_switch_went_off_is_stopped_not_installed() {
        let rig = Rig::new();
        want(&rig.remote, true, None);
        let build = rig.build();
        let remote_ref = &rig.remote;
        let k = rig.key.clone();
        reconcile_with(remote_ref, move || Ok(Some(k)), |key, relay| {
            // The switch goes off while this endpoint is binding.
            want(remote_ref, false, None);
            build(key, relay)
        })
        .await;
        assert_eq!(rig.report(), EndpointReport::Off);
        let built = rig.built.lock().unwrap().clone();
        assert_eq!(built.len(), 1);
        nothing_listening(built[0].clone()).await;
    }

    /// A phone's closing change: its guard is taken before it answers, and the
    /// stop waits for its answer. A desktop change arriving meanwhile waits too,
    /// so it can neither close the phone first nor bind beside the old endpoint.
    #[tokio::test]
    async fn a_phone_s_closing_change_holds_every_other_change_until_its_answer_arrived() {
        let rig = Arc::new(Rig::new());
        want(&rig.remote, true, None);
        rig.reconcile().await;
        let old_live = rig.live();
        let (_p, conn) = rig.connect().await;

        // The phone turns it off: the guard is taken, the stop waits on `written`.
        want(&rig.remote, false, None);
        let guard = rig.remote.transition.clone().lock_owned().await;
        assert!(closes_connections(&rig.remote.running(), &rig.remote.desired()));
        let (reached, written) = tokio::sync::oneshot::channel();
        let phone_task = {
            let rig = rig.clone();
            tokio::spawn(async move {
                reconcile_locked(&rig.remote, || panic!("off reads no key"), rig.build(), Some(Written(written))).await;
                drop(guard);
            })
        };

        // Once the phone's task has taken the endpoint out and is waiting on
        // the answer, the window turns it straight back on.
        tokio::time::timeout(Duration::from_secs(10), async {
            while !matches!(rig.report(), EndpointReport::Off) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the phone's change takes the endpoint out");
        want(&rig.remote, true, None);
        let builds = Arc::new(AtomicUsize::new(0));
        let desktop_task = {
            let rig = rig.clone();
            let builds = builds.clone();
            let old_live = old_live.clone();
            let phone_id = rig.phone_key.public();
            tokio::spawn(async move {
                let build = rig.build();
                let k = rig.key.clone();
                reconcile_with(&rig.remote, move || Ok(Some(k)), move |key, relay| {
                    builds.fetch_add(1, Ordering::SeqCst);
                    assert!(!old_live.connected(&phone_id), "bound beside an endpoint still running");
                    build(key, relay)
                })
                .await;
            })
        };

        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(conn.close_reason().is_none(), "nothing closed the phone before its answer arrived");
        assert_eq!(builds.load(Ordering::SeqCst), 0, "nothing bound while the phone's change held the lock");

        reached.send(()).unwrap();
        phone_task.await.unwrap();
        desktop_task.await.unwrap();
        closed(&conn).await;
        assert_eq!(builds.load(Ordering::SeqCst), 1);
        assert!(matches!(rig.report(), EndpointReport::Up { .. }));
    }

    #[test]
    fn a_file_saying_on_starts_the_endpoint_with_no_window() {
        // What `setup` decides: `load` then `start_decision`, nothing else.
        let dir = Scratch::new("setup-decision");
        std::fs::write(dir.0.join(settings::FILE), r#"{"enabled":true}"#).unwrap();
        let loaded = SettingsFile::in_dir(&dir.0).load();
        assert!(matches!(start_decision(loaded.settings.enabled, || Ok(Some(key()))), Decision::Start(_)));

        std::fs::write(dir.0.join(settings::FILE), r#"{"enabled":true,"relay":"#).unwrap();
        let loaded = SettingsFile::in_dir(&dir.0).load();
        assert!(loaded.unreadable.is_some());
        assert!(matches!(
            start_decision(loaded.settings.enabled, || panic!("a file that cannot be read reads no key")),
            Decision::Off
        ));
    }
}
