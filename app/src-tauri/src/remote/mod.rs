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
//! **No timer for pairing.** An unanswered prompt is closed by the window when
//! its clock reaches `expiresAt`, which it already holds; Rust says `expired`
//! only when an answer arrives too late. The phone's side of the wait is
//! bounded by the code's own life in `handshake.rs`.
//!
//! **One retry timer** (#477): the retry worker. A start that failed in a way
//! that passes by itself - the keychain's service failing (`PlatformFailure`)
//! or the endpoint not binding - is tried again after 2s, 5s, 15s, 30s and
//! then every 60s, while remote access is on. A locked keychain, a malformed
//! key and no key wait for the person. What bounds it: one worker per app and
//! one episode at a time, belonging to one generation. Every start outside
//! the worker - the launch, a pairing code's, and every `remote_set`, off
//! included - moves the generation, ending the episode; one that fails again
//! starts the schedule from its first step. One keychain read in
//! flight, read outside the transition lock, and checked under it before it is
//! dispatched and again before it is applied. At the 60s cadence an unchanged
//! failure is not logged again, and every change of state it causes is pushed
//! to the window.

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
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
use identity::{Keychain, Unread, Unreadable, Vault};
use pairing::{Answer, Pairing};
use qr::QrMatrix;
use settings::{Loaded, Patch, Settings, SettingsFile};
use store::{Phone, Store};
use vibe_remote::REMOTE_OFF;
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
    /// Moved by every `remote_set`, the window's and a phone's, under the
    /// transition lock (#477). A retry episode belongs to one generation: a
    /// person's change, off included, ends it.
    generation: tokio::sync::watch::Sender<u64>,
    /// The generation a retry episode is wanted for, or none. Set by [`arm`],
    /// cleared by the episode when it ends.
    episode: tokio::sync::watch::Sender<Option<u64>>,
    /// Held by a retry's keychain read until the read returns, abandoned or
    /// not, so there is never more than one in flight: an unanswered unlock
    /// prompt can hold one for as long as the prompt stays up.
    read_slot: Arc<tokio::sync::Mutex<()>>,
    /// Claimed by the one retry worker, so a second returns at once.
    worker: AtomicBool,
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
    Failed(Failure),
}

/// Why a start failed, and whether it passes by itself (#477).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Cause {
    /// The device key could not be read; the kind says what could fix it.
    Key(Unread),
    /// The endpoint would not bind. Prompt-free, and can pass by itself: no
    /// network yet at login.
    Bind,
}

/// A start that failed: the sentence, its cause, and whether the retry worker
/// has it.
#[derive(Debug)]
struct Failure {
    why: String,
    cause: Cause,
    retrying: bool,
}

impl Failure {
    /// A keychain service that failed, or a bind. Everything else - a locked
    /// keychain, a malformed key - needs the person, as `NoKey` does.
    fn retryable(&self) -> bool {
        matches!(self.cause, Cause::Bind | Cause::Key(Unread::Transient))
    }

    /// What the settings screen shows: being retried, or what to do (#477).
    /// `why` is the sentence the log has, which never carries key material.
    fn reason(&self) -> String {
        let why = &self.why;
        match self.cause {
            _ if self.retryable() && self.retrying => format!("{why}; trying again by itself"),
            _ if self.retryable() => why.clone(),
            Cause::Key(Unread::Locked) => format!("{why}. Unlock your keychain, then turn remote access off and on."),
            // Never *delete it* or *replace it*: a new key is a new desktop to
            // every paired phone (`identity.rs`).
            Cause::Key(Unread::Malformed) => format!(
                "{why}. Remote access cannot start with it. A new key would make this a new desktop to every \
                 paired phone, and each would have to pair again, so none is made."
            ),
            Cause::Key(_) | Cause::Bind => format!("{why}. Turn remote access off and on to try again."),
        }
    }
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
            Running::Failed(failure) => EndpointReport::Failed { reason: failure.reason() },
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

/// How one start ended: the line `vibe-desktop.log` gets for it (#476). The
/// reconcile returns it rather than logging it, so the retry worker can say
/// which attempt it was and hold back a repeat (#477); every other caller logs
/// it at once, through [`reconcile_locked`].
#[derive(Debug)]
enum Started {
    Off,
    NoKey,
    Unreadable(String),
    BindFailed(String),
    Up(EndpointId),
    Superseded(EndpointId),
}

impl Started {
    /// #476's sentences, unchanged, without the `remote access: ` prefix.
    fn sentence(&self) -> String {
        match self {
            Started::Off => "off, so no endpoint".into(),
            Started::NoKey => "no device key, so no endpoint".into(),
            Started::Unreadable(why) => format!("could not read the device key: {why}"),
            Started::BindFailed(why) => why.clone(),
            Started::Up(id) => format!("endpoint {id} is up"),
            Started::Superseded(id) => {
                format!("endpoint {id} was bound for settings that have since changed, so it was stopped")
            }
        }
    }

    fn failed(&self) -> bool {
        matches!(self, Started::Unreadable(_) | Started::BindFailed(_))
    }
}

/// Make the endpoint match the settings, with the transition lock held by the
/// caller, and log how the start ended.
///
/// - **Off**: an endpoint that is up is stopped - after `after` resolves, when
///   a phone's answer has to reach it first - and every other state becomes
///   `Off`, so the window never reads *waiting for a key* or *failed* about a
///   switch that is off.
/// - **On**: an endpoint up under a different relay is stopped, **completely**,
///   and then one is started; `NoKey` and `Failed` are tried again when this is
///   called. After a bind the settings are read once more, and an endpoint
///   bound for settings that have since changed is stopped rather than
///   installed; the change that moved them has its own reconcile queued behind
///   this one.
///
/// Nothing here waits and tries again. A failure that passes by itself - the
/// keychain's service failing, or a bind - is handed to the retry worker by
/// [`arm`] (#477); `NoKey`, a locked keychain and a malformed key wait for the
/// person.
///
/// `build` binds an endpoint; the app's is the real one, the tests' a loopback.
async fn reconcile_locked<K, B, F>(remote: &Remote, read_key: K, build: B, after: Option<Written>)
where
    K: FnOnce() -> Result<Option<SecretKey>, Unreadable>,
    B: FnOnce(SecretKey, Option<RelayUrl>) -> F,
    F: Future<Output = Result<RemoteEndpoint, String>>,
{
    // Every outcome of a start is one line in `vibe-desktop.log` (#476). On
    // 2026-10-26 gnome-keyring dumped core as 1.9.0 started, the device key
    // could not be read, and the log said nothing: the reason was in `Failed`
    // and on the settings screen, and nowhere a person reading the log after
    // the fact would look. A key's sentence is the one `identity::read`
    // builds, which names the keychain's error and never the bytes.
    //
    // Every pass through here logs, and nothing is deduplicated: this runs at
    // launch, after the first pairing code, and on a settings change from the
    // window or a phone, so each line is a keychain read a person caused, and
    // a repeat is the evidence that they tried again. The retry worker does
    // not come through here; it logs the same sentences under its own rule for
    // repeats (#477).
    if let Some(started) = reconcile_core(remote, read_key, build, after).await {
        crate::applog::app(&format!("remote access: {}", started.sentence()));
    }
}

/// [`reconcile_locked`]'s work, returning how the start ended instead of
/// logging it. `None` is an endpoint that was up and stays up: not a start.
async fn reconcile_core<K, B, F>(remote: &Remote, read_key: K, build: B, after: Option<Written>) -> Option<Started>
where
    K: FnOnce() -> Result<Option<SecretKey>, Unreadable>,
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
        let asker = after.as_ref().map(|w| w.asker);
        if let Some(after) = after {
            after.wait().await;
        }
        // Remote access is going off: every phone is told so with REMOTE_OFF
        // (#346) before the endpoint stops, the one that asked first and by id,
        // once its answer has arrived. A relay change closes with no code: the
        // endpoint comes straight back under the same id.
        if !desired.enabled {
            if let Some(asker) = asker {
                ep.connections().close_with(&asker, REMOTE_OFF, REMOTE_OFF_REASON);
            }
            ep.connections().close_all(REMOTE_OFF, REMOTE_OFF_REASON);
        }
        let id = ep.id();
        ep.stop().await;
        // A stop is not how a start ended, so it is said where it happens.
        crate::applog::app(&format!("remote access: endpoint {id} stopped"));
    }
    if desired.enabled && matches!(*remote.running(), Running::Up { .. }) {
        return None;
    }
    let mut kind = Unread::Other;
    let decided = start_decision(desired.enabled, || {
        read_key().map_err(|e| {
            kind = e.kind;
            e.why
        })
    });
    let key = match decided {
        Decision::Start(key) => key,
        Decision::Off => return Some(Started::Off),
        Decision::NoKey => {
            *remote.running() = Running::NoKey;
            return Some(Started::NoKey);
        }
        Decision::Failed(why) => {
            *remote.running() = Running::Failed(Failure { why: why.clone(), cause: Cause::Key(kind), retrying: false });
            return Some(Started::Unreadable(why));
        }
    };
    *remote.running() = Running::Starting;
    let built = build(key, settings::relay_url(&desired)).await;
    let now = remote.desired();
    let current = now.enabled && now.relay == desired.relay;
    Some(match built {
        Ok(ep) if current => {
            let id = ep.id();
            *remote.running() = Running::Up { ep, relay: desired.relay };
            Started::Up(id)
        }
        Ok(ep) => {
            *remote.running() = Running::Off;
            let id = ep.id();
            ep.stop().await;
            Started::Superseded(id)
        }
        Err(why) => {
            *remote.running() = if current {
                Running::Failed(Failure { why: why.clone(), cause: Cause::Bind, retrying: false })
            } else {
                Running::Off
            };
            Started::BindFailed(why)
        }
    })
}

/// The reason bytes beside [`REMOTE_OFF`]; the phone reads the code.
const REMOTE_OFF_REASON: &[u8] = b"remote access is off";

/// `reconcile_locked`, taking the lock, with a key read that says only why it
/// failed. Kept for the tests written before #477 classified a failed read;
/// such a failure is `Other`, so it is never retried.
#[cfg(test)]
async fn reconcile_with<K, B, F>(remote: &Remote, read_key: K, build: B)
where
    K: FnOnce() -> Result<Option<SecretKey>, String>,
    B: FnOnce(SecretKey, Option<RelayUrl>) -> F,
    F: Future<Output = Result<RemoteEndpoint, String>>,
{
    let _guard = remote.transition.lock().await;
    reconcile_locked(remote, || read_key().map_err(|why| Unreadable { why, kind: Unread::Other }), build, None).await;
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

/// Something the desktop keeps outside the host changed, by any client (#371):
/// a stored key, or remote access's settings and paired phones. The window and
/// every phone re-read it with the read they already use - `key_status` or
/// `remote_status` - so this carries which, and never a value.
pub(crate) const DESKTOP_CHANGED_EVENT: &str = "desktop://changed";

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Changed {
    Keys,
    Remote,
}

pub(crate) fn desktop_changed(app: &AppHandle, what: Changed) {
    hub::emit(app, DESKTOP_CHANGED_EVENT, &what);
}

/// Start the endpoint, if remote access is on and there is a key to start it
/// with, without waiting. Called at launch and after the first pairing code
/// makes the key.
///
/// The window is told once the start has ended (#477): it redraws only on a
/// push, and a launch that failed used to leave it drawing whatever it read
/// before the start had finished.
pub(crate) fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let remote = app.state::<Remote>();
        {
            let _guard = remote.transition.lock().await;
            let built = app.clone();
            reconcile_and_arm(&remote, Keychain::read_key, move |key, relay| build_endpoint(built, key, relay), None)
                .await;
        }
        desktop_changed(&app, Changed::Remote);
    });
}

/// When a start that failed by itself is tried again (#477).
///
/// `ramp` is waited before each of the first attempts, in order, and `steady`
/// before every one after, for as long as remote access is on. A struct so
/// the tests can make every wait a few milliseconds rather than pausing time,
/// which the loopback endpoints they bind would not survive.
pub(crate) struct Schedule {
    ramp: &'static [Duration],
    steady: Duration,
}

impl Schedule {
    /// How long to wait before `attempt` (from 1), and whether that is the
    /// steady cadence, where an unchanged failure is not logged again.
    fn step(&self, attempt: usize) -> (Duration, bool) {
        match attempt.checked_sub(1).and_then(|i| self.ramp.get(i)) {
            Some(wait) => (*wait, false),
            None => (self.steady, true),
        }
    }
}

/// 2s, 5s, 15s, 30s, then every 60s while `remote.json` says enabled, with no
/// cap on the attempts. **A choice, not a measurement**: nothing was timed to
/// pick these. The ramp covers a keychain daemon coming back after a crash -
/// on 2026-10-26 it was back within a second - and the network arriving
/// after login; the minute is how long a desktop that never recovers by
/// itself waits between reads it will log only when something changes.
const RETRY: Schedule = Schedule {
    ramp: &[Duration::from_secs(2), Duration::from_secs(5), Duration::from_secs(15), Duration::from_secs(30)],
    steady: Duration::from_secs(60),
};

impl Remote {
    /// A start outside the retry worker: any retry episode belongs to the
    /// generation before it. Called under the transition lock.
    fn bump(&self) {
        self.generation.send_modify(|g| *g += 1);
    }
}

/// Mark a failure that passes by itself as being retried, so the settings
/// screen says so. False for anything else.
fn mark_retrying(remote: &Remote) -> bool {
    match &mut *remote.running() {
        Running::Failed(failure) if failure.retryable() => {
            failure.retrying = true;
            true
        }
        _ => false,
    }
}

/// Hand a failure that passes by itself to the retry worker, under the
/// transition lock. The start before it has moved the generation, so a new
/// episode starts the schedule from its first step.
fn arm(remote: &Remote) {
    if !mark_retrying(remote) {
        return;
    }
    let generation = *remote.generation.borrow();
    remote.episode.send_if_modified(|wanted| {
        if *wanted == Some(generation) {
            false
        } else {
            *wanted = Some(generation);
            true
        }
    });
}

/// [`reconcile_locked`], then [`arm`]: what every caller outside the retry
/// worker runs - the launch, a pairing code's start, the window's and a
/// phone's `remote_set` - with the transition lock held.
///
/// **Each moves the generation first**, so any retry episode ends and a read
/// it has in flight is never applied. A pairing code's start has to as well:
/// a retry that read *no key* just before the first code made one, and came
/// back after that start's bind had failed, would otherwise have turned the
/// newer, retryable failure into `NoKey` and stopped retrying.
async fn reconcile_and_arm<K, B, F>(remote: &Remote, read_key: K, build: B, after: Option<Written>)
where
    K: FnOnce() -> Result<Option<SecretKey>, Unreadable>,
    B: FnOnce(SecretKey, Option<RelayUrl>) -> F,
    F: Future<Output = Result<RemoteEndpoint, String>>,
{
    remote.bump();
    reconcile_locked(remote, read_key, build, after).await;
    arm(remote);
}

/// Start the one retry worker on Tauri's runtime. Called once, in `setup`; it
/// parks until a failure is armed.
pub(crate) fn spawn_retries(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let remote = app.state::<Remote>();
        let built = app.clone();
        let told = app.clone();
        retry_worker(
            &remote,
            &RETRY,
            Arc::new(Keychain::read_key),
            move |key, relay| build_endpoint(built.clone(), key, relay),
            move || desktop_changed(&told, Changed::Remote),
        )
        .await;
    });
}

/// Why an episode cannot make its next attempt, or `None` when it can. With
/// the transition lock held, so nothing can change the answer before the
/// attempt has been dispatched or applied.
fn ineligible(remote: &Remote, generation: u64) -> Option<&'static str> {
    if !remote.desired().enabled {
        return Some("remote access was turned off");
    }
    if *remote.generation.borrow() != generation {
        return Some("another start made its own attempt");
    }
    match &*remote.running() {
        Running::Failed(failure) if failure.retryable() => None,
        Running::Up { .. } => Some("the endpoint was started by another change"),
        _ => Some("the last attempt needs you to act"),
    }
}

/// Resolves once a person's change has moved the generation past `generation`.
async fn moved(seen: &mut tokio::sync::watch::Receiver<u64>, generation: u64) {
    loop {
        if *seen.borrow_and_update() != generation {
            return;
        }
        if seen.changed().await.is_err() {
            // The sender is the `Remote` itself, which outlives the worker.
            std::future::pending::<()>().await;
        }
    }
}

/// End the episode for `generation`, unless a newer one has already been
/// armed, and say so in the log.
fn finish(remote: &Remote, generation: u64, attempt: usize, cause: &str) {
    end_episode(remote, generation);
    crate::applog::app(&format!("remote access: retry {attempt}: stopped: {cause}"));
}

fn end_episode(remote: &Remote, generation: u64) {
    remote.episode.send_if_modified(|wanted| {
        if *wanted == Some(generation) {
            *wanted = None;
            true
        } else {
            false
        }
    });
}

/// Why a person's change ended an episode.
fn moved_cause(remote: &Remote) -> &'static str {
    if remote.desired().enabled {
        "another start made its own attempt"
    } else {
        "remote access was turned off"
    }
}

/// The retry worker (#477): one per app, running one episode at a time.
///
/// A borrowed future its caller spawns - the app on Tauri's runtime, a test
/// on its own - so every line it logs is written on the runtime that drives
/// it, where `applog::heard` hears a test's. The keychain read is the only
/// part on another thread, and it logs nothing.
///
/// A second worker on the same `Remote` returns at once. A new episode is the
/// same worker ending the one before and starting from the first step, so
/// two never run beside each other.
async fn retry_worker<R, B, F, N>(remote: &Remote, schedule: &Schedule, read: Arc<R>, build: B, notify: N)
where
    R: Fn() -> Result<Option<SecretKey>, Unreadable> + Send + Sync + 'static,
    B: Fn(SecretKey, Option<RelayUrl>) -> F,
    F: Future<Output = Result<RemoteEndpoint, String>>,
    N: Fn(),
{
    if remote.worker.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let mut wanted = remote.episode.subscribe();
    loop {
        let generation = loop {
            if let Some(generation) = *wanted.borrow_and_update() {
                break generation;
            }
            if wanted.changed().await.is_err() {
                return;
            }
        };
        episode(remote, generation, schedule, &read, &build, &notify).await;
    }
}

/// Retry a failed start until it comes up, needs the person, or another start
/// ends it.
///
/// Every attempt is checked under the transition lock twice: before its read
/// is dispatched, so nothing is read once access is off or another start has
/// moved the generation - a locked keychain left by a pairing code's start is
/// never asked again, which would put its prompt back up - and before its
/// result is applied, so a read that finished after another start is dropped. The
/// read itself runs on a blocking thread outside the lock, so a person's *off*
/// never waits behind an unlock prompt.
///
/// **What is logged** (the rule #476 left to this): during the ramp every
/// attempt and its outcome; at the steady cadence a failure only when its
/// sentence differs from the last one logged, because `vibe-desktop.log` is
/// never rotated and a desktop with no Secret Service at all would otherwise
/// write the same line 1,440 times a day; always the recovery; and always the
/// end of an episode that did not recover.
///
/// **What the window is told**: every change of state an attempt causes. An
/// attempt that binds is pushed as it enters `Starting` and again when it
/// leaves it, even for the same failure as before, because the window may have
/// read `Starting` in between.
async fn episode<R, B, F, N>(remote: &Remote, generation: u64, schedule: &Schedule, read: &Arc<R>, build: &B, notify: &N)
where
    R: Fn() -> Result<Option<SecretKey>, Unreadable> + Send + Sync + 'static,
    B: Fn(SecretKey, Option<RelayUrl>) -> F,
    F: Future<Output = Result<RemoteEndpoint, String>>,
    N: Fn(),
{
    let mut seen = remote.generation.subscribe();
    let mut last_logged: Option<String> = None;
    let mut attempt = 0;
    loop {
        attempt += 1;
        let (wait, steady) = schedule.step(attempt);
        tokio::select! {
            biased;
            _ = moved(&mut seen, generation) => return finish(remote, generation, attempt, moved_cause(remote)),
            _ = tokio::time::sleep(wait) => {}
        }
        let slot = tokio::select! {
            biased;
            _ = moved(&mut seen, generation) => return finish(remote, generation, attempt, moved_cause(remote)),
            slot = remote.read_slot.clone().lock_owned() => slot,
        };
        let reading = {
            let _guard = remote.transition.lock().await;
            if let Some(cause) = ineligible(remote, generation) {
                return finish(remote, generation, attempt, cause);
            }
            let read = read.clone();
            tokio::task::spawn_blocking(move || {
                let _slot = slot;
                read()
            })
        };
        let result = tokio::select! {
            biased;
            _ = moved(&mut seen, generation) => return finish(remote, generation, attempt, moved_cause(remote)),
            read = reading => read.unwrap_or_else(|e| {
                Err(Unreadable { why: format!("the keychain read did not finish: {e}"), kind: Unread::Transient })
            }),
        };
        let _guard = remote.transition.lock().await;
        if let Some(cause) = ineligible(remote, generation) {
            return finish(remote, generation, attempt, cause);
        }
        let before = remote.running().report();
        let started = reconcile_core(
            remote,
            move || result,
            |key, relay| {
                // `Starting` is set by now, and the window may read it.
                notify();
                build(key, relay)
            },
            None,
        )
        .await;
        mark_retrying(remote);
        let bound = matches!(started, Some(Started::Up(_) | Started::BindFailed(_) | Started::Superseded(_)));
        if let Some(started) = &started {
            let sentence = started.sentence();
            if !steady || !started.failed() || last_logged.as_deref() != Some(sentence.as_str()) {
                crate::applog::app(&format!("remote access: retry {attempt}: {sentence}"));
                last_logged = Some(sentence);
            }
        }
        if bound || remote.running().report() != before {
            notify();
        }
        let (up, again) = match &*remote.running() {
            Running::Up { .. } => (true, false),
            Running::Failed(failure) => (false, failure.retryable()),
            _ => (false, false),
        };
        if up {
            end_episode(remote, generation);
            return;
        }
        if !again {
            return finish(remote, generation, attempt, "the last attempt needs you to act");
        }
    }
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

/// Take the transition lock, **then** apply a patch, and hand the lock back.
///
/// Every `remote_set` - the window's and a phone's - goes through here, so a
/// patch and the endpoint change it decides are one step. A patch written
/// before the lock let another caller's reconcile act on it first: a phone's
/// *off*, written and then waiting for the lock, was stopped by the window's
/// reconcile, and found nothing left to hold for its own answer. The order is
/// the transition lock, then the settings lock, everywhere.
async fn patch_locked<F>(remote: &Remote, apply: F) -> Result<tokio::sync::OwnedMutexGuard<()>, String>
where
    F: FnOnce() -> Result<Settings, String>,
{
    let guard = remote.transition.clone().lock_owned().await;
    apply()?;
    Ok(guard)
}

/// `remote_set`: the switch, start at login, keep awake and the relay (#344).
///
/// **The window's call answers once the endpoint has reached the new state**,
/// so *off* means nothing is listening any more.
#[tauri::command]
pub async fn remote_set(patch: Patch, app: AppHandle, remote: State<'_, Remote>) -> Result<RemoteStatus, String> {
    let _guard = patch_locked(&remote, || apply_patch(&app, &remote, &patch)).await?;
    let built = app.clone();
    reconcile_and_arm(&remote, Keychain::read_key, move |key, relay| build_endpoint(built, key, relay), None).await;
    desktop_changed(&app, Changed::Remote);
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
/// connection**, so the transition lock is taken before the patch is written -
/// nothing else can stop or start the endpoint from here on - the answer describes the state
/// that has been decided, and the stop waits for `written`: until the phone's
/// answer has reached it.
pub(crate) async fn set_remote_from_phone(
    app: &AppHandle,
    remote: &Remote,
    patch: Patch,
    written: Written,
) -> Result<RemoteStatus, String> {
    let guard = patch_locked(remote, || apply_patch(app, remote, &patch)).await?;
    let desired = remote.desired();
    if !closes_connections(&remote.running(), &desired) {
        drop(written);
        reconcile_and_arm(remote, Keychain::read_key, |key, relay| build_endpoint(app.clone(), key, relay), None)
            .await;
        drop(guard);
        desktop_changed(app, Changed::Remote);
        return Ok(status_now(app, remote));
    }
    let mut decided = status_now(app, remote);
    decided.endpoint = if desired.enabled { EndpointReport::Starting } else { EndpointReport::Off };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let remote = app.state::<Remote>();
        let built = app.clone();
        reconcile_and_arm(
            &remote,
            Keychain::read_key,
            move |key, relay| build_endpoint(built, key, relay),
            Some(written),
        )
        .await;
        drop(guard);
        // Heard by the window: the phone that asked has been closed by now.
        desktop_changed(&app, Changed::Remote);
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
    }?;
    desktop_changed(app, Changed::Remote);
    Ok(())
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

    /// The application code a connection was closed with, once it has closed.
    async fn closed_code(conn: &iroh::endpoint::Connection) -> Option<u64> {
        match tokio::time::timeout(Duration::from_secs(10), conn.closed()).await.expect("the connection closes") {
            iroh::endpoint::ConnectionError::ApplicationClosed(c) => Some(c.error_code.into_inner()),
            _ => None,
        }
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
        // Case 2 (#346): the phone is told why, with REMOTE_OFF.
        assert_eq!(closed_code(&conn).await, Some(REMOTE_OFF as u64));
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

    /// #476: a start that found no key, or could not read one, said nothing in
    /// `vibe-desktop.log`. Every arm of `Decision` now writes exactly one line,
    /// and the up line names the public id, never the secret.
    #[tokio::test]
    async fn every_start_outcome_writes_exactly_one_log_line() {
        use crate::applog::heard;
        use crate::remote::identity::tests::FakeVault;
        let rig = Rig::new();
        heard::listen();

        // Off: the keychain is not asked.
        want(&rig.remote, false, None);
        reconcile_with(&rig.remote, || panic!("off reads no key"), rig.build()).await;
        assert_eq!(heard::take(), ["remote access: off, so no endpoint"]);

        // NoKey.
        want(&rig.remote, true, None);
        reconcile_with(&rig.remote, || Ok(None), rig.build()).await;
        assert_eq!(heard::take(), ["remote access: no device key, so no endpoint"]);
        assert_eq!(rig.report(), EndpointReport::NoKey);

        // Failed, through the real `identity::read` and the keyring crate's own
        // wording for a dead secret service, as on 2026-10-26.
        let dead = FakeVault {
            unreadable: Some("Platform secure storage failure: DBus error: Remote peer disconnected".into()),
            ..FakeVault::default()
        };
        reconcile_with(&rig.remote, || identity::read(&dead), rig.build()).await;
        assert_eq!(
            heard::take(),
            ["remote access: could not read the device key: the keychain refused to read the device key: \
              Platform secure storage failure: DBus error: Remote peer disconnected"]
        );
        // A stored value that is not a key is refused by its length alone.
        let odd = FakeVault { stored: std::cell::RefCell::new(Some(vec![0xab; 31])), ..FakeVault::default() };
        reconcile_with(&rig.remote, || identity::read(&odd), rig.build()).await;
        let lines = heard::take();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].starts_with("remote access: could not read the device key: "), "{lines:?}");
        assert!(lines[0].contains("31 bytes, not 32") && !lines[0].to_lowercase().contains("abab"), "{lines:?}");

        // Start, and the bind fails.
        reconcile_with(&rig.remote, || Ok(Some(key())), |_, _| async { Err::<RemoteEndpoint, _>("no socket".to_string()) })
            .await;
        assert_eq!(heard::take(), ["remote access: no socket"]);

        // Start, bound for settings that moved while it bound.
        let remote = &rig.remote;
        let build = rig.build();
        reconcile_with(remote, || Ok(Some(key())), move |key, relay| {
            want(remote, true, Some("https://b.example"));
            build(key, relay)
        })
        .await;
        let lines = heard::take();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].ends_with("was bound for settings that have since changed, so it was stopped"), "{lines:?}");
        assert_eq!(rig.report(), EndpointReport::Off);

        // Start, and up.
        want(&rig.remote, true, None);
        let secret = key();
        let public = secret.public();
        let hex: String = secret.to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        reconcile_with(&rig.remote, move || Ok(Some(secret)), rig.build()).await;
        let lines = heard::take();
        assert_eq!(lines, [format!("remote access: endpoint {public} is up")]);
        assert!(!lines[0].contains(&hex), "the secret never reaches the log");

        // Up and unchanged is not a start, so it says nothing.
        rig.reconcile().await;
        assert_eq!(heard::take(), Vec::<String>::new());

        // Off again: the stop and the off are one line each.
        want(&rig.remote, false, None);
        reconcile_with(&rig.remote, || panic!("off reads no key"), rig.build()).await;
        assert_eq!(
            heard::take(),
            [format!("remote access: endpoint {public} stopped"), "remote access: off, so no endpoint".to_string()]
        );
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

    /// A relay change restarts the endpoint under the same id: the phone is
    /// dropped and reconnects, and is never told remote access is off (#346).
    #[tokio::test]
    async fn a_relay_change_does_not_close_with_remote_off() {
        let rig = Rig::new();
        want(&rig.remote, true, Some("https://a.example"));
        rig.reconcile().await;
        let (_p, conn) = rig.connect().await;
        want(&rig.remote, true, Some("https://b.example"));
        rig.reconcile().await;
        assert_ne!(closed_code(&conn).await, Some(REMOTE_OFF as u64));
        assert!(matches!(rig.report(), EndpointReport::Up { .. }));
    }

    /// A phone turning remote access off: nothing closes until its answer has
    /// arrived; then it is closed by id with REMOTE_OFF, and so is every other
    /// phone (#346).
    #[tokio::test]
    async fn a_phone_s_off_closes_the_asker_by_id_after_its_answer_then_everyone() {
        let other = key();
        let mut rig = Rig::new();
        rig.gate = List::with(&[rig.phone_key.public(), other.public()]);
        want(&rig.remote, true, None);
        rig.reconcile().await;
        let (_p, asker) = rig.connect().await;
        let o = dialler(other.clone()).await;
        let bystander = o.connect(rig.addr(), endpoint::REMOTE_ALPN).await.expect("the other phone connects");
        settle().await;

        want(&rig.remote, false, None);
        let (reached, written) = tokio::sync::oneshot::channel();
        let stop = {
            let build = rig.build();
            let remote = &rig.remote;
            let written = Written::new(written, rig.phone_key.public());
            async move { reconcile_locked(remote, || panic!("off reads no key"), build, Some(written)).await }
        };
        let answered = async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(asker.close_reason().is_none(), "the asker was not closed before its answer arrived");
            assert!(bystander.close_reason().is_none(), "nor was anybody else");
            reached.send(()).unwrap();
        };
        tokio::join!(stop, answered);
        assert_eq!(closed_code(&asker).await, Some(REMOTE_OFF as u64));
        assert_eq!(closed_code(&bystander).await, Some(REMOTE_OFF as u64));
        assert_eq!(rig.report(), EndpointReport::Off);
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
                reconcile_locked(&rig.remote, || panic!("off reads no key"), rig.build(), Some(Written::new(written, rig.phone_key.public()))).await;
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
        // Case 2 (#346): closed with REMOTE_OFF, once its answer had arrived.
        assert_eq!(closed_code(&conn).await, Some(REMOTE_OFF as u64));
        assert_eq!(builds.load(Ordering::SeqCst), 1);
        assert!(matches!(rig.report(), EndpointReport::Up { .. }));
    }

    /// The race a patch written before the lock allowed: a phone's *off* on
    /// disk, the window's reconcile taking the lock first and stopping the
    /// endpoint, and the phone then finding nothing to hold for its answer.
    /// With the patch written under the lock, the window's reconcile waits, so
    /// the phone still decides the close and its answer arrives first.
    #[tokio::test]
    async fn a_phone_s_patch_and_its_close_decision_are_one_step() {
        let rig = Arc::new(Rig::new());
        want(&rig.remote, true, None);
        rig.reconcile().await;
        let (_p, conn) = rig.connect().await;

        // The window is mid-change: it holds the lock, so the phone's patch waits.
        let window = rig.remote.transition.clone().lock_owned().await;
        let written_yet = Arc::new(AtomicUsize::new(0));
        let phone = {
            let rig = rig.clone();
            let written_yet = written_yet.clone();
            tokio::spawn(async move {
                patch_locked(&rig.remote, || {
                    written_yet.store(1, Ordering::SeqCst);
                    want(&rig.remote, false, None);
                    Ok(rig.remote.desired())
                })
                .await
                .unwrap()
            })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(written_yet.load(Ordering::SeqCst), 0, "a patch is never written while another change holds the lock");
        drop(window);
        let guard = phone.await.unwrap();

        // A window reconcile arriving now cannot act on the phone's patch first.
        let desktop = {
            let rig = rig.clone();
            tokio::spawn(async move { rig.reconcile().await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            closes_connections(&rig.remote.running(), &rig.remote.desired()),
            "the endpoint is still the phone's to stop, after its answer"
        );
        let (reached, written) = tokio::sync::oneshot::channel();
        let stop = {
            let rig = rig.clone();
            tokio::spawn(async move {
                reconcile_locked(&rig.remote, || panic!("off reads no key"), rig.build(), Some(Written::new(written, rig.phone_key.public()))).await;
                drop(guard);
            })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(conn.close_reason().is_none(), "nothing closed the phone before its answer arrived");
        reached.send(()).unwrap();
        stop.await.unwrap();
        desktop.await.unwrap();
        closed(&conn).await;
        assert_eq!(rig.report(), EndpointReport::Off);
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

    // ---- #477: the retry worker ----

    use crate::applog::heard;
    use identity::read_classified;
    use std::collections::VecDeque;

    type Answer = Result<Option<SecretKey>, Unreadable>;
    type Built = std::pin::Pin<Box<dyn Future<Output = Result<RemoteEndpoint, String>> + Send>>;

    /// The keychain's service failing, worded as #476 logs it.
    fn transient(what: &str) -> Unreadable {
        Unreadable {
            why: format!("the keychain refused to read the device key: Platform secure storage failure: {what}"),
            kind: Unread::Transient,
        }
    }

    fn locked() -> Unreadable {
        Unreadable {
            why: "the keychain refused to read the device key: Couldn't access platform secure storage: Prompt".into(),
            kind: Unread::Locked,
        }
    }

    /// Milliseconds rather than a paused clock, which the loopback endpoints
    /// would not survive.
    const FAST: Schedule = Schedule { ramp: &[Duration::from_millis(10); 4], steady: Duration::from_millis(20) };

    /// What the retry worker reads, one answer per read, counted. A read that
    /// is held blocks its thread until the test releases it.
    #[derive(Default)]
    struct Script {
        answers: Mutex<VecDeque<Answer>>,
        calls: AtomicUsize,
        in_flight: AtomicUsize,
        max_in_flight: AtomicUsize,
        gate: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    }

    impl Script {
        fn new(answers: Vec<Answer>) -> Arc<Self> {
            Arc::new(Script { answers: Mutex::new(answers.into()), ..Script::default() })
        }
        /// The next read blocks until this is sent on, or dropped.
        fn hold_next(&self) -> std::sync::mpsc::Sender<()> {
            let (release, gate) = std::sync::mpsc::channel();
            *self.gate.lock().unwrap() = Some(gate);
            release
        }
        fn read(&self) -> Answer {
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_in_flight.fetch_max(now, Ordering::SeqCst);
            self.calls.fetch_add(1, Ordering::SeqCst);
            let gate = self.gate.lock().unwrap().take();
            if let Some(gate) = gate {
                let _ = gate.recv();
            }
            let answer = self.answers.lock().unwrap().pop_front().unwrap_or_else(|| Err(transient("still down")));
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            answer
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    /// The rig's loopback build, callable once per attempt.
    fn binds(rig: &Rig) -> impl Fn(SecretKey, Option<RelayUrl>) -> Built + Send + Sync + 'static {
        let (gate, announced, built) = (rig.gate.clone(), rig.announced.clone(), rig.built.clone());
        move |key, relay| loopback(gate.clone(), announced.clone(), built.clone())(key, relay)
    }

    /// A build that fails `failures` times, as a bind with no network yet
    /// does, and then binds over loopback.
    fn binds_after(rig: &Rig, failures: usize) -> impl Fn(SecretKey, Option<RelayUrl>) -> Built + Send + Sync + 'static {
        let ok = binds(rig);
        let tried = AtomicUsize::new(0);
        move |key, relay| -> Built {
            if tried.fetch_add(1, Ordering::SeqCst) < failures {
                Box::pin(async { Err("the remote-access endpoint could not start: no network yet".to_string()) })
            } else {
                ok(key, relay)
            }
        }
    }

    /// The retry worker on this test's own runtime, so `heard` hears its
    /// lines, reading through `script` and recording the state each push to
    /// the window would show.
    fn worker<B>(rig: &Arc<Rig>, schedule: &'static Schedule, script: &Arc<Script>, build: B) -> Arc<Mutex<Vec<EndpointReport>>>
    where
        B: Fn(SecretKey, Option<RelayUrl>) -> Built + Send + Sync + 'static,
    {
        let pushes = Arc::new(Mutex::new(Vec::new()));
        let (rig, script, seen) = (rig.clone(), script.clone(), pushes.clone());
        tokio::spawn(async move {
            let told = rig.clone();
            let read = Arc::new(move || script.read());
            retry_worker(&rig.remote, schedule, read, build, move || {
                let report = told.remote.running().report();
                seen.lock().unwrap().push(report);
            })
            .await;
        });
        pushes
    }

    /// What a `remote_set` does - the window's, or a phone's that keeps the
    /// endpoint, which runs the same steps: the patch and a new generation
    /// under the lock, the reconcile, and the arming.
    async fn person(
        rig: &Rig,
        enabled: bool,
        relay: Option<&str>,
        answer: Answer,
        build: impl FnOnce(SecretKey, Option<RelayUrl>) -> Built,
    ) {
        let _guard = patch_locked(&rig.remote, || {
            want(&rig.remote, enabled, relay);
            Ok(rig.remote.desired())
        })
        .await
        .expect("patched");
        reconcile_and_arm(&rig.remote, move || answer, build, None).await;
    }

    /// What a pairing code's `start()` does: no patch, so the same generation.
    async fn pairing(rig: &Rig, answer: Answer, build: impl FnOnce(SecretKey, Option<RelayUrl>) -> Built) {
        let _guard = rig.remote.transition.lock().await;
        reconcile_and_arm(&rig.remote, move || answer, build, None).await;
    }

    /// Await `work`, failing by name after a deadline rather than hanging. A
    /// read the test holds is released when its sender drops in the unwind.
    async fn bounded<T>(what: &str, work: impl Future<Output = T>) -> T {
        match tokio::time::timeout(Duration::from_secs(10), work).await {
            Ok(done) => done,
            Err(_) => panic!("timed out waiting for {what}"),
        }
    }

    /// Poll until `ready`, failing by name after a deadline rather than hanging.
    async fn until(what: &str, mut ready: impl FnMut() -> bool) {
        let waited = tokio::time::timeout(Duration::from_secs(10), async {
            while !ready() {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await;
        assert!(waited.is_ok(), "timed out waiting for {what}");
    }

    fn no_episode(rig: &Rig) -> bool {
        rig.remote.episode.borrow().is_none()
    }

    fn up(rig: &Rig) -> bool {
        matches!(rig.report(), EndpointReport::Up { .. })
    }

    fn retrying(why: &str) -> EndpointReport {
        EndpointReport::Failed { reason: format!("{why}; trying again by itself") }
    }

    #[tokio::test]
    async fn a_transient_read_failure_is_retried_until_the_endpoint_is_up() {
        const N: usize = 3;
        let rig = Arc::new(Rig::new());
        let mut answers: Vec<Answer> = (1..=N).map(|i| Err(transient(&format!("D-Bus error {i}")))).collect();
        answers.push(Ok(Some(rig.key.clone())));
        let script = Script::new(answers);
        let pushes = worker(&rig, &FAST, &script, binds(&rig));

        want(&rig.remote, true, None);
        person(&rig, true, None, Err(transient("D-Bus error 0")), binds(&rig)).await;
        assert_eq!(rig.report(), retrying(&transient("D-Bus error 0").why), "a failure being retried says so");

        until("the endpoint up on attempt N+1", || up(&rig) && no_episode(&rig)).await;
        assert_eq!(script.calls(), N + 1);
        // Each change of state was pushed: every new failure, then the bind
        // entering `Starting`, then up.
        let pushes = pushes.lock().unwrap().clone();
        let mut expected: Vec<EndpointReport> = (1..=N).map(|i| retrying(&transient(&format!("D-Bus error {i}")).why)).collect();
        expected.push(EndpointReport::Starting);
        assert_eq!(pushes[..N + 1], expected[..], "{pushes:?}");
        assert_eq!(pushes.len(), N + 2, "{pushes:?}");
        assert_eq!(pushes.last(), Some(&rig.report()), "the last push is the state the window ends on");
    }

    /// A bind that fails the same way twice is pushed both times it leaves
    /// `Starting`: the window may have read `Starting` in between.
    #[tokio::test]
    async fn a_bind_failure_is_retried_and_comes_up() {
        let rig = Arc::new(Rig::new());
        let k = rig.key.clone();
        let script = Script::new(vec![Ok(Some(k.clone())), Ok(Some(k.clone())), Ok(Some(k.clone()))]);
        // The person's bind and the first two retries fail.
        let flaky = Arc::new(binds_after(&rig, 3));
        let pushes = worker(&rig, &FAST, &script, {
            let flaky = flaky.clone();
            move |key, relay| flaky(key, relay)
        });

        want(&rig.remote, true, None);
        person(&rig, true, None, Ok(Some(k)), {
            let flaky = flaky.clone();
            move |key, relay| flaky(key, relay)
        })
        .await;
        match &*rig.remote.running() {
            Running::Failed(failure) => {
                assert_eq!(failure.cause, Cause::Bind);
                assert!(failure.retrying);
            }
            _ => panic!("the bind did not fail"),
        }

        until("the endpoint up", || up(&rig) && no_episode(&rig)).await;
        let failed = retrying("the remote-access endpoint could not start: no network yet");
        let pushes = pushes.lock().unwrap().clone();
        assert_eq!(
            pushes[..5],
            [EndpointReport::Starting, failed.clone(), EndpointReport::Starting, failed, EndpointReport::Starting],
            "{pushes:?}"
        );
        assert_eq!(pushes.len(), 6, "{pushes:?}");
        assert_eq!(pushes.last(), Some(&rig.report()));
        assert_eq!(script.calls(), 3);
        assert_eq!(rig.built.lock().unwrap().len(), 1, "one endpoint bound");
    }

    #[tokio::test]
    async fn locked_malformed_and_no_key_are_not_retried() {
        let malformed = read_classified(Ok(vec![1; 31])).map(|_| ()).unwrap_err();
        let cases: [(Answer, Option<&str>); 3] = [
            (Err(locked()), Some("Unlock your keychain, then turn remote access off and on.")),
            (Err(malformed.clone()), Some("each would have to pair again")),
            (Ok(None), None),
        ];
        for (answer, says) in cases {
            let rig = Arc::new(Rig::new());
            let script = Script::new(vec![]);
            let pushes = worker(&rig, &FAST, &script, binds(&rig));
            want(&rig.remote, true, None);
            person(&rig, true, None, answer, binds(&rig)).await;
            assert!(no_episode(&rig), "nothing was armed");
            // Past the whole ramp and five steady steps.
            tokio::time::sleep(Duration::from_millis(40 + 5 * 20 + 60)).await;
            assert_eq!(script.calls(), 0, "the keychain was not asked again");
            assert!(pushes.lock().unwrap().is_empty());
            match (rig.report(), says) {
                (EndpointReport::Failed { reason }, Some(says)) => {
                    assert!(reason.contains(says), "{reason}");
                    assert!(!reason.contains("trying again"), "{reason}");
                }
                (EndpointReport::NoKey, None) => {}
                (other, _) => panic!("{other:?}"),
            }
        }

        // The malformed key's instruction never says to delete or replace it.
        let rig = Rig::new();
        want(&rig.remote, true, None);
        person(&rig, true, None, Err(malformed.clone()), binds(&rig)).await;
        let EndpointReport::Failed { reason } = rig.report() else { panic!("not failed") };
        let told = reason.strip_prefix(&malformed.why).expect("the reason starts with why").to_lowercase();
        assert!(!told.contains("delete") && !told.contains("replace"), "{told}");

        // An episode whose retry finds the keychain locked ends there.
        let rig = Arc::new(Rig::new());
        let script = Script::new(vec![Err(locked())]);
        heard::listen();
        worker(&rig, &FAST, &script, binds(&rig));
        want(&rig.remote, true, None);
        person(&rig, true, None, Err(transient("gone")), binds(&rig)).await;
        until("the episode ends", || script.calls() == 1 && no_episode(&rig)).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(script.calls(), 1, "a locked keychain is asked once");
        let lines = heard::take();
        assert!(
            lines.contains(&"remote access: retry 1: stopped: the last attempt needs you to act".to_string()),
            "{lines:?}"
        );
        let EndpointReport::Failed { reason } = rig.report() else { panic!("not failed") };
        assert!(reason.contains("Unlock your keychain"), "{reason}");
    }

    #[tokio::test]
    async fn off_cancels_a_pending_retry() {
        const QUICK: Schedule = Schedule { ramp: &[Duration::from_millis(1); 4], steady: Duration::from_millis(1) };
        let rig = Arc::new(Rig::new());
        let script = Script::new(vec![]);
        heard::listen();
        worker(&rig, &QUICK, &script, binds(&rig));
        for round in 0..20 {
            person(&rig, true, None, Err(transient("gone")), binds(&rig)).await;
            tokio::time::sleep(Duration::from_millis(round % 3)).await;
            person(&rig, false, None, Err(transient("never read")), binds(&rig)).await;
            assert_eq!(rig.report(), EndpointReport::Off);
            until("the episode ends", || no_episode(&rig)).await;
            // A read dispatched before the off may still be finishing.
            until("no read in flight", || rig.remote.read_slot.try_lock().is_ok()).await;
            let read = script.calls();
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert_eq!(script.calls(), read, "round {round}: a read was dispatched after off");
            assert_eq!(rig.report(), EndpointReport::Off);
        }
        assert!(rig.built.lock().unwrap().is_empty(), "nothing was ever bound, so nothing listens");
        let lines = heard::take();
        let stopped = lines.iter().filter(|l| l.ends_with("stopped: remote access was turned off")).count();
        assert_eq!(stopped, 20, "{lines:?}");
    }

    #[tokio::test]
    async fn a_person_s_change_during_a_backoff_is_not_overtaken() {
        const SLOW: Schedule = Schedule { ramp: &[Duration::from_millis(300); 4], steady: Duration::from_millis(300) };
        let rig = Arc::new(Rig::new());
        let script = Script::new(vec![]);
        heard::listen();
        worker(&rig, &SLOW, &script, binds(&rig));
        want(&rig.remote, true, None);
        person(&rig, true, None, Err(transient("gone")), binds(&rig)).await;
        tokio::task::yield_now().await;
        // The person sets a relay of their own during the wait, and it comes up.
        person(&rig, true, Some("https://a.example"), Ok(Some(rig.key.clone())), binds(&rig)).await;
        until("the old episode ends", || no_episode(&rig)).await;
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(script.calls(), 0, "the old episode read nothing");
        match &*rig.remote.running() {
            Running::Up { relay, .. } => assert_eq!(relay.as_deref(), Some("https://a.example")),
            _ => panic!("the person's change was overtaken"),
        }
        assert_eq!(rig.built.lock().unwrap().len(), 1);
        let lines = heard::take();
        assert!(
            lines.contains(&"remote access: retry 1: stopped: another start made its own attempt".to_string()),
            "{lines:?}"
        );

        // The worker is already waiting on the transition lock when the
        // person's change takes it: it still reads nothing for the old episode.
        let rig = Arc::new(Rig::new());
        let script = Script::new(vec![]);
        const TWENTY: Schedule = Schedule { ramp: &[Duration::from_millis(20); 4], steady: Duration::from_millis(20) };
        worker(&rig, &TWENTY, &script, binds(&rig));
        want(&rig.remote, true, None);
        person(&rig, true, None, Err(transient("gone")), binds(&rig)).await;
        let held = rig.remote.transition.clone().lock_owned().await;
        until("the worker is past its wait, holding the read slot", || rig.remote.read_slot.try_lock().is_err()).await;
        // What `remote_set` does, under the lock the worker waits on: the
        // patch, then `reconcile_and_arm`, which moves the generation.
        want(&rig.remote, true, Some("https://b.example"));
        let k = rig.key.clone();
        reconcile_and_arm(&rig.remote, move || Ok(Some(k)), binds(&rig), None).await;
        drop(held);
        until("the old episode ends", || no_episode(&rig)).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(script.calls(), 0);
        assert!(up(&rig));
        assert_eq!(rig.built.lock().unwrap().len(), 1);
        let lines = heard::take();
        assert!(
            lines.contains(&"remote access: retry 1: stopped: another start made its own attempt".to_string()),
            "{lines:?}"
        );
    }

    /// D5: the read runs outside the lock, so the person's off does not wait
    /// for it, and its late success is dropped.
    #[tokio::test]
    async fn off_during_a_blocked_retry_read_wins() {
        let rig = Arc::new(Rig::new());
        let script = Script::new(vec![Ok(Some(rig.key.clone()))]);
        let release = script.hold_next();
        heard::listen();
        worker(&rig, &FAST, &script, binds(&rig));
        want(&rig.remote, true, None);
        person(&rig, true, None, Err(transient("gone")), binds(&rig)).await;
        until("the retry's read is in flight", || script.in_flight.load(Ordering::SeqCst) == 1).await;

        bounded("off, while a retry's read is held", person(&rig, false, None, Err(transient("never read")), binds(&rig)))
            .await;
        assert_eq!(script.in_flight.load(Ordering::SeqCst), 1, "off did not wait for the read");
        assert_eq!(rig.report(), EndpointReport::Off);
        until("the episode ends", || no_episode(&rig)).await;

        release.send(()).unwrap();
        until("the read returns", || script.in_flight.load(Ordering::SeqCst) == 0).await;
        until("the read slot is free", || rig.remote.read_slot.try_lock().is_ok()).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(rig.report(), EndpointReport::Off, "the late key did not bring the endpoint back");
        assert!(rig.built.lock().unwrap().is_empty(), "nothing was bound, so nothing listens");
        assert_eq!(script.calls(), 1);
        let lines = heard::take();
        assert!(lines.contains(&"remote access: retry 1: stopped: remote access was turned off".to_string()), "{lines:?}");
    }

    #[tokio::test]
    async fn a_person_s_failed_change_restarts_the_schedule() {
        // A minute between steady attempts: only a restarted schedule reads
        // again within the deadline `until` gives it.
        const LONG: Schedule = Schedule { ramp: &[Duration::from_millis(20); 4], steady: Duration::from_secs(60) };
        let rig = Arc::new(Rig::new());
        let script = Script::new(vec![]);
        heard::listen();
        worker(&rig, &LONG, &script, binds(&rig));
        want(&rig.remote, true, None);
        person(&rig, true, None, Err(transient("first")), binds(&rig)).await;
        until("the ramp is spent", || script.calls() == 4).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        heard::take();

        person(&rig, true, None, Err(transient("again")), binds(&rig)).await;
        let mut lines = Vec::new();
        until("the first step of a new schedule, logged", || {
            lines.extend(heard::take());
            lines.iter().any(|l| l.starts_with("remote access: retry 1: "))
        })
        .await;
        // The new ramp goes on after its first step; the first three lines are the claim.
        assert!(lines.len() >= 3, "{lines:?}");
        assert_eq!(
            lines[..3],
            [
                format!("remote access: could not read the device key: {}", transient("again").why),
                "remote access: retry 5: stopped: another start made its own attempt".to_string(),
                format!("remote access: retry 1: could not read the device key: {}", transient("still down").why),
            ]
        );
    }

    /// D6: the ramp logs every attempt; the steady cadence logs a failure only
    /// when it changed; the recovery is always logged.
    #[tokio::test]
    async fn retry_lines_follow_the_repeat_rule() {
        let rig = Arc::new(Rig::new());
        let (a, b) = (transient("A"), transient("B"));
        let mut answers: Vec<Answer> = (0..6).map(|_| Err(a.clone())).collect();
        answers.push(Err(b.clone()));
        answers.push(Ok(Some(rig.key.clone())));
        let script = Script::new(answers);
        heard::listen();
        worker(&rig, &FAST, &script, binds(&rig));
        want(&rig.remote, true, None);
        person(&rig, true, None, Err(a.clone()), binds(&rig)).await;
        until("the endpoint up", || up(&rig) && no_episode(&rig)).await;

        let said = |n: usize, why: &str| format!("remote access: retry {n}: could not read the device key: {why}");
        let id = rig.key.public();
        assert_eq!(
            heard::take(),
            [
                format!("remote access: could not read the device key: {}", a.why),
                said(1, &a.why),
                said(2, &a.why),
                said(3, &a.why),
                said(4, &a.why),
                // 5 and 6 are A again at the steady cadence: not logged.
                said(7, &b.why),
                format!("remote access: retry 8: endpoint {id} is up"),
            ]
        );

        // An episode that ends without recovering says why.
        let rig = Arc::new(Rig::new());
        let script = Script::new(vec![]);
        worker(&rig, &TWENTY_MS, &script, binds(&rig));
        want(&rig.remote, true, None);
        person(&rig, true, None, Err(a.clone()), binds(&rig)).await;
        person(&rig, false, None, Err(a.clone()), binds(&rig)).await;
        until("the episode ends", || no_episode(&rig)).await;
        assert_eq!(
            heard::take(),
            [
                format!("remote access: could not read the device key: {}", a.why),
                "remote access: off, so no endpoint".to_string(),
                "remote access: retry 1: stopped: remote access was turned off".to_string(),
            ]
        );
    }

    const TWENTY_MS: Schedule = Schedule { ramp: &[Duration::from_millis(20); 4], steady: Duration::from_millis(20) };

    #[tokio::test]
    async fn one_worker_one_episode_one_read() {
        let rig = Arc::new(Rig::new());
        let script = Script::new(vec![Err(transient("dropped")), Ok(Some(rig.key.clone()))]);
        let release = script.hold_next();
        heard::listen();
        worker(&rig, &FAST, &script, binds(&rig));
        until("the worker is running", || rig.remote.worker.load(Ordering::SeqCst)).await;
        let second = retry_worker(
            &rig.remote,
            &FAST,
            Arc::new(|| -> Answer { panic!("a second worker never reads") }),
            binds(&rig),
            || panic!("nor tells the window anything"),
        );
        tokio::time::timeout(Duration::from_secs(5), second).await.expect("a second worker returns at once");

        want(&rig.remote, true, None);
        person(&rig, true, None, Err(transient("0")), binds(&rig)).await;
        until("the first retry's read is in flight", || script.in_flight.load(Ordering::SeqCst) == 1).await;
        // Two of the person's changes fail while that read is held: each ends
        // the episode before it, and the newest waits for the read slot.
        bounded("a change while a read is held", person(&rig, true, None, Err(transient("1")), binds(&rig))).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        bounded("a second change while a read is held", person(&rig, true, None, Err(transient("2")), binds(&rig))).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(script.calls(), 1, "no second read while one is in flight");

        release.send(()).unwrap();
        until("the endpoint up", || up(&rig) && no_episode(&rig)).await;
        assert_eq!(script.max_in_flight.load(Ordering::SeqCst), 1);
        assert_eq!(script.calls(), 2, "the held read's late answer was dropped, and one more was made");
        assert_eq!(rig.built.lock().unwrap().len(), 1);
        let id = rig.key.public();
        let retries: Vec<String> = heard::take().into_iter().filter(|l| l.starts_with("remote access: retry ")).collect();
        assert_eq!(
            retries,
            [
                "remote access: retry 1: stopped: another start made its own attempt".to_string(),
                "remote access: retry 1: stopped: another start made its own attempt".to_string(),
                format!("remote access: retry 1: endpoint {id} is up"),
            ],
            "one episode at a time, each ended before the next began"
        );
    }

    /// A pairing code's start ends the episode as a person's change does, so
    /// the worker reads nothing - which for a locked keychain would put its
    /// prompt back up.
    #[tokio::test]
    async fn a_retry_reads_nothing_once_another_change_made_it_unnecessary() {
        const WAIT: Schedule = Schedule { ramp: &[Duration::from_millis(200); 4], steady: Duration::from_millis(200) };
        let rig = Arc::new(Rig::new());
        let script = Script::new(vec![]);
        heard::listen();
        worker(&rig, &WAIT, &script, binds(&rig));
        want(&rig.remote, true, None);
        person(&rig, true, None, Err(transient("gone")), binds(&rig)).await;
        pairing(&rig, Ok(Some(rig.key.clone())), binds(&rig)).await;
        assert!(up(&rig));
        until("the episode ends", || no_episode(&rig)).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(script.calls(), 0);
        let lines = heard::take();
        assert!(
            lines.contains(&"remote access: retry 1: stopped: another start made its own attempt".to_string()),
            "{lines:?}"
        );

        let rig = Arc::new(Rig::new());
        let script = Script::new(vec![]);
        worker(&rig, &WAIT, &script, binds(&rig));
        want(&rig.remote, true, None);
        person(&rig, true, None, Err(transient("gone")), binds(&rig)).await;
        pairing(&rig, Err(locked()), binds(&rig)).await;
        until("the episode ends", || no_episode(&rig)).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(script.calls(), 0, "a locked keychain is not asked again");
        let lines = heard::take();
        assert!(
            lines.contains(&"remote access: retry 1: stopped: another start made its own attempt".to_string()),
            "{lines:?}"
        );
    }

    /// A retry that read *no key* just before the first pairing code made one,
    /// and came back after that code's start had failed to bind, is not
    /// applied: it would turn a failure that passes by itself into `NoKey`,
    /// and nothing would try again. The start's own failure is retried.
    #[tokio::test]
    async fn a_retry_answer_older_than_a_pairing_start_is_dropped() {
        let rig = Arc::new(Rig::new());
        let script = Script::new(vec![Ok(None), Ok(Some(rig.key.clone()))]);
        let release = script.hold_next();
        heard::listen();
        let pushes = worker(&rig, &FAST, &script, binds(&rig));
        want(&rig.remote, true, None);
        bounded("the person's start", person(&rig, true, None, Err(transient("gone")), binds(&rig))).await;
        until("the retry's read is in flight", || script.in_flight.load(Ordering::SeqCst) == 1).await;

        // The read comes back with no key while the pairing code's start holds
        // the lock, so the worker is waiting for it with that answer in hand.
        let held = bounded("the transition lock", rig.remote.transition.clone().lock_owned()).await;
        release.send(()).unwrap();
        until("the read returns", || script.in_flight.load(Ordering::SeqCst) == 0).await;
        let k = rig.key.clone();
        reconcile_and_arm(
            &rig.remote,
            move || Ok(Some(k)),
            |_, _| async { Err::<RemoteEndpoint, _>("the remote-access endpoint could not start: no network yet".to_string()) },
            None,
        )
        .await;
        drop(held);

        until("the endpoint up", || up(&rig) && no_episode(&rig)).await;
        assert_eq!(script.calls(), 2, "the stale answer was dropped, and the new episode read again");
        assert!(!pushes.lock().unwrap().contains(&EndpointReport::NoKey), "{:?}", pushes.lock().unwrap());
        let retries: Vec<String> = heard::take().into_iter().filter(|l| l.starts_with("remote access: retry ")).collect();
        assert_eq!(
            retries,
            [
                "remote access: retry 1: stopped: another start made its own attempt".to_string(),
                format!("remote access: retry 1: endpoint {} is up", rig.key.public()),
            ]
        );
    }
}
