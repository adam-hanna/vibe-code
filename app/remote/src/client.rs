//! The phone's side of both ALPNs (#346): dialling a desktop, pairing with it
//! on `vibe/pair/1`, the control stream on `vibe/remote/1`, and reading how a
//! connection ended into a [`Reason`] the phone can say.
//!
//! **No Tauri, and nothing the caller does not hand in.** The endpoint, how to
//! read the network, and every deadline arrive with the [`Client`], so the
//! desktop crate's tests run this module against its real pairing handler and
//! its real bridge in one process, and a browser client (#370) can bring its
//! own endpoint.
//!
//! ## One dial for every caller
//!
//! A paired desktop is dialled by its stored relay hint first, under
//! [`Timeouts::hint`], and then by its endpoint id alone - n0's DNS record, or
//! mDNS on the same network - under a budget of its own, never what was left of
//! the hint's. A hint goes stale when the desktop's relay changes; the id never
//! does. The budget is the caller's: connecting and probing use
//! [`Timeouts::dial`], unpairing [`Timeouts::unpair_dial`], and **pairing
//! none at all**. The desktop already bounds a pairing attempt by its code's
//! own life, and a second, shorter clock on the phone would end an attempt the
//! desktop was still willing to finish.
//!
//! ## How a connection ended
//!
//! The desktop says three things in a close code: [`crate::NOT_PAIRED`],
//! [`crate::VERSION_MISMATCH`] and [`crate::REMOTE_OFF`]. **Everything else** -
//! code 0, an unknown code, a dial that found nobody, a transport that went
//! quiet - is read by [`classify`] from what the phone can see at that moment:
//! whether the OS says it is online (never `Endpoint::addr`, which is what the
//! phone advertises rather than the state of its interfaces), and how its own
//! relays are doing. There is no "dropped": every ending has a sentence.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::endpoint::{ApplicationClose, ConnectError, Connection, ConnectionError, RecvStream, SendStream, VarInt};
use iroh::{Endpoint, EndpointAddr, PublicKey, RelayUrl, TransportAddr, Watcher};
use n0_future::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;

use crate::control::{Call, Event, Hello, Outcome, ToDesktop, VersionMismatch, Welcome, CONTROL_MAX};
use crate::framing::{read_message, write_message};
use crate::paired::{DesktopEntry, PairedList};
use crate::wire::{hex, hex_decode16, matching_code_for, PairChallenge, PairHello, PairPayload, PairResult, PAIR_MESSAGE_MAX};
use crate::{NOT_PAIRED, PAIR_ALPN, REMOTE_ALPN, REMOTE_OFF, VERSION_MISMATCH};

/// The budget for reaching a desktop by its id alone, and then for its
/// `Welcome`. A choice, not a measurement: #339 found a restarted desktop
/// reachable by id in 2.1-2.8s, and this leaves room for a slow network on top
/// of that. The device checks on #346 record real connect times against it.
pub const DIAL_TIMEOUT: Duration = Duration::from_secs(15);

/// How long the stored relay hint gets before the dial falls through to the
/// id. A choice: long enough for a relay that answers, short enough that a
/// stale hint costs little before the lookup is tried.
pub const HINT_DIAL_TIMEOUT: Duration = Duration::from_secs(5);

/// The budget for reaching a desktop to tell it this phone is unpairing. A
/// choice, and short: the phone forgets the desktop whatever happens, so a
/// person pressing Unpair should not wait long on a desktop that is off.
pub const UNPAIR_DIAL_TIMEOUT: Duration = Duration::from_secs(5);

/// How long the phone waits for the desktop to close the connection after an
/// `Unpair`. A choice, borrowed from the desktop's own `WRITTEN_CEILING`: about
/// what iroh documents closing to take on a poor connection.
pub const UNPAIR_WAIT: Duration = Duration::from_secs(3);

/// The first wait before a reconnect. A choice, not a measurement.
pub const RETRY_FIRST: Duration = Duration::from_secs(1);

/// The longest wait between reconnects. A choice: a foreground, a network
/// change or a press wakes the loop sooner, so this only bounds how long a
/// phone left alone takes to notice a desktop came back.
pub const RETRY_CAP: Duration = Duration::from_secs(30);

/// The wait before reconnect attempt `n` (from 0): [`RETRY_FIRST`], doubling,
/// capped at [`RETRY_CAP`].
pub fn retry_after(attempt: u32) -> Duration {
    let factor = 1u32.checked_shl(attempt.min(31)).unwrap_or(u32::MAX);
    RETRY_FIRST.checked_mul(factor).map_or(RETRY_CAP, |d| d.min(RETRY_CAP))
}

/// Every deadline the client keeps. Injected so a test can make them short
/// rather than pausing time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timeouts {
    pub hint: Duration,
    pub dial: Duration,
    pub unpair_dial: Duration,
    pub unpair_wait: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Timeouts { hint: HINT_DIAL_TIMEOUT, dial: DIAL_TIMEOUT, unpair_dial: UNPAIR_DIAL_TIMEOUT, unpair_wait: UNPAIR_WAIT }
    }
}

/// One of the phone's relays, as seen at one moment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelayLink {
    Connected,
    /// Not connected, and it has failed: iroh has an error for it.
    Failed,
    /// Not connected and no error yet: still being tried.
    Pending,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelaySeen {
    pub url: RelayUrl,
    pub state: RelayLink,
}

/// iroh's relay state, as this module reads it.
pub fn relay_link_of(connected: bool, has_error: bool) -> RelayLink {
    match (connected, has_error) {
        (true, _) => RelayLink::Connected,
        (false, true) => RelayLink::Failed,
        (false, false) => RelayLink::Pending,
    }
}

/// The only place iroh's relay status is read.
pub fn relays_seen(ep: &Endpoint) -> Vec<RelaySeen> {
    ep.home_relay_status()
        .get()
        .into_iter()
        .map(|r| RelaySeen { url: r.url().clone(), state: relay_link_of(r.is_connected(), r.last_error().is_some()) })
        .collect()
}

/// What the phone can see of its network, read when a connection ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Net {
    /// What the OS says. Never derived from the endpoint's advertised address.
    pub online: bool,
    pub relays: Vec<RelaySeen>,
    /// The relays this phone's endpoint uses: n0's preset on a phone.
    pub phone_relays: Vec<RelayUrl>,
}

impl Net {
    /// The endpoint's relays now, with the OS's word on being online.
    /// `phone_relays` is `reach::relays` of the choice the endpoint was built with.
    pub fn of(ep: &Endpoint, online: bool, phone_relays: Vec<RelayUrl>) -> Net {
        Net { online, relays: relays_seen(ep), phone_relays }
    }
}

/// How the phone was trying to reach a desktop when it failed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Attempt {
    /// The path in use was direct, not through a relay.
    pub direct: bool,
    /// The desktop's relay, if the phone knows it.
    pub target_relay: Option<RelayUrl>,
}

/// Why the phone is not connected to a desktop, or why pairing ended. Closed:
/// the webview's `sentences.ts` has one sentence per kind and a `never` check.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Reason {
    /// The desktop removed this phone, or never paired it.
    NotPaired,
    /// Remote access is off on the desktop.
    RemoteOff,
    /// The two apps speak different control protocols. The desktop's version
    /// is null when its close could not be read.
    VersionMismatch { desktop_app_version: Option<String>, phone_app_version: String },
    /// Nobody answered: off, asleep, not running, reset, or a private relay
    /// that is down. The phone cannot tell those apart, and says so.
    Unreachable,
    /// The OS says this phone has no network.
    Offline,
    /// The relays the desktop and this phone share are failing.
    RelaysUnreachable,
    /// The desktop refused the pairing attempt, with its sentence.
    PairRefused { reason: String },
    /// Somebody at the desktop pressed Deny, or the code expired.
    PairDeclined,
    /// The person pressed Back on the phone.
    PairCancelled,
    /// The phone's list of desktops cannot be read, so nothing was dialled.
    PhoneListUnreadable { why: String },
    /// The desktop paired this phone and the phone could not save it.
    PairedNotSaved { desktop_name: Option<String>, why: String },
}

/// Read a failure that carries no application code.
///
/// `RelaysUnreachable` only when all three hold: the attempt was not direct;
/// the desktop's relay is known and is one of this phone's; and that relay has
/// failed, or every relay the phone lists has. Everything else is
/// `Unreachable`: a desktop on a relay of its own may be off or its relay may
/// be down, and nothing the phone can observe separates the two.
pub fn classify(net: &Net, attempt: &Attempt) -> Reason {
    if !net.online {
        return Reason::Offline;
    }
    if attempt.direct {
        return Reason::Unreachable;
    }
    let Some(target) = &attempt.target_relay else { return Reason::Unreachable };
    if !net.phone_relays.contains(target) {
        return Reason::Unreachable;
    }
    let target_failed = net.relays.iter().any(|r| &r.url == target && r.state == RelayLink::Failed);
    let all_failed = !net.relays.is_empty() && net.relays.iter().all(|r| r.state == RelayLink::Failed);
    if target_failed || all_failed {
        Reason::RelaysUnreachable
    } else {
        Reason::Unreachable
    }
}

/// A close code (or none) into a reason. `phone_app_version` is this phone's,
/// for a version mismatch whose close cannot be decoded.
pub fn reason_of(code: Option<u64>, reason: &[u8], phone_app_version: &str, net: &Net, attempt: &Attempt) -> Reason {
    match code {
        Some(c) if c == u64::from(NOT_PAIRED) => Reason::NotPaired,
        Some(c) if c == u64::from(REMOTE_OFF) => Reason::RemoteOff,
        Some(c) if c == u64::from(VERSION_MISMATCH) => match serde_json::from_slice::<VersionMismatch>(reason) {
            Ok(v) => Reason::VersionMismatch {
                desktop_app_version: Some(v.desktop_app_version),
                phone_app_version: v.phone_app_version,
            },
            Err(_) => Reason::VersionMismatch { desktop_app_version: None, phone_app_version: phone_app_version.into() },
        },
        _ => classify(net, attempt),
    }
}

/// The application close code on an ending, if it carried one, and its bytes.
fn close_of(error: &ConnectionError) -> (Option<u64>, Vec<u8>) {
    match error {
        ConnectionError::ApplicationClosed(ApplicationClose { error_code, reason }) => {
            (Some(error_code.into_inner()), reason.to_vec())
        }
        _ => (None, Vec::new()),
    }
}

fn connect_close(error: &ConnectError) -> Option<(u64, Vec<u8>)> {
    match error {
        ConnectError::Connection { source, .. } => match close_of(source) {
            (Some(code), bytes) => Some((code, bytes)),
            _ => None,
        },
        _ => None,
    }
}

/// How a connection is travelling.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PathKind {
    Direct,
    Relayed,
    /// No path selected at this moment.
    None,
}

fn path_of(conn: &Connection) -> PathKind {
    let paths = conn.paths();
    match paths.iter().find(|p| p.is_selected()) {
        Some(p) if p.is_relay() => PathKind::Relayed,
        Some(_) => PathKind::Direct,
        None => PathKind::None,
    }
}

/// The desktop's relay, as the connection sees it.
fn relay_of(conn: &Connection) -> Option<RelayUrl> {
    let paths = conn.paths();
    paths.iter().find_map(|p| match p.remote_addr() {
        TransportAddr::Relay(url) => Some(url.clone()),
        _ => None,
    })
}

/// How the phone reads the network: `Net::of` over its endpoint, and the OS's
/// word. Shared across tasks, so `Send + Sync`.
pub type NetReader = Arc<dyn Fn() -> Net + Send + Sync>;

/// A phone's endpoint, how it reads the network, and its deadlines.
#[derive(Clone)]
pub struct Client {
    ep: Endpoint,
    net: NetReader,
    timeouts: Timeouts,
}

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Client").field("id", &self.ep.id()).field("timeouts", &self.timeouts).finish()
    }
}

/// What dialling produced.
struct Dialled {
    conn: Connection,
    attempt: Attempt,
}

impl Client {
    pub fn new(ep: Endpoint, net: NetReader, timeouts: Timeouts) -> Self {
        Client { ep, net, timeouts }
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.ep
    }

    pub fn timeouts(&self) -> Timeouts {
        self.timeouts
    }

    pub fn net(&self) -> Net {
        (self.net)()
    }

    /// The one dial: the hint, then the id under `budget` (none for pairing).
    async fn dial(&self, alpn: &[u8], id: PublicKey, hint: Option<RelayUrl>, budget: Option<Duration>) -> Result<Dialled, Reason> {
        let failed = Attempt { direct: false, target_relay: hint.clone() };
        if let Some(url) = &hint {
            let addr = EndpointAddr::new(id).with_relay_url(url.clone());
            match tokio::time::timeout(self.timeouts.hint, self.ep.connect(addr, alpn)).await {
                Ok(Ok(conn)) => return Ok(self.dialled(conn, hint)),
                // The desktop answered and said no: final, whichever road reached it.
                Ok(Err(e)) => {
                    if let Some((code, bytes)) = connect_close(&e) {
                        return Err(reason_of(Some(code), &bytes, "", &self.net(), &failed));
                    }
                }
                Err(_) => {}
            }
        }
        let by_id = self.ep.connect(EndpointAddr::new(id), alpn);
        let connected = match budget {
            Some(b) => match tokio::time::timeout(b, by_id).await {
                Ok(c) => c,
                Err(_) => return Err(classify(&self.net(), &failed)),
            },
            None => by_id.await,
        };
        match connected {
            Ok(conn) => Ok(self.dialled(conn, hint)),
            Err(e) => {
                let (code, bytes) = connect_close(&e).map_or((None, Vec::new()), |(c, b)| (Some(c), b));
                Err(reason_of(code, &bytes, "", &self.net(), &failed))
            }
        }
    }

    fn dialled(&self, conn: Connection, hint: Option<RelayUrl>) -> Dialled {
        let attempt = Attempt { direct: path_of(&conn) == PathKind::Direct, target_relay: relay_of(&conn).or(hint) };
        Dialled { conn, attempt }
    }

    /// How a connection ended, read once it has.
    fn ended(&self, conn: &Connection, phone_app_version: &str, attempt: &Attempt) -> (Reason, String) {
        let (code, bytes, raw) = match conn.close_reason() {
            Some(e) => {
                let (code, bytes) = close_of(&e);
                (code, bytes, e.to_string())
            }
            None => (None, Vec::new(), "the stream ended with the connection still open".into()),
        };
        (reason_of(code, &bytes, phone_app_version, &self.net(), attempt), raw)
    }
}

fn hint_of(relay: Option<&str>) -> Option<RelayUrl> {
    relay.and_then(|r| r.parse().ok())
}

fn parse_id(id: &str) -> Result<PublicKey, Reason> {
    // An id that does not parse was refused when the list was read; this is
    // the same desktop nobody can reach.
    id.parse().map_err(|_| Reason::Unreachable)
}

// Pairing.

/// A pairing that has had its challenge: the phone knows the six digits and
/// the desktop is asking *Allow?*. Read the result, then commit it.
///
/// **Dropping it hangs up**, and a desktop whose prompt is still up takes it
/// down and declines.
pub struct Challenged {
    client: Client,
    conn: Connection,
    _send: SendStream,
    recv: RecvStream,
    code: String,
    desktop: PublicKey,
    relay: Option<String>,
    attempt: Attempt,
}

impl fmt::Debug for Challenged {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Challenged").field("desktop", &self.desktop).field("code", &self.code).finish()
    }
}

impl Drop for Challenged {
    fn drop(&mut self) {
        self.conn.close(VarInt::from_u32(0), b"done");
    }
}

/// Dial a desktop from a scanned payload and send the secret. Returns once the
/// desktop has sent its challenge, which is when both screens show the code.
///
/// The phone's list is read **before** anything is dialled: a list that cannot
/// be read could not take the desktop, and dialling would burn the code.
pub async fn pair(client: &Client, list: &PairedList, payload: &PairPayload, phone_name: &str) -> Result<Challenged, Reason> {
    list.read().map_err(|why| Reason::PhoneListUnreadable { why })?;
    let hint = hint_of(payload.relay.as_deref());
    let Dialled { conn, attempt } = client.dial(PAIR_ALPN, payload.id, hint, None).await?;
    let gone = |client: &Client, conn: &Connection| client.ended(conn, "", &attempt).0;
    let (mut send, mut recv) = match conn.open_bi().await {
        Ok(streams) => streams,
        Err(_) => return Err(gone(client, &conn)),
    };
    let hello = PairHello { secret: hex(&payload.secret), phone_name: phone_name.into() };
    if write_message(&mut send, &hello).await.is_err() {
        return Err(gone(client, &conn));
    }
    let first: Value = match read_message(&mut recv, PAIR_MESSAGE_MAX, "pairing message").await {
        Ok(v) => v,
        Err(_) => return Err(gone(client, &conn)),
    };
    let nonce = match serde_json::from_value::<PairChallenge>(first.clone()) {
        Ok(c) => hex_decode16(&c.nonce).map_err(|why| Reason::PairRefused { reason: why })?,
        Err(_) => {
            return Err(match serde_json::from_value::<PairResult>(first) {
                Ok(PairResult::Refused { reason }) => Reason::PairRefused { reason },
                Ok(PairResult::Declined) => Reason::PairDeclined,
                _ => Reason::PairRefused { reason: "the desktop's answer could not be read".into() },
            });
        }
    };
    let desktop = conn.remote_id();
    let code = matching_code_for(&desktop, &client.ep.id(), &nonce);
    let relay = relay_of(&conn).map(|u| u.to_string()).or_else(|| payload.relay.clone());
    Ok(Challenged { client: client.clone(), conn, _send: send, recv, code, desktop, relay, attempt })
}

impl Challenged {
    /// The six digits, computed from the ids the handshake authenticated.
    pub fn code(&self) -> &str {
        &self.code
    }

    /// Wait for the desktop's answer. **No phone-side deadline**: the desktop
    /// answers, or closes when its code expires.
    pub async fn read_result(&mut self) -> Result<PairResult, Reason> {
        match read_message::<PairResult>(&mut self.recv, PAIR_MESSAGE_MAX, "pairing message").await {
            Ok(result) => Ok(result),
            Err(_) => Err(self.client.ended(&self.conn, "", &self.attempt).0),
        }
    }

    /// Act on the desktop's answer. A `Paired` is stored in the list; if that
    /// fails the desktop has paired a phone that does not know it, and the
    /// reason says so.
    pub fn commit(self, result: PairResult, list: &PairedList, now: u64) -> Result<DesktopEntry, Reason> {
        match result {
            PairResult::Paired { desktop_name } => {
                let entry = DesktopEntry {
                    id: self.desktop.to_string(),
                    relay: self.relay.clone(),
                    desktop_name: desktop_name.clone(),
                    name: None,
                    paired_at: now,
                    last_seen: Some(now),
                };
                list.add(entry.clone()).map_err(|why| Reason::PairedNotSaved { desktop_name, why })?;
                Ok(entry)
            }
            PairResult::Declined => Err(Reason::PairDeclined),
            PairResult::Refused { reason } => Err(Reason::PairRefused { reason }),
        }
    }

    /// `read_result`, then `commit`.
    pub async fn finish(mut self, list: &PairedList, now: u64) -> Result<DesktopEntry, Reason> {
        let result = self.read_result().await?;
        self.commit(result, list, now)
    }
}

// Probing.

/// Whether a desktop answers now, without pairing or connecting.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Probe {
    Reachable { relay: Option<String> },
    Down { reason: Reason },
}

/// Dial the desktop on `vibe/pair/1` and hang up after the handshake. No
/// stream is opened, so the desktop's pairing code is untouched.
pub async fn probe(client: &Client, entry: &DesktopEntry) -> Probe {
    let id = match parse_id(&entry.id) {
        Ok(id) => id,
        Err(reason) => return Probe::Down { reason },
    };
    match client.dial(PAIR_ALPN, id, hint_of(entry.relay.as_deref()), Some(client.timeouts.dial)).await {
        Ok(Dialled { conn, .. }) => {
            let relay = relay_of(&conn).map(|u| u.to_string());
            conn.close(VarInt::from_u32(0), b"probe");
            Probe::Reachable { relay }
        }
        Err(reason) => Probe::Down { reason },
    }
}

// The control stream.

/// The calls waiting for a `Return`, by id. Each answer reaches only its own.
#[derive(Default)]
pub struct Pending {
    waiting: Mutex<Waiting>,
}

#[derive(Default)]
struct Waiting {
    calls: HashMap<u64, oneshot::Sender<Outcome>>,
    /// The reader has stopped: nothing more will be answered, so a call made
    /// from now on fails at once rather than waiting for ever.
    over: bool,
}

impl Pending {
    pub fn wait(&self, call: u64) -> oneshot::Receiver<Outcome> {
        let (tx, rx) = oneshot::channel();
        let mut waiting = self.waiting.lock().unwrap_or_else(|p| p.into_inner());
        if !waiting.over {
            waiting.calls.insert(call, tx);
        }
        rx
    }

    /// Hand an answer to its call. False when nobody was waiting on that id.
    pub fn answer(&self, call: u64, outcome: Outcome) -> bool {
        match self.waiting.lock().unwrap_or_else(|p| p.into_inner()).calls.remove(&call) {
            Some(tx) => tx.send(outcome).is_ok(),
            None => false,
        }
    }

    /// The connection ended: every call still waiting fails, and so does
    /// every call made after.
    pub fn fail_all(&self) {
        let mut waiting = self.waiting.lock().unwrap_or_else(|p| p.into_inner());
        waiting.over = true;
        waiting.calls.clear();
    }
}

/// What the desktop sends after its `Welcome`, read field by field.
///
/// Not [`ToPhone`]: an internally tagged enum buffers its content before it
/// picks a variant, and an event's `Box<RawValue>` payload cannot be read back
/// out of that buffer, so the first event would end the reader. A plain struct
/// reads the payload as the bytes the desktop sent.
#[derive(Deserialize)]
struct Incoming {
    #[serde(rename = "type")]
    kind: String,
    call: Option<u64>,
    ok: Option<Value>,
    err: Option<String>,
    name: Option<String>,
    payload: Option<Box<serde_json::value::RawValue>>,
}

/// How a session ended: the reason the phone says, and the transport's own
/// words for the log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ended {
    pub reason: Reason,
    pub raw: String,
}

/// A connected desktop.
pub struct Session {
    client: Client,
    conn: Connection,
    welcome: Welcome,
    send: tokio::sync::Mutex<SendStream>,
    pending: Arc<Pending>,
    events: Mutex<Option<UnboundedReceiver<Event>>>,
    reader: tokio::task::JoinHandle<()>,
    next_call: AtomicU64,
    phone_app_version: String,
    target_relay: Option<RelayUrl>,
    was_direct: AtomicBool,
}

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session").field("desktop", &self.conn.remote_id()).field("welcome", &self.welcome).finish()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.reader.abort();
        self.conn.close(VarInt::from_u32(0), b"left");
    }
}

/// The connection was lost before the desktop answered this call.
pub const CALL_LOST: &str = "the connection to the desktop closed before it answered";

async fn reader(mut recv: RecvStream, pending: Arc<Pending>, events: UnboundedSender<Event>) {
    loop {
        let Ok(message) = read_message::<Incoming>(&mut recv, CONTROL_MAX, "control message").await else { break };
        match (message.kind.as_str(), message.call, message.name, message.payload) {
            ("return", Some(call), _, _) => {
                let outcome = match message.err {
                    Some(why) => Outcome::Err(why),
                    None => Outcome::Ok(message.ok.unwrap_or(Value::Null)),
                };
                pending.answer(call, outcome);
            }
            ("event", _, Some(name), Some(payload)) => {
                let _ = events.send(Event { name, payload });
            }
            // A message this phone does not know, from a newer desktop: skipped.
            _ => {}
        }
    }
    pending.fail_all();
}

/// Dial a paired desktop and say `Hello`. Returns once its `Welcome` arrived,
/// or why it did not, all within the hint's budget plus [`Timeouts::dial`].
pub async fn connect(client: &Client, entry: &DesktopEntry, hello: Hello) -> Result<Session, Reason> {
    let id = parse_id(&entry.id)?;
    let Dialled { conn, attempt } =
        client.dial(REMOTE_ALPN, id, hint_of(entry.relay.as_deref()), Some(client.timeouts.dial)).await?;
    let phone_app_version = hello.app_version.clone();
    let handshake = async {
        let (mut send, mut recv) = conn.open_bi().await.ok()?;
        write_message(&mut send, &hello).await.ok()?;
        let welcome: Welcome = read_message(&mut recv, CONTROL_MAX, "welcome").await.ok()?;
        Some((send, recv, welcome))
    };
    let (send, recv, welcome) = match tokio::time::timeout(client.timeouts.dial, handshake).await {
        Ok(Some(done)) => done,
        Ok(None) => {
            // A close lands a moment after the read fails; wait for it, briefly,
            // so a VERSION_MISMATCH or NOT_PAIRED is read rather than missed.
            let _ = tokio::time::timeout(client.timeouts.hint.min(Duration::from_secs(1)), conn.closed()).await;
            let reason = client.ended(&conn, &phone_app_version, &attempt).0;
            conn.close(VarInt::from_u32(0), b"no welcome");
            return Err(reason);
        }
        Err(_) => {
            conn.close(VarInt::from_u32(0), b"no welcome in time");
            return Err(classify(&client.net(), &attempt));
        }
    };
    let pending = Arc::new(Pending::default());
    let (tx, rx) = unbounded_channel();
    let reader = tokio::spawn(reader(recv, pending.clone(), tx));
    let was_direct = AtomicBool::new(attempt.direct);
    Ok(Session {
        client: client.clone(),
        conn,
        welcome,
        send: tokio::sync::Mutex::new(send),
        pending,
        events: Mutex::new(Some(rx)),
        reader,
        next_call: AtomicU64::new(1),
        phone_app_version,
        target_relay: attempt.target_relay,
        was_direct,
    })
}

impl Session {
    pub fn welcome(&self) -> &Welcome {
        &self.welcome
    }

    pub fn desktop(&self) -> PublicKey {
        self.conn.remote_id()
    }

    /// One desktop command. Its answer, its refusal, or [`CALL_LOST`].
    pub async fn call(&self, command: &str, args: Value) -> Result<Value, String> {
        let call = self.next_call.fetch_add(1, Ordering::SeqCst);
        let answer = self.pending.wait(call);
        {
            let mut send = self.send.lock().await;
            let message = ToDesktop::Call(Call { call, command: command.into(), args });
            if write_message(&mut *send, &message).await.is_err() {
                self.pending.answer(call, Outcome::Err(CALL_LOST.into()));
                return Err(CALL_LOST.into());
            }
        }
        match answer.await {
            Ok(Outcome::Ok(value)) => Ok(value),
            Ok(Outcome::Err(why)) => Err(why),
            Err(_) => Err(CALL_LOST.into()),
        }
    }

    /// The desktop's events, in the order it emitted them. Taken once.
    pub fn events(&self) -> Option<UnboundedReceiver<Event>> {
        self.events.lock().unwrap_or_else(|p| p.into_inner()).take()
    }

    /// How the connection is travelling now.
    pub fn path(&self) -> PathKind {
        let path = path_of(&self.conn);
        if path != PathKind::None {
            self.was_direct.store(path == PathKind::Direct, Ordering::SeqCst);
        }
        path
    }

    /// Resolves the next time the selected path differs from `last`.
    pub async fn path_changed(&self, last: PathKind) -> PathKind {
        let mut stream = self.conn.paths_stream();
        while stream.next().await.is_some() {
            let now = self.path();
            if now != last {
                return now;
            }
        }
        std::future::pending().await
    }

    /// The desktop's relay as the connection sees it, if it has one.
    pub fn relay(&self) -> Option<String> {
        relay_of(&self.conn).map(|u| u.to_string())
    }

    /// Resolves once the connection has ended, with why.
    pub async fn closed(&self) -> Ended {
        self.conn.closed().await;
        let attempt = Attempt { direct: self.was_direct.load(Ordering::SeqCst), target_relay: self.target_relay.clone() };
        let (reason, raw) = self.client.ended(&self.conn, &self.phone_app_version, &attempt);
        Ended { reason, raw }
    }

    /// Tell the desktop to forget this phone, and wait for it to close.
    async fn send_unpair(&self, wait: Duration) -> bool {
        let written = {
            let mut send = self.send.lock().await;
            write_message(&mut *send, &ToDesktop::Unpair).await.is_ok()
        };
        if written {
            let _ = tokio::time::timeout(wait, self.conn.closed()).await;
        }
        written
    }
}

/// How an unpair ended for the desktop. The phone forgets it either way.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Unpaired {
    /// The desktop was told, or had already forgotten this phone.
    Sent,
    /// Nobody answered; only the phone's entry is gone.
    Unreachable,
}

/// Forget a desktop: tell it over `session` if one is open, else dial it
/// (under [`Timeouts::unpair_dial`]) and tell it. The entry is removed from
/// the list whatever the desktop said. The error is a list that could not be
/// written.
pub async fn unpair(
    client: &Client,
    list: &PairedList,
    entry: &DesktopEntry,
    session: Option<&Session>,
    hello: Hello,
) -> Result<Unpaired, String> {
    let told = match session {
        Some(s) => s.send_unpair(client.timeouts.unpair_wait).await,
        None => tell_unpair(client, entry, hello).await,
    };
    list.remove(&entry.id)?;
    Ok(if told { Unpaired::Sent } else { Unpaired::Unreachable })
}

async fn tell_unpair(client: &Client, entry: &DesktopEntry, hello: Hello) -> bool {
    let Ok(id) = parse_id(&entry.id) else { return false };
    let Dialled { conn, .. } =
        match client.dial(REMOTE_ALPN, id, hint_of(entry.relay.as_deref()), Some(client.timeouts.unpair_dial)).await {
            Ok(d) => d,
            // The desktop has already forgotten this phone: that is what was asked.
            Err(Reason::NotPaired) => return true,
            Err(_) => return false,
        };
    let told = async {
        let (mut send, mut recv) = conn.open_bi().await.ok()?;
        write_message(&mut send, &hello).await.ok()?;
        let _: Welcome = read_message(&mut recv, CONTROL_MAX, "welcome").await.ok()?;
        write_message(&mut send, &ToDesktop::Unpair).await.ok()
    };
    let told = matches!(tokio::time::timeout(client.timeouts.unpair_dial, told).await, Ok(Some(())));
    let told = told || matches!(conn.close_reason().as_ref().map(close_of), Some((Some(c), _)) if c == u64::from(NOT_PAIRED));
    if told {
        let _ = tokio::time::timeout(client.timeouts.unpair_wait, conn.closed()).await;
    }
    conn.close(VarInt::from_u32(0), b"unpaired");
    told
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> RelayUrl {
        s.parse().unwrap()
    }

    fn n0() -> Vec<RelayUrl> {
        vec![url("https://use1-1.relay.n0.iroh.link./"), url("https://euc1-1.relay.n0.iroh.link./")]
    }

    fn seen(u: &str, state: RelayLink) -> RelaySeen {
        RelaySeen { url: url(u), state }
    }

    const A: &str = "https://use1-1.relay.n0.iroh.link./";
    const B: &str = "https://euc1-1.relay.n0.iroh.link./";
    const CUSTOM: &str = "https://relay.example.com./";

    fn net(relays: Vec<RelaySeen>) -> Net {
        Net { online: true, relays, phone_relays: n0() }
    }

    fn via(target: Option<&str>) -> Attempt {
        Attempt { direct: false, target_relay: target.map(url) }
    }

    #[test]
    fn retry_doubles_from_one_second_to_thirty() {
        let waits: Vec<u64> = (0..8).map(|n| retry_after(n).as_secs()).collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 30, 30, 30]);
        assert_eq!(retry_after(u32::MAX), RETRY_CAP);
    }

    #[test]
    fn the_defaults_are_the_named_choices() {
        let t = Timeouts::default();
        assert_eq!(
            (t.hint, t.dial, t.unpair_dial, t.unpair_wait),
            (Duration::from_secs(5), Duration::from_secs(15), Duration::from_secs(5), Duration::from_secs(3))
        );
    }

    #[test]
    fn relay_link_reads_iroh_s_two_facts() {
        assert_eq!(relay_link_of(true, false), RelayLink::Connected);
        assert_eq!(relay_link_of(true, true), RelayLink::Connected);
        assert_eq!(relay_link_of(false, true), RelayLink::Failed);
        assert_eq!(relay_link_of(false, false), RelayLink::Pending);
    }

    #[test]
    fn classify_says_offline_first() {
        let offline = Net { online: false, ..net(vec![seen(A, RelayLink::Failed)]) };
        assert_eq!(classify(&offline, &via(Some(A))), Reason::Offline);
    }

    #[test]
    fn classify_names_the_relays_only_when_the_desktop_s_relay_is_ours_and_failing() {
        use RelayLink::*;
        let cases: Vec<(&str, Vec<RelaySeen>, Attempt, Reason)> = vec![
            ("none listed", vec![], via(Some(A)), Reason::Unreachable),
            ("all connecting", vec![seen(A, Pending), seen(B, Pending)], via(Some(A)), Reason::Unreachable),
            ("all failed", vec![seen(A, Failed), seen(B, Failed)], via(Some(A)), Reason::RelaysUnreachable),
            ("target failed beside a connected", vec![seen(A, Failed), seen(B, Connected)], via(Some(A)), Reason::RelaysUnreachable),
            ("target failed beside a pending", vec![seen(A, Failed), seen(B, Pending)], via(Some(A)), Reason::RelaysUnreachable),
            ("target connected beside a failed", vec![seen(A, Connected), seen(B, Failed)], via(Some(A)), Reason::Unreachable),
            ("unlisted target among mixed", vec![seen(B, Failed), seen(A, Connected)], via(Some(A)), Reason::Unreachable),
            ("direct", vec![seen(A, Failed), seen(B, Failed)], Attempt { direct: true, target_relay: Some(url(A)) }, Reason::Unreachable),
            ("unknown target", vec![seen(A, Failed), seen(B, Failed)], via(None), Reason::Unreachable),
            ("custom target, all failed", vec![seen(A, Failed), seen(B, Failed)], via(Some(CUSTOM)), Reason::Unreachable),
            ("custom target, connected", vec![seen(A, Connected)], via(Some(CUSTOM)), Reason::Unreachable),
        ];
        for (what, relays, attempt, want) in cases {
            assert_eq!(classify(&net(relays), &attempt), want, "{what}");
        }
    }

    #[test]
    fn the_three_codes_read_as_their_reasons_and_anything_else_is_classified() {
        let n = net(vec![]);
        let a = via(None);
        assert_eq!(reason_of(Some(NOT_PAIRED.into()), b"", "1.7.0", &n, &a), Reason::NotPaired);
        assert_eq!(reason_of(Some(REMOTE_OFF.into()), b"", "1.7.0", &n, &a), Reason::RemoteOff);
        let both = serde_json::to_vec(&VersionMismatch { desktop_app_version: "1.7.0".into(), phone_app_version: "1.8.0".into() }).unwrap();
        assert_eq!(
            reason_of(Some(VERSION_MISMATCH.into()), &both, "1.8.0", &n, &a),
            Reason::VersionMismatch { desktop_app_version: Some("1.7.0".into()), phone_app_version: "1.8.0".into() }
        );
        assert_eq!(
            reason_of(Some(VERSION_MISMATCH.into()), b"garbled", "1.8.0", &n, &a),
            Reason::VersionMismatch { desktop_app_version: None, phone_app_version: "1.8.0".into() }
        );
        assert_eq!(reason_of(Some(0), b"", "1.7.0", &n, &a), Reason::Unreachable);
        assert_eq!(reason_of(Some(99), b"", "1.7.0", &n, &a), Reason::Unreachable);
        assert_eq!(reason_of(None, b"", "1.7.0", &Net { online: false, ..n }, &a), Reason::Offline);
    }

    #[test]
    fn a_reason_has_the_shape_the_webview_reads() {
        assert_eq!(serde_json::to_value(Reason::NotPaired).unwrap(), serde_json::json!({ "kind": "notPaired" }));
        assert_eq!(
            serde_json::to_value(Reason::VersionMismatch { desktop_app_version: None, phone_app_version: "1".into() }).unwrap(),
            serde_json::json!({ "kind": "versionMismatch", "desktopAppVersion": null, "phoneAppVersion": "1" })
        );
        assert_eq!(
            serde_json::to_value(Reason::PairedNotSaved { desktop_name: Some("d".into()), why: "w".into() }).unwrap(),
            serde_json::json!({ "kind": "pairedNotSaved", "desktopName": "d", "why": "w" })
        );
    }

    #[test]
    fn an_answer_reaches_only_its_own_call() {
        let pending = Pending::default();
        let mut one = pending.wait(1);
        let mut two = pending.wait(2);
        assert!(pending.answer(2, Outcome::Ok(Value::from(2))));
        assert!(!pending.answer(3, Outcome::Ok(Value::from(3))), "nobody waits on 3");
        assert_eq!(two.try_recv().unwrap(), Outcome::Ok(Value::from(2)));
        assert!(one.try_recv().is_err(), "1 is still waiting");
        pending.fail_all();
        assert!(matches!(one.try_recv(), Err(oneshot::error::TryRecvError::Closed)));
        let mut late = pending.wait(4);
        assert!(matches!(late.try_recv(), Err(oneshot::error::TryRecvError::Closed)), "a call after the end fails at once");
    }

    #[test]
    fn a_return_and_an_event_read_back_with_the_payload_as_sent() {
        let ret: Incoming = serde_json::from_str(r#"{"type":"return","call":7,"ok":null}"#).unwrap();
        assert_eq!((ret.kind.as_str(), ret.call, ret.ok, ret.err), ("return", Some(7), None, None));
        let err: Incoming = serde_json::from_str(r#"{"type":"return","call":7,"err":"no"}"#).unwrap();
        assert_eq!(err.err.as_deref(), Some("no"));
        let event: Incoming = serde_json::from_str(r#"{"type":"event","name":"host://frame","payload":{"a": 1}}"#).unwrap();
        assert_eq!(event.payload.unwrap().get(), r#"{"a": 1}"#);
    }

    const fn send_sync<T: Send + Sync>() {}
    const _: () = send_sync::<Client>();
    const _: () = send_sync::<Session>();
    const _: () = send_sync::<Challenged>();
}
