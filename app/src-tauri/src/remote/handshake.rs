//! The `vibe/pair/1` handler: pairing, carried over a connection (#342).
//!
//! #341 built pairing as a state machine with no network: `attempt` checks a
//! secret against the live code and asks the window *Allow `<phone>`?*, and
//! `answer` takes the person's yes or no. This file is the half that talks to
//! the phone, on one stream the phone opens:
//!
//! ```text
//! phone → desktop   PairHello      { secret, phoneName }
//! desktop → phone   PairChallenge  { nonce }                  a right secret
//!                   or PairResult  { kind: "refused", reason } anything else
//! desktop → phone   PairResult     { kind: "paired", desktopName } | { kind: "declined" }
//! ```
//!
//! Each message is a big-endian `u32` length and that many bytes of JSON, the
//! framing the control stream uses too (#343). The phone's id is never in a
//! message: it is the one the QUIC handshake authenticated.
//!
//! Three rules, each a decision about who can act while the prompt is up:
//!
//! - **The prompt's answer reaches the phone that caused it, and only that
//!   one.** A refused attempt never installs a waiter, so a second phone
//!   dialling with the same secret - refused because the first attempt burnt
//!   the code - cannot take the owner's answer. The waiter is installed under
//!   the pairing lock, before the window can have seen the prompt, so a yes
//!   pressed at once is never lost.
//! - **A phone that hangs up declines.** Its prompt would otherwise stay on
//!   the desktop asking about a device that is no longer listening, and a yes
//!   would pair a phone that never heard it.
//! - **A new code ends the wait**, with *declined*, because the prompt it
//!   belonged to is gone.
//!
//! Every wait is bounded by `CODE_TTL_MS`, the code's own life, rather than by
//! a figure chosen here: the hello cannot usefully arrive later than that, and
//! neither can an answer.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::protocol::{AcceptError, ProtocolHandler};
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::sync::oneshot;
use vibe_remote::framing;

use super::identity::Vault;
use super::pairing::{Pairing, CODE_TTL_MS};
use super::store::Store;
use super::wire::{hex, hex_decode32, PairChallenge, PairHello, PairResult, PAIR_MESSAGE_MAX};
use super::{attempt, Emit};

/// The phone waiting on a prompt, and the number that says which wait it is.
struct Waiter {
    generation: u64,
    tell: oneshot::Sender<PairResult>,
}

/// What every pairing road shares: the state machine and the one waiting phone.
///
/// **Lock order is `pairing`, then `waiting`, everywhere**, so the window's
/// answer and a phone's attempt cannot interleave between the prompt being
/// raised and the waiter being installed.
#[derive(Default)]
pub struct Shared {
    pub(crate) pairing: Mutex<Pairing>,
    waiting: Mutex<Option<Waiter>>,
    generation: AtomicU64,
}

impl Shared {
    pub(crate) fn pairing(&self) -> std::sync::MutexGuard<'_, Pairing> {
        self.pairing.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn waiting(&self) -> std::sync::MutexGuard<'_, Option<Waiter>> {
        self.waiting.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Tell the waiting phone, if any, how its prompt ended.
    pub(crate) fn tell(&self, result: PairResult) {
        if let Some(waiter) = self.waiting().take() {
            // A phone that has gone has nobody to tell; that is not an error.
            let _ = waiter.tell.send(result);
        }
    }

    /// Stop waiting, if the wait is still this one. True when it was.
    fn forget(&self, generation: u64) -> bool {
        let mut waiting = self.waiting();
        if waiting.as_ref().is_some_and(|w| w.generation == generation) {
            *waiting = None;
            true
        } else {
            false
        }
    }
}

/// What the handler needs that is not state: where the key and the list are,
/// where events go, the clock, and the nonce source. The desktop's name for
/// the phone travels with the answer, so the command that answers says it.
pub struct Desk {
    pub shared: Arc<Shared>,
    pub vault: Box<dyn Vault + Send + Sync>,
    pub store: Result<Store, String>,
    pub emit: Box<dyn Emit + Send + Sync>,
    pub now: fn() -> u64,
    pub nonce: fn() -> Result<[u8; 16], String>,
}

/// The router's handler for `vibe/pair/1`.
#[derive(Clone)]
pub struct PairHandler(pub Arc<Desk>);

impl std::fmt::Debug for PairHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PairHandler")
    }
}

fn ttl() -> Duration {
    Duration::from_millis(CODE_TTL_MS)
}

/// One pairing message from the phone, bounded by [`PAIR_MESSAGE_MAX`]. The
/// error is a sentence for the phone.
async fn read_message<T: DeserializeOwned>(recv: &mut RecvStream) -> Result<T, String> {
    framing::read_message(recv, PAIR_MESSAGE_MAX, "pairing message").await
}

async fn write_message<T: Serialize>(send: &mut SendStream, message: &T) -> Result<(), AcceptError> {
    framing::write_message(send, message).await.map_err(AcceptError::from_err)
}

/// Send the last message, and wait until the phone has it or has gone. The
/// handler returning drops the connection, which would otherwise discard
/// bytes still in flight.
async fn finish(conn: &Connection, mut send: SendStream, last: &PairResult) -> Result<(), AcceptError> {
    write_message(&mut send, last).await?;
    send.finish()?;
    tokio::select! {
        _ = send.stopped() => {}
        _ = conn.closed() => {}
    }
    Ok(())
}

impl ProtocolHandler for PairHandler {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let desk = &self.0;
        let phone_id = conn.remote_id();
        let (mut send, mut recv) = match tokio::time::timeout(ttl(), conn.accept_bi()).await {
            Ok(Ok(streams)) => streams,
            // The phone opened no stream, or went: nothing to answer.
            Ok(Err(_)) | Err(_) => return Ok(()),
        };

        let hello = match tokio::time::timeout(ttl(), read_message::<PairHello>(&mut recv)).await {
            Ok(Ok(hello)) => hello,
            Ok(Err(reason)) => return finish(&conn, send, &PairResult::Refused { reason }).await,
            Err(_) => {
                let reason = "the pairing code expired before the phone said anything".to_string();
                return finish(&conn, send, &PairResult::Refused { reason }).await;
            }
        };

        let nonce = match (desk.nonce)() {
            Ok(nonce) => nonce,
            Err(reason) => return finish(&conn, send, &PairResult::Refused { reason }).await,
        };
        // A secret that is not hex is still an attempt, and still burns the
        // code: its bytes are compared as they are, and a wrong length is wrong.
        let secret = hex_decode32(&hello.secret).map_or_else(|_| hello.secret.clone().into_bytes(), |s| s.to_vec());

        let store = match &desk.store {
            Ok(store) => store,
            Err(reason) => return finish(&conn, send, &PairResult::Refused { reason: reason.clone() }).await,
        };
        let waited = {
            let mut pairing = desk.shared.pairing();
            let tried = attempt(
                &mut pairing,
                desk.vault.as_ref(),
                store,
                desk.emit.as_ref(),
                &secret,
                phone_id,
                &hello.phone_name,
                nonce,
                (desk.now)(),
            );
            match tried {
                Err(reason) => Err(reason),
                Ok(_) => {
                    let generation = desk.shared.generation.fetch_add(1, Ordering::SeqCst);
                    let (tell, answer) = oneshot::channel();
                    *desk.shared.waiting() = Some(Waiter { generation, tell });
                    Ok((generation, answer))
                }
            }
        };
        // Outside the block, so no lock is held across an await.
        let (generation, answer) = match waited {
            Ok(waiting) => waiting,
            Err(reason) => return finish(&conn, send, &PairResult::Refused { reason }).await,
        };

        write_message(&mut send, &PairChallenge { nonce: hex(&nonce) }).await?;

        let result = tokio::select! {
            told = answer => told.unwrap_or(PairResult::Declined),
            _ = conn.closed() => {
                // Hung up while the prompt was showing: take the prompt down.
                // The pairing lock first, so a yes pressed at this moment
                // either landed already (and the waiter is gone) or waits.
                {
                    let mut pairing = desk.shared.pairing();
                    if desk.shared.forget(generation) {
                        let _ = super::answer(&mut pairing, Err(String::new()), desk.emit.as_ref(), false, (desk.now)());
                    }
                }
                return Ok(());
            }
            _ = tokio::time::sleep(ttl()) => {
                // The code has expired under the prompt. The window closes its
                // own prompt at `expiresAt`; a late answer will say `expired`.
                desk.shared.forget(generation);
                PairResult::Declined
            }
        };
        finish(&conn, send, &result).await
    }
}

#[cfg(test)]
mod tests {
    //! Pairing over a real connection: two endpoints in one process, on
    //! loopback, with no relay and no lookup. The phone side here speaks
    //! exactly what #345's phone will, so these are its contract too.

    use super::*;
    use crate::remote::endpoint::tests::{addr_of, key, phone, settle, Count};
    use crate::remote::endpoint::{Config, Reach, RemoteEndpoint, PAIR_ALPN, REMOTE_ALPN};
    use crate::remote::store::tests::Scratch;
    use crate::remote::wire::{hex_decode16, matching_code_for, PairHello};
    use crate::remote::{answer_prompt, begin_code, Outcome, PairRequest, PairedList};
    use iroh::{Endpoint, EndpointAddr};

    /// A device key that is simply there, as a keychain would hand it over.
    struct Held([u8; 32]);

    impl Vault for Held {
        fn get(&self) -> Result<Option<Vec<u8>>, String> {
            Ok(Some(self.0.to_vec()))
        }
        fn set(&self, _: &[u8; 32]) -> Result<(), String> {
            Err("the test vault holds one key and takes no other".into())
        }
        fn called(&self) -> &'static str {
            "the test vault"
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Sent {
        Request(PairRequest),
        Ended(Outcome),
    }

    /// The window, as far as Rust can tell: the two events, recorded.
    #[derive(Clone, Default)]
    struct Window(Arc<Mutex<Vec<Sent>>>);

    impl Emit for Window {
        fn pair_request(&self, r: &PairRequest) {
            self.0.lock().unwrap().push(Sent::Request(r.clone()));
        }
        fn pair_ended(&self, o: Outcome) {
            self.0.lock().unwrap().push(Sent::Ended(o));
        }
    }

    impl Window {
        fn sent(&self) -> Vec<Sent> {
            std::mem::take(&mut *self.0.lock().unwrap())
        }
    }

    const SECRET: [u8; 32] = [5; 32];
    const NONCE: [u8; 16] = [6; 16];

    fn clock() -> u64 {
        1_000
    }

    fn fixed_nonce() -> Result<[u8; 16], String> {
        Ok(NONCE)
    }

    struct Desktop {
        endpoint: RemoteEndpoint,
        shared: Arc<Shared>,
        window: Window,
        store: Store,
        vault: Held,
        bridge: Count,
        _dir: Scratch,
    }

    impl Desktop {
        async fn new(tag: &str) -> Self {
            Self::reaching(tag, Reach::Loopback).await
        }

        async fn reaching(tag: &str, reach: Reach) -> Self {
            let dir = Scratch::new(tag);
            let store = Store::in_dir(&dir.0);
            let device = key();
            let shared = Arc::new(Shared::default());
            let window = Window::default();
            let desk = Desk {
                shared: shared.clone(),
                vault: Box::new(Held(device.to_bytes())),
                store: Ok(store.clone()),
                emit: Box::new(window.clone()),
                now: clock,
                nonce: fixed_nonce,
            };
            let bridge = Count::default();
            let endpoint = RemoteEndpoint::start(
                Config { key: device.clone(), reach },
                Arc::new(PairedList(Ok(store.clone()))),
                PairHandler(Arc::new(desk)),
                bridge.clone(),
            )
            .await
            .expect("a loopback desktop starts");
            let desktop = Desktop { endpoint, shared, window, store, vault: Held(device.to_bytes()), bridge, _dir: dir };
            desktop.code(SECRET);
            desktop
        }

        /// What pressing *pair a phone* does.
        fn code(&self, secret: [u8; 32]) {
            begin_code(&self.shared, &self.vault, &self.window, Some("desk".into()), None, secret, 0).expect("a code");
        }

        /// What pressing allow or deny does.
        fn answer(&self, yes: bool) -> Result<Outcome, String> {
            answer_prompt(&self.shared, Ok(&self.store), &self.window, Some("desk".into()), yes, clock())
        }

        fn addr(&self) -> EndpointAddr {
            addr_of(&self.endpoint)
        }

        fn paired(&self) -> Vec<String> {
            self.store.load().unwrap().into_iter().map(|p| p.id).collect()
        }
    }

    /// A phone that has sent its hello, and the first thing the desktop said.
    struct Attempt {
        conn: Connection,
        recv: RecvStream,
        _send: SendStream,
        first: serde_json::Value,
    }

    impl Attempt {
        async fn next(&mut self) -> PairResult {
            // Bounded so a desktop that never answers fails the test by name
            // rather than holding it for the code's whole five minutes.
            let value: serde_json::Value = tokio::time::timeout(Duration::from_secs(10), read_message(&mut self.recv))
                .await
                .expect("the desktop answers within ten seconds")
                .expect("the desktop says how it ended");
            serde_json::from_value(value).expect("a pairing result")
        }

        fn challenge(&self) -> [u8; 16] {
            let challenge: PairChallenge = serde_json::from_value(self.first.clone()).expect("a challenge");
            hex_decode16(&challenge.nonce).expect("a 16-byte nonce")
        }

        fn refusal(&self) -> String {
            match serde_json::from_value(self.first.clone()).expect("a pairing result") {
                PairResult::Refused { reason } => reason,
                other => panic!("expected a refusal, got {other:?}"),
            }
        }
    }

    async fn dial(phone: &Endpoint, to: EndpointAddr, secret: &str, name: &str) -> Attempt {
        let conn = phone.connect(to, PAIR_ALPN).await.expect("pairing is reachable");
        let (mut send, mut recv) = conn.open_bi().await.expect("a stream");
        let hello = PairHello { secret: secret.into(), phone_name: name.into() };
        write_message(&mut send, &hello).await.expect("the phone writes");
        let first = tokio::time::timeout(ttl(), read_message(&mut recv)).await.expect("an answer").expect("readable");
        Attempt { conn, recv, _send: send, first }
    }

    fn requests(sent: &[Sent]) -> Vec<&PairRequest> {
        sent.iter()
            .filter_map(|s| match s {
                Sent::Request(r) => Some(r),
                Sent::Ended(_) => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn a_right_secret_and_a_yes_pair_the_phone_that_dialled() {
        let d = Desktop::new("hs-yes").await;
        let phone_key = key();
        let p = phone(phone_key.clone()).await;

        let mut attempt = dial(&p, d.addr(), &hex(&SECRET), "Pixel").await;
        let nonce = attempt.challenge();
        assert_eq!(nonce, NONCE);

        // Both screens show the same six digits, each computed from the ids
        // the handshake authenticated and the nonce on the wire.
        let phone_side = matching_code_for(&d.endpoint.id(), &phone_key.public(), &nonce);
        let sent = d.window.sent();
        let asked = requests(&sent);
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0].code, phone_side);
        assert_eq!(asked[0].phone_name, "Pixel");

        assert_eq!(d.answer(true), Ok(Outcome::Paired));
        assert_eq!(attempt.next().await, PairResult::Paired { desktop_name: Some("desk".into()) });
        assert_eq!(d.paired(), vec![phone_key.public().to_string()]);

        // And the paired phone is now let through to the bridge.
        let conn = p.connect(d.addr(), REMOTE_ALPN).await.expect("a paired phone connects");
        settle().await;
        assert_eq!(d.bridge.seen(), 1);
        conn.close(0u32.into(), b"done");
        attempt.conn.close(0u32.into(), b"done");
        d.endpoint.stop().await;
    }

    #[tokio::test]
    async fn a_reused_secret_is_refused_and_cannot_take_the_owner_s_answer() {
        let d = Desktop::new("hs-reuse").await;
        let owner = phone(key()).await;
        let mut first = dial(&owner, d.addr(), &hex(&SECRET), "Pixel").await;
        first.challenge();

        // Somebody who photographed the code, dialling second.
        let thief_key = key();
        let thief = phone(thief_key.clone()).await;
        let second = dial(&thief, d.addr(), &hex(&SECRET), "Pixel").await;
        assert!(second.refusal().contains("already been used"), "{}", second.refusal());

        assert_eq!(d.answer(true), Ok(Outcome::Paired));
        assert!(matches!(first.next().await, PairResult::Paired { .. }), "the owner hears the yes");
        assert!(!d.paired().contains(&thief_key.public().to_string()));
        assert_eq!(requests(&d.window.sent()).len(), 1, "the second attempt raised no prompt");
        d.endpoint.stop().await;
    }

    #[tokio::test]
    async fn a_wrong_secret_is_refused_and_burns_the_code() {
        let d = Desktop::new("hs-wrong").await;
        let p = phone(key()).await;
        let wrong = dial(&p, d.addr(), &hex(&[9; 32]), "Pixel").await;
        assert!(wrong.refusal().contains("not the pairing code"), "{}", wrong.refusal());
        let right = dial(&p, d.addr(), &hex(&SECRET), "Pixel").await;
        assert!(right.refusal().contains("already been used"), "{}", right.refusal());
        // Not hex at all is still an attempt, against a fresh code.
        d.code([7; 32]);
        let garbled = dial(&p, d.addr(), "not hex", "Pixel").await;
        assert!(garbled.refusal().contains("not the pairing code"), "{}", garbled.refusal());
        assert!(requests(&d.window.sent()).is_empty());
        d.endpoint.stop().await;
    }

    #[tokio::test]
    async fn a_no_declines_and_pairs_nothing() {
        let d = Desktop::new("hs-no").await;
        let p = phone(key()).await;
        let mut attempt = dial(&p, d.addr(), &hex(&SECRET), "Pixel").await;
        attempt.challenge();
        assert_eq!(d.answer(false), Ok(Outcome::Declined));
        assert_eq!(attempt.next().await, PairResult::Declined);
        assert!(d.paired().is_empty());
        d.endpoint.stop().await;
    }

    #[tokio::test]
    async fn a_phone_that_hangs_up_takes_its_prompt_down() {
        let d = Desktop::new("hs-hangup").await;
        let p = phone(key()).await;
        let attempt = dial(&p, d.addr(), &hex(&SECRET), "Pixel").await;
        attempt.challenge();
        d.window.sent();

        attempt.conn.close(0u32.into(), b"gone");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut ended = Vec::new();
        while ended.is_empty() && tokio::time::Instant::now() < deadline {
            settle().await;
            ended = d.window.sent();
        }
        assert_eq!(ended, vec![Sent::Ended(Outcome::Declined)], "the window is told the prompt is over");
        assert_eq!(d.answer(true), Ok(Outcome::Declined), "and a late yes pairs nothing");
        assert!(d.paired().is_empty());
        d.endpoint.stop().await;
    }

    #[tokio::test]
    async fn a_new_code_ends_the_wait_on_the_old_prompt() {
        let d = Desktop::new("hs-new-code").await;
        let p = phone(key()).await;
        let mut attempt = dial(&p, d.addr(), &hex(&SECRET), "Pixel").await;
        attempt.challenge();
        d.code([8; 32]);
        assert_eq!(attempt.next().await, PairResult::Declined);
        d.endpoint.stop().await;
    }

    #[tokio::test]
    async fn an_oversized_hello_is_refused_before_it_is_read() {
        let d = Desktop::new("hs-big").await;
        let p = phone(key()).await;
        let conn = p.connect(d.addr(), PAIR_ALPN).await.expect("pairing is reachable");
        let (mut send, mut recv) = conn.open_bi().await.expect("a stream");
        let claimed = u32::try_from(PAIR_MESSAGE_MAX + 1).unwrap();
        send.write_all(&claimed.to_be_bytes()).await.unwrap();
        let answer: PairResult = read_message(&mut recv).await.expect("the desktop answers");
        assert!(matches!(&answer, PairResult::Refused { reason } if reason.contains("at most")), "{answer:?}");
        // Nothing was presented, so the code still works for the owner.
        let mut owner = dial(&p, d.addr(), &hex(&SECRET), "Pixel").await;
        owner.challenge();
        assert_eq!(d.answer(false), Ok(Outcome::Declined));
        assert_eq!(owner.next().await, PairResult::Declined);
        d.endpoint.stop().await;
    }

    /// Pairing as a phone will do it: dialling the desktop by its id alone,
    /// found through n0's DNS record and reached through its relay.
    ///
    /// **`#[ignore]` on purpose**, like `goes_online_through_a_relay_with_mdns_on`:
    /// it reaches n0's relays and DNS. Run it by hand:
    ///
    /// ```text
    /// cargo test --lib remote::handshake::tests::pairs_by_id -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "reaches n0's relays and DNS; run with --ignored"]
    async fn pairs_by_id_alone_through_n0() {
        use iroh::endpoint::presets;
        let d = Desktop::reaching("hs-n0", Reach::Internet { relay: None, mdns: false }).await;
        tokio::time::timeout(Duration::from_secs(30), d.endpoint.online()).await.expect("online");
        // Long enough for the record to be published; the spike measured 2-3s.
        tokio::time::sleep(Duration::from_secs(5)).await;

        let phone_key = key();
        let p = Endpoint::builder(presets::N0).secret_key(phone_key.clone()).bind().await.expect("a phone binds");
        let started = std::time::Instant::now();
        let mut attempt = dial(&p, EndpointAddr::new(d.endpoint.id()), &hex(&SECRET), "Pixel").await;
        println!("reached by id in {:?}", started.elapsed());
        attempt.challenge();
        assert_eq!(d.answer(true), Ok(Outcome::Paired));
        assert!(matches!(attempt.next().await, PairResult::Paired { .. }));

        let conn = p.connect(EndpointAddr::new(d.endpoint.id()), REMOTE_ALPN).await.expect("connects by id");
        tokio::time::sleep(Duration::from_secs(3)).await;
        println!("status {:?}", d.endpoint.status());
        conn.close(0u32.into(), b"done");
        d.endpoint.stop().await;
    }

    /// The phone's real client (`vibe_remote::client`) against this real
    /// handler, in one process (#346). The phone finds the desktop by id
    /// through an in-memory lookup, as it would through n0 or mDNS.
    mod client {
        use super::*;
        use crate::remote::endpoint::tests::phone_finding;
        use iroh::address_lookup::memory::MemoryLookup;
        use vibe_remote::client::{self as phone_client, Client, Net, Probe, Reason, Timeouts};
        use vibe_remote::paired::{PairedList as PhoneList, FILE as PHONE_FILE};
        use vibe_remote::wire::PairPayload;

        fn online() -> vibe_remote::client::NetReader {
            Arc::new(|| Net { online: true, relays: vec![], phone_relays: vec![] })
        }

        fn quick() -> Timeouts {
            Timeouts {
                hint: Duration::from_millis(500),
                dial: Duration::from_secs(5),
                unpair_dial: Duration::from_secs(2),
                unpair_wait: Duration::from_secs(1),
            }
        }

        struct Phone {
            client: Client,
            list: PhoneList,
            _lookup: MemoryLookup,
            _dir: Scratch,
        }

        async fn phone_for(d: &Desktop, tag: &str, timeouts: Timeouts, net: vibe_remote::client::NetReader) -> Phone {
            let (ep, lookup) = phone_finding(key()).await;
            lookup.add_endpoint_info(d.addr());
            let dir = Scratch::new(tag);
            Phone { client: Client::new(ep, net, timeouts), list: PhoneList::in_dir(&dir.0), _lookup: lookup, _dir: dir }
        }

        fn payload(d: &Desktop, secret: [u8; 32], relay: Option<&str>) -> PairPayload {
            PairPayload { id: d.endpoint.id(), relay: relay.map(str::to_string), secret, name: Some("desk".into()) }
        }

        #[tokio::test]
        async fn the_phone_shows_the_desktop_s_code_while_the_prompt_is_up_and_a_yes_is_stored() {
            let d = Desktop::new("cl-yes").await;
            let p = phone_for(&d, "cl-yes-phone", quick(), online()).await;
            let challenged = phone_client::pair(&p.client, &p.list, &payload(&d, SECRET, None), "Pixel").await.expect("challenged");
            let sent = d.window.sent();
            let asked = requests(&sent);
            assert_eq!(asked.len(), 1, "the prompt is up");
            assert_eq!(challenged.code(), asked[0].code, "both screens show one code, before anybody answers");
            assert_eq!(asked[0].phone_name, "Pixel");

            assert_eq!(d.answer(true), Ok(Outcome::Paired));
            let entry = challenged.finish(&p.list, 7).await.expect("paired");
            assert_eq!(entry.id, d.endpoint.id().to_string());
            assert_eq!(entry.desktop_name.as_deref(), Some("desk"));
            assert_eq!(p.list.read().unwrap().desktops, vec![entry]);
            assert_eq!(d.paired(), vec![p.client.endpoint().id().to_string()]);
            d.endpoint.stop().await;
        }

        #[tokio::test]
        async fn a_no_is_declined_and_stores_nothing() {
            let d = Desktop::new("cl-no").await;
            let p = phone_for(&d, "cl-no-phone", quick(), online()).await;
            let challenged = phone_client::pair(&p.client, &p.list, &payload(&d, SECRET, None), "Pixel").await.expect("challenged");
            assert_eq!(d.answer(false), Ok(Outcome::Declined));
            assert_eq!(challenged.finish(&p.list, 7).await, Err(Reason::PairDeclined));
            assert!(p.list.read().unwrap().desktops.is_empty());
            d.endpoint.stop().await;
        }

        #[tokio::test]
        async fn a_wrong_secret_is_refused_and_burns_the_code() {
            let d = Desktop::new("cl-wrong").await;
            let p = phone_for(&d, "cl-wrong-phone", quick(), online()).await;
            let wrong = phone_client::pair(&p.client, &p.list, &payload(&d, [9; 32], None), "Pixel").await;
            assert!(matches!(&wrong, Err(Reason::PairRefused { reason }) if reason.contains("not the pairing code")), "{wrong:?}");
            let right = phone_client::pair(&p.client, &p.list, &payload(&d, SECRET, None), "Pixel").await;
            assert!(matches!(&right, Err(Reason::PairRefused { reason }) if reason.contains("already been used")), "{right:?}");
            assert!(requests(&d.window.sent()).is_empty());
            d.endpoint.stop().await;
        }

        #[tokio::test]
        async fn dropping_the_challenge_takes_the_prompt_down() {
            let d = Desktop::new("cl-drop").await;
            let p = phone_for(&d, "cl-drop-phone", quick(), online()).await;
            let challenged = phone_client::pair(&p.client, &p.list, &payload(&d, SECRET, None), "Pixel").await.expect("challenged");
            d.window.sent();
            drop(challenged);
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            let mut ended = Vec::new();
            while ended.is_empty() && tokio::time::Instant::now() < deadline {
                settle().await;
                ended = d.window.sent();
            }
            assert_eq!(ended, vec![Sent::Ended(Outcome::Declined)]);
            assert!(d.paired().is_empty());
            d.endpoint.stop().await;
        }

        /// The phone pressed Back as the desktop's yes arrived: a Paired the
        /// phone has already read is committed, whatever the cancel says, so
        /// the two ends agree.
        #[tokio::test]
        async fn a_paired_result_already_read_is_committed_despite_a_cancel() {
            let d = Desktop::new("cl-race").await;
            let p = phone_for(&d, "cl-race-phone", quick(), online()).await;
            let mut challenged = phone_client::pair(&p.client, &p.list, &payload(&d, SECRET, None), "Pixel").await.expect("challenged");
            let (cancel, cancelled) = tokio::sync::oneshot::channel::<()>();
            assert_eq!(d.answer(true), Ok(Outcome::Paired));
            let result = challenged.read_result().await.expect("the desktop's answer");
            cancel.send(()).unwrap();
            assert!(cancelled.await.is_ok(), "the cancel is pending");
            let entry = challenged.commit(result, &p.list, 7).expect("committed");
            assert_eq!(p.list.read().unwrap().desktops, vec![entry]);
            d.endpoint.stop().await;
        }

        #[tokio::test]
        async fn an_unreadable_phone_list_dials_nothing_and_leaves_the_code_usable() {
            let d = Desktop::new("cl-unreadable").await;
            let p = phone_for(&d, "cl-unreadable-phone", quick(), online()).await;
            std::fs::write(p._dir.0.join(PHONE_FILE), "{ not json").unwrap();
            let refused = phone_client::pair(&p.client, &p.list, &payload(&d, SECRET, None), "Pixel").await;
            assert!(matches!(&refused, Err(Reason::PhoneListUnreadable { why }) if why.contains("could not be read")), "{refused:?}");
            settle().await;
            assert!(requests(&d.window.sent()).is_empty(), "no prompt was raised");

            std::fs::remove_file(p._dir.0.join(PHONE_FILE)).unwrap();
            let challenged = phone_client::pair(&p.client, &p.list, &payload(&d, SECRET, None), "Pixel").await.expect("the code still works");
            assert_eq!(d.answer(true), Ok(Outcome::Paired));
            challenged.finish(&p.list, 7).await.expect("paired");
            d.endpoint.stop().await;
        }

        #[tokio::test]
        async fn a_yes_the_phone_cannot_save_says_so_and_leaves_the_file_alone() {
            let d = Desktop::new("cl-not-saved").await;
            let p = phone_for(&d, "cl-not-saved-phone", quick(), online()).await;
            let challenged = phone_client::pair(&p.client, &p.list, &payload(&d, SECRET, None), "Pixel").await.expect("challenged");
            std::fs::write(p._dir.0.join(PHONE_FILE), "{ not json").unwrap();
            assert_eq!(d.answer(true), Ok(Outcome::Paired));
            let got = challenged.finish(&p.list, 7).await;
            assert!(
                matches!(&got, Err(Reason::PairedNotSaved { desktop_name, why }) if desktop_name.as_deref() == Some("desk") && why.contains("could not be read")),
                "{got:?}"
            );
            assert_eq!(d.paired(), vec![p.client.endpoint().id().to_string()], "the desktop holds the phone");
            assert_eq!(std::fs::read_to_string(p._dir.0.join(PHONE_FILE)).unwrap(), "{ not json");
            d.endpoint.stop().await;
        }

        #[tokio::test]
        async fn a_stale_relay_hint_still_reaches_the_prompt_by_lookup() {
            let d = Desktop::new("cl-stale").await;
            let p = phone_for(&d, "cl-stale-phone", quick(), online()).await;
            let stale = payload(&d, SECRET, Some("https://stale.relay.example./"));
            let challenged = phone_client::pair(&p.client, &p.list, &stale, "Pixel").await.expect("found by id");
            assert_eq!(requests(&d.window.sent()).len(), 1);
            assert_eq!(d.answer(true), Ok(Outcome::Paired));
            challenged.finish(&p.list, 7).await.expect("paired");
            d.endpoint.stop().await;
        }

        /// Every phone deadline is 50ms and the desktop answers after 500ms:
        /// pairing still finishes, because nothing on the phone times it.
        #[tokio::test]
        async fn pairing_has_no_phone_side_deadline() {
            let d = Desktop::new("cl-no-deadline").await;
            let tiny = Duration::from_millis(50);
            let p = phone_for(&d, "cl-no-deadline-phone", Timeouts { hint: tiny, dial: tiny, unpair_dial: tiny, unpair_wait: tiny }, online()).await;
            let challenged = phone_client::pair(&p.client, &p.list, &payload(&d, SECRET, None), "Pixel").await.expect("challenged");
            let answer = async {
                tokio::time::sleep(Duration::from_millis(500)).await;
                d.answer(true)
            };
            let (answered, finished) = tokio::join!(answer, challenged.finish(&p.list, 7));
            assert_eq!(answered, Ok(Outcome::Paired));
            assert!(finished.is_ok(), "{finished:?}");
            d.endpoint.stop().await;
        }

        #[tokio::test]
        async fn a_probe_reaches_the_desktop_and_burns_nothing() {
            let d = Desktop::new("cl-probe").await;
            let p = phone_for(&d, "cl-probe-phone", quick(), online()).await;
            let entry = vibe_remote::paired::DesktopEntry {
                id: d.endpoint.id().to_string(),
                relay: None,
                desktop_name: None,
                name: None,
                paired_at: 0,
                last_seen: None,
            };
            assert_eq!(phone_client::probe(&p.client, &entry).await, Probe::Reachable { relay: None });
            settle().await;
            assert!(d.window.sent().is_empty(), "no prompt, no ending");
            let challenged = phone_client::pair(&p.client, &p.list, &payload(&d, SECRET, None), "Pixel").await.expect("the code is still usable");
            drop(challenged);

            d.endpoint.stop().await;
            let quick_dial = Timeouts { dial: Duration::from_millis(500), ..quick() };
            let gone = Client::new(p.client.endpoint().clone(), online(), quick_dial);
            assert_eq!(phone_client::probe(&gone, &entry).await, Probe::Down { reason: Reason::Unreachable });
            let offline = Client::new(
                p.client.endpoint().clone(),
                Arc::new(|| Net { online: false, relays: vec![], phone_relays: vec![] }),
                quick_dial,
            );
            assert_eq!(phone_client::probe(&offline, &entry).await, Probe::Down { reason: Reason::Offline });
        }

        #[tokio::test]
        async fn a_relay_less_endpoint_sees_no_relays_and_classifies_as_unreachable() {
            let (ep, _lookup) = phone_finding(key()).await;
            let seen = phone_client::relays_seen(&ep);
            assert!(seen.is_empty());
            let net = Net { online: true, relays: seen, phone_relays: vec![] };
            assert_eq!(phone_client::classify(&net, &phone_client::Attempt::default()), Reason::Unreachable);
        }
    }

    #[test]
    fn the_pairing_message_bound_is_pinned() {
        // The phone reads with the same bound; a desktop that wrote more than
        // an older phone accepts would be refused by it.
        assert_eq!(PAIR_MESSAGE_MAX, 4096);
    }
}
