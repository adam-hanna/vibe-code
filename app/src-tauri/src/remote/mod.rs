//! Remote access: the desktop's half of identity and pairing (#341).
//!
//! A phone controls this app over iroh, a QUIC link addressed by an ed25519
//! public key. This module holds what that needs before any network exists:
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
//! - **the wire** (`wire.rs`), everything the phone also needs, kept free of
//!   Tauri so the shared crate (#345) takes it as a plain file move.
//!
//! **No network and no timer.** The endpoint that calls `attempt` is #342, so
//! until then `remote://pair-request` has no production sender. An unanswered
//! prompt is closed by the window when its clock reaches `expiresAt`, which it
//! already holds; Rust says `expired` only when an answer arrives too late.

pub mod pairing;
pub mod qr;
pub mod wire;
pub mod endpoint;
pub(crate) mod identity;
pub(crate) mod store;

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use iroh_base::PublicKey;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use identity::{Keychain, Vault};
use pairing::{Answer, Pairing};
use qr::QrMatrix;
use store::{Phone, Store};
use wire::PairPayload;

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

struct TauriEmit<'a>(&'a AppHandle);

impl Emit for TauriEmit<'_> {
    fn pair_request(&self, request: &PairRequest) {
        let _ = self.0.emit("remote://pair-request", request);
    }
    fn pair_ended(&self, outcome: Outcome) {
        let _ = self.0.emit("remote://pair-ended", Ended { outcome });
    }
}

/// The pairing state the commands share.
#[derive(Default)]
pub struct Remote {
    pairing: Mutex<Pairing>,
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
    /// Whether the window draws the section at all. See `preview()`.
    pub preview: bool,
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
    let payload = PairPayload { id: key.public(), relay: None, secret, name: hostname }.to_uri();
    let qr = qr::matrix(&payload)?;
    Ok(PairBegin { payload, expires_at: begun.expires_at, qr })
}

/// A phone presents a secret. `phone_id` is the id the QUIC handshake
/// authenticated.
///
/// **No production caller yet**: the `vibe/pair/1` handler that calls this is
/// #342, and there is deliberately no command that reaches it.
#[allow(dead_code, clippy::too_many_arguments)]
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

/// What the window draws. **Never fails and never creates a key**, so
/// `preview` always arrives and the window can hide everything behind it.
pub(crate) fn status(
    vault: &dyn Vault,
    store: Result<Store, String>,
    connections: &dyn Connections,
    preview: bool,
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
    RemoteStatus { endpoint_id, identity_unreadable, phones, phones_unreadable, preview }
}

/// Whether the section is drawn. **The only reader of `VIBE_REMOTE_PREVIEW`**,
/// so the owner can see the screens by hand while a release built from
/// develop shows nothing new. #344 deletes it when the real switch lands.
fn preview() -> bool {
    std::env::var("VIBE_REMOTE_PREVIEW").as_deref() == Ok("1")
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

fn locked(remote: &Remote) -> std::sync::MutexGuard<'_, Pairing> {
    remote.pairing.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
pub fn remote_status(app: AppHandle) -> RemoteStatus {
    status(&Keychain, store_of(&app), &NoConnections, preview())
}

#[tauri::command]
pub fn remote_pair_begin(app: AppHandle, remote: State<'_, Remote>) -> Result<PairBegin, String> {
    let secret = random::<32>()?;
    begin(&mut locked(&remote), &Keychain, &TauriEmit(&app), hostname(), secret, now())
}

#[tauri::command]
pub fn remote_pair_answer(yes: bool, app: AppHandle, remote: State<'_, Remote>) -> Result<Outcome, String> {
    let store = store_of(&app);
    answer(&mut locked(&remote), store.as_ref().map_err(Clone::clone), &TauriEmit(&app), yes, now())
}

#[tauri::command]
pub fn remote_revoke(id: String, app: AppHandle) -> Result<(), String> {
    revoke(&store_of(&app)?, &NoConnections, &id)
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
            begin(&mut self.pairing, &self.vault, &self.emit, Some("desk".into()), SECRET, now).expect("begins")
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
        let got = begin(&mut w.pairing, &w.vault, &w.emit, None, SECRET, 0);
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
        let s = status(&w.vault, Ok(Store::in_dir(&w._dir.0)), &NoConnections, true);
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(keys_of(&json), ["endpointId", "identityUnreadable", "phones", "phonesUnreadable", "preview"]);
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
        let s = status(&w.vault, Ok(Store::in_dir(&w._dir.0)), &NoConnections, false);
        assert_eq!(s.endpoint_id, None);
        assert_eq!(s.identity_unreadable, None);
        assert_eq!(w.vault.writes.get(), 0);
        assert!(w.vault.stored.borrow().is_none());
    }

    #[test]
    fn status_never_fails_and_always_says_whether_to_draw() {
        let w = world("unreadable-status");
        let locked = FakeVault { unreadable: Some("locked".into()), ..FakeVault::default() };

        let s = status(&locked, Err("no data directory".into()), &NoConnections, false);
        assert_eq!(s.phones_unreadable.as_deref(), Some("no data directory"));
        assert!(s.identity_unreadable.as_deref().unwrap().contains("locked"));
        assert!(s.phones.is_empty());
        assert!(!s.preview);

        std::fs::write(w._dir.0.join(store::FILE), "garbage").unwrap();
        let s = status(&w.vault, Ok(Store::in_dir(&w._dir.0)), &NoConnections, true);
        assert!(s.phones_unreadable.is_some());
        assert!(s.phones.is_empty());
        assert!(s.preview);
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
}
