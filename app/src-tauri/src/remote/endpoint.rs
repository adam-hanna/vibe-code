//! The desktop's iroh endpoint: the half of a phone connection that waits (#342).
//!
//! A phone dials this desktop by its **endpoint id**, the public half of the
//! device key. It never needs an IP address: iroh looks the id up (n0's DNS
//! record, or mDNS on the same network), connects through a relay, and then
//! hole-punches to a direct path. So a desktop that rebooted, or moved to another
//! network, is found again with nothing on the phone's side changing. #339
//! measured it: reachable 2.1-2.8s after a restart, and no ping lost across an IP
//! change mid-session.
//!
//! ## What this file decides
//!
//! - **Two ALPNs and nothing else.** `vibe/pair/1` is open to anybody, because a
//!   phone being paired is not on the list yet; what it can do there is bounded
//!   by the one-time secret. `vibe/remote/1` is everything else, and only for
//!   paired ids. An unknown ALPN fails the TLS handshake, inside iroh.
//! - **An unpaired id is refused before a stream is read.** The check is an
//!   `after_handshake` hook: the handshake has authenticated the remote's key, so
//!   the id is a fact rather than a claim, and the connection is closed with
//!   [`NOT_PAIRED`] before the router ever hands it to a handler. The phone reads
//!   that code to say *removed this phone* rather than *can't reach*.
//! - **The record carries no IP address.** n0's publisher keeps its default
//!   relay-only filter, so anybody who looks the id up learns its relay and no
//!   more. The spike checked the live record.
//! - **No port mapping.** iroh's `portmapper` asks the home router to forward a
//!   port here; that feature is not compiled in (see `Cargo.toml`).
//!
//! ## What it does not decide
//!
//! Whether remote access is on, which key to use, who is paired, what a pairing
//! attempt is checked against, and what a paired connection is used for. Those
//! arrive as [`Config`], a [`Gate`] and two handlers, so this file holds no
//! settings, no keychain and no pairing state. **Nothing starts an endpoint
//! unless remote access is on**: with it off there is no [`RemoteEndpoint`], so no
//! socket, no relay connection and no published record.
//!
//! ## Network changes and relays
//!
//! On a desktop, iroh watches the interfaces itself: it rebinds, re-runs its
//! network report and republishes the record when the address changes, and a
//! direct path migrates. A relay that goes away is retried with a backoff; an
//! established direct connection does not need it. Neither needs code here. What
//! does is being able to *say* which state it is in, and that is [`Status`].

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use iroh::endpoint::{AfterHandshakeOutcome, Connection, EndpointHooks, VarInt, WeakConnectionHandle};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{EndpointId, RelayUrl, SecretKey, Watcher};
// The internet builder is the shared crate's; only the loopback one is built here.
#[cfg(test)]
use iroh::Endpoint;
use serde::Serialize;

/// The two ALPNs and the close code are the phone's too, so they live in the
/// shared crate (#345).
pub use vibe_remote::{NOT_PAIRED, PAIR_ALPN, REMOTE_ALPN};

/// Who may open `vibe/remote/1`.
///
/// The paired list implements it (#341). **It must fail closed**: a list that
/// cannot be read answers `false` for everybody, because refusing a phone that
/// was paired costs a reconnect and admitting one that was revoked costs the
/// desktop.
pub trait Gate: Send + Sync + fmt::Debug + 'static {
    fn is_paired(&self, id: &EndpointId) -> bool;
}

/// How the endpoint reaches the world.
#[derive(Clone, Debug)]
pub enum Reach {
    /// n0's DNS record and relays, as #340 decided. `relay` replaces n0's relays
    /// with one the user runs (`iroh-relay`), and is what the record then names.
    /// `mdns` adds the local-network lookup.
    Internet { relay: Option<RelayUrl>, mdns: bool },
    /// Loopback only: no relay, no lookup, nothing published. For the tests, which
    /// must not touch the network.
    #[cfg(test)]
    Loopback,
}

/// What an endpoint is started with.
#[derive(Clone, Debug)]
pub struct Config {
    /// The device key. Its public half is the endpoint id phones dial.
    pub key: SecretKey,
    pub reach: Reach,
}

/// The `after_handshake` hook that keeps unpaired ids off `vibe/remote/1`.
///
/// It holds the gate and never the endpoint, which iroh asks of every hook: an
/// endpoint stored on its own hook is a reference cycle that is never dropped.
#[derive(Debug)]
struct PairedOnly {
    gate: Arc<dyn Gate>,
}

impl EndpointHooks for PairedOnly {
    fn after_handshake<'a>(
        &'a self,
        conn: &'a Connection,
    ) -> impl std::future::Future<Output = AfterHandshakeOutcome> + Send + 'a {
        async move {
            if conn.alpn() == REMOTE_ALPN && !self.gate.is_paired(&conn.remote_id()) {
                AfterHandshakeOutcome::Reject {
                    error_code: VarInt::from_u32(NOT_PAIRED),
                    reason: b"not paired".to_vec(),
                }
            } else {
                AfterHandshakeOutcome::accept()
            }
        }
    }
}

/// The live `vibe/remote/1` connections, by phone, so a revoke can drop them.
///
/// Weak handles: a strong one would keep a connection open after the bridge had
/// finished with it, and iroh closes a connection when its last strong handle
/// goes.
#[derive(Clone, Default)]
pub struct Live {
    live: Arc<Mutex<HashMap<EndpointId, Vec<WeakConnectionHandle>>>>,
    /// Told once when a paired phone connects and once when it goes (#344).
    /// The app's emits `remote://connections`, which carries nothing: a client
    /// re-reads `remote_status`, so there is one source for who is connected.
    notify: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl fmt::Debug for Live {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Live").field("notifies", &self.notify.is_some()).finish_non_exhaustive()
    }
}

/// Held for as long as a paired phone's connection is being served, and says
/// so when it goes - however that is: the phone closing, a revoke, an Unpair,
/// or the endpoint stopping, which aborts the handler and drops this with it.
/// So it is the one place a disconnect is announced, and it is announced once.
struct Announced(Live);

impl Drop for Announced {
    fn drop(&mut self) {
        self.0.announce();
    }
}

impl Live {
    /// A set that announces each paired phone's connect and disconnect.
    pub fn notifying(notify: impl Fn() + Send + Sync + 'static) -> Self {
        Live { live: Arc::default(), notify: Some(Arc::new(notify)) }
    }

    fn announce(&self) {
        if let Some(notify) = &self.notify {
            notify();
        }
    }

    fn add(&self, conn: &Connection) {
        let mut live = self.live.lock().unwrap_or_else(|p| p.into_inner());
        let handles = live.entry(conn.remote_id()).or_default();
        handles.retain(|h| h.upgrade().is_some_and(|c| c.close_reason().is_none()));
        handles.push(conn.weak_handle());
    }

    /// The connections still open, by phone.
    fn open(&self) -> Vec<(EndpointId, Connection)> {
        let live = self.live.lock().unwrap_or_else(|p| p.into_inner());
        live.iter()
            .flat_map(|(id, handles)| {
                handles
                    .iter()
                    .filter_map(|h| h.upgrade())
                    .filter(|c| c.close_reason().is_none())
                    .map(move |c| (*id, c))
            })
            .collect()
    }

    /// Whether a phone has a connection open now.
    pub fn connected(&self, id: &EndpointId) -> bool {
        self.open().iter().any(|(open, _)| open == id)
    }

    /// Close every connection a phone has open, with [`NOT_PAIRED`]. Returns how
    /// many were closed. Called after the phone has left the paired list, so the
    /// hook refuses it when it dials again.
    pub fn close(&self, id: &EndpointId) -> usize {
        let mut live = self.live.lock().unwrap_or_else(|p| p.into_inner());
        let Some(handles) = live.remove(id) else { return 0 };
        let mut closed = 0;
        for conn in handles.iter().filter_map(|h| h.upgrade()) {
            if conn.close_reason().is_none() {
                conn.close(VarInt::from_u32(NOT_PAIRED), b"not paired");
                closed += 1;
            }
        }
        closed
    }
}

/// The revoke and the status speak the paired list's spelling of an id, a string.
/// One that does not parse names no endpoint, so nothing is connected under it
/// and nothing is closed.
impl super::Connections for Live {
    fn close(&self, id: &str) {
        if let Ok(id) = id.parse::<EndpointId>() {
            Live::close(self, &id);
        }
    }
    fn connected(&self, id: &str) -> bool {
        id.parse::<EndpointId>().is_ok_and(|id| Live::connected(self, &id))
    }
}

/// The router's handler for `vibe/remote/1`: register, check once more, hand on.
///
/// The hook already refused unpaired ids. The second check is for a revoke that
/// lands between the hook and here, and the order is what makes it sufficient:
/// the connection is registered **first**, so a revoke after that point finds and
/// closes it, and a revoke before it is seen by the check.
#[derive(Debug)]
struct Remote<B> {
    gate: Arc<dyn Gate>,
    connections: Live,
    bridge: B,
}

impl<B: ProtocolHandler> ProtocolHandler for Remote<B> {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        self.connections.add(&conn);
        if !self.gate.is_paired(&conn.remote_id()) {
            conn.close(VarInt::from_u32(NOT_PAIRED), b"not paired");
            return Ok(());
        }
        // Announced only once the gate has admitted it: an unpaired dial is not a
        // phone connecting. No strong handle is kept, so the weak-handle rule
        // above still holds.
        self.connections.announce();
        let _left = Announced(self.connections.clone());
        self.bridge.accept(conn).await
    }
}

/// How a phone's connection is travelling right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PathKind {
    /// Straight between the two machines, hole-punched or on the same network.
    Direct,
    /// Through a relay, which sees only ciphertext.
    Relay,
    /// No path is selected at this moment, usually while one is being replaced.
    None,
}

fn path_of(conn: &Connection) -> PathKind {
    let paths = conn.paths();
    match paths.iter().find(|p| p.is_selected()) {
        Some(p) if p.is_relay() => PathKind::Relay,
        Some(_) => PathKind::Direct,
        None => PathKind::None,
    }
}

/// One home relay, as the endpoint sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
    pub url: String,
    pub connected: bool,
    /// The last failure, for the diagnostics. iroh's error text, which it says is
    /// for display and not for matching.
    pub error: Option<String>,
}

/// One live phone connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    pub id: String,
    pub path: PathKind,
}

/// What the diagnostics say about the endpoint. Every field is read off iroh at
/// the moment of asking; nothing here is remembered or inferred.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub endpoint_id: String,
    /// Empty before a home relay is chosen, and always empty with relays off.
    pub relays: Vec<RelayInfo>,
    pub links: Vec<LinkInfo>,
}

/// A running endpoint. Dropping it aborts the accept loop; [`Self::stop`] closes
/// it cleanly.
pub struct RemoteEndpoint {
    router: Router,
    connections: Live,
}

impl fmt::Debug for RemoteEndpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteEndpoint").field("id", &self.id()).finish()
    }
}

impl RemoteEndpoint {
    /// Bind and start accepting.
    ///
    /// `pair` serves `vibe/pair/1` (#341's handshake); `bridge` serves
    /// `vibe/remote/1` once the gate has admitted the phone (#343).
    // The app starts through `start_with`; the tests and the pairing handler's
    // tests start here.
    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn start(
        config: Config,
        gate: Arc<dyn Gate>,
        pair: impl ProtocolHandler,
        bridge: impl ProtocolHandler,
    ) -> Result<Self, String> {
        Self::start_with(config, gate, Live::default(), pair, bridge).await
    }

    /// `start`, registering connections into a [`Live`] the caller holds too,
    /// so the bridge's Unpair closes the same set a revoke does (#343).
    pub async fn start_with(
        config: Config,
        gate: Arc<dyn Gate>,
        connections: Live,
        pair: impl ProtocolHandler,
        bridge: impl ProtocolHandler,
    ) -> Result<Self, String> {
        let hook = PairedOnly { gate: gate.clone() };
        let builder = match &config.reach {
            Reach::Internet { relay, mdns } => vibe_remote::reach::internet(relay.clone(), *mdns),
            #[cfg(test)]
            Reach::Loopback => Endpoint::builder(iroh::endpoint::presets::Minimal)
                .relay_mode(iroh::RelayMode::Disabled)
                .clear_address_lookup()
                .bind_addr(std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
                .map_err(|e| format!("could not bind to loopback: {e}"))?,
        };
        let endpoint = builder
            .secret_key(config.key)
            .hooks(hook)
            .bind()
            .await
            .map_err(|e| format!("the remote-access endpoint could not start: {e}"))?;

        let remote = Remote {
            gate,
            connections: connections.clone(),
            bridge,
        };
        let router = Router::builder(endpoint)
            .accept(REMOTE_ALPN, remote)
            .accept(PAIR_ALPN, pair)
            .spawn();
        Ok(Self {
            router,
            connections,
        })
    }

    pub fn id(&self) -> EndpointId {
        self.router.endpoint().id()
    }

    /// The live connections, for a revoke.
    pub fn connections(&self) -> &Live {
        &self.connections
    }

    /// Where a phone should dial first, for the QR code: the home relay, once one
    /// is chosen. `None` with relays off or before the endpoint is online.
    pub fn relay_hint(&self) -> Option<RelayUrl> {
        self.router.endpoint().addr().relay_urls().next().cloned()
    }

    pub fn status(&self) -> Status {
        let endpoint = self.router.endpoint();
        let relays = endpoint
            .home_relay_status()
            .get()
            .into_iter()
            .map(|r| RelayInfo {
                url: r.url().to_string(),
                connected: r.is_connected(),
                error: r.last_error().map(|e| e.to_string()),
            })
            .collect();
        let links = self
            .connections
            .open()
            .into_iter()
            .map(|(id, conn)| LinkInfo {
                id: id.to_string(),
                path: path_of(&conn),
            })
            .collect();
        Status {
            endpoint_id: endpoint.id().to_string(),
            relays,
            links,
        }
    }

    /// Close every connection and the endpoint, which also stops publishing.
    /// The remote-access switch turning off (#344) and a relay change are the
    /// callers; each disconnect is announced by the connection's own guard.
    pub async fn stop(self) {
        let _ = self.router.shutdown().await;
    }

    /// Resolves once a home relay is connected.
    #[cfg(test)]
    pub(crate) async fn online(&self) {
        self.router.endpoint().online().await;
    }

    #[cfg(test)]
    fn endpoint(&self) -> &Endpoint {
        self.router.endpoint()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use iroh::endpoint::{presets, ApplicationClose, ConnectionError};
    use iroh::RelayMode;
    use iroh::EndpointAddr;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// A paired list the test controls, which a revoke can shrink. It counts how
    /// often it is asked, which is how a test tells the hook's refusal (asked once)
    /// from the router's second check (asked twice).
    #[derive(Debug, Default)]
    pub(crate) struct List {
        ids: Mutex<HashSet<EndpointId>>,
        asked: AtomicUsize,
    }

    impl List {
        pub(crate) fn with(ids: &[EndpointId]) -> Arc<Self> {
            Arc::new(Self {
                ids: Mutex::new(ids.iter().copied().collect()),
                asked: AtomicUsize::new(0),
            })
        }
        pub(crate) fn remove(&self, id: &EndpointId) {
            self.ids.lock().unwrap().remove(id);
        }
        fn asked(&self) -> usize {
            self.asked.load(Ordering::SeqCst)
        }
    }

    impl Gate for List {
        fn is_paired(&self, id: &EndpointId) -> bool {
            self.asked.fetch_add(1, Ordering::SeqCst);
            self.ids.lock().unwrap().contains(id)
        }
    }

    /// A handler that counts what reached it and then holds the connection open
    /// until the other side or a revoke closes it.
    #[derive(Clone, Debug, Default)]
    pub(crate) struct Count(Arc<AtomicUsize>);

    impl Count {
        pub(crate) fn seen(&self) -> usize {
            self.0.load(Ordering::SeqCst)
        }
    }

    impl ProtocolHandler for Count {
        async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            conn.closed().await;
            Ok(())
        }
    }

    pub(crate) fn key() -> SecretKey {
        SecretKey::generate()
    }

    async fn desktop(gate: Arc<dyn Gate>, pair: Count, bridge: Count) -> RemoteEndpoint {
        let config = Config {
            key: key(),
            reach: Reach::Loopback,
        };
        RemoteEndpoint::start(config, gate, pair, bridge)
            .await
            .expect("a loopback endpoint starts")
    }

    pub(crate) async fn phone(key: SecretKey) -> Endpoint {
        Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .clear_address_lookup()
            .bind_addr(std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
            .expect("loopback")
            .secret_key(key)
            .bind()
            .await
            .expect("a phone endpoint binds")
    }

    /// The desktop's address, by its bound loopback socket: no lookup exists in
    /// these tests, which is the point of them.
    pub(crate) fn addr_of(desktop: &RemoteEndpoint) -> EndpointAddr {
        let ep = desktop.endpoint();
        let socket = ep
            .bound_sockets()
            .into_iter()
            .find(|s| s.is_ipv4())
            .expect("an IPv4 socket");
        EndpointAddr::new(ep.id()).with_ip_addr(socket)
    }

    /// How a connection ended, as the phone sees it. A refusal can land during
    /// `connect` or just after it, and both are the same refusal.
    pub(crate) async fn closing_code(phone: &Endpoint, to: EndpointAddr, alpn: &[u8]) -> Option<u64> {
        let ended = match phone.connect(to, alpn).await {
            Ok(conn) => tokio::time::timeout(Duration::from_secs(10), conn.closed())
                .await
                .expect("the desktop closes the connection"),
            // Refused inside the handshake: no close code to read.
            Err(_) => return None,
        };
        match ended {
            ConnectionError::ApplicationClosed(ApplicationClose { error_code, .. }) => {
                Some(error_code.into_inner())
            }
            _ => None,
        }
    }

    pub(crate) async fn settle() {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    #[tokio::test]
    async fn an_unpaired_id_is_closed_with_not_paired_before_the_bridge_sees_it() {
        let bridge = Count::default();
        let list = List::with(&[]);
        let d = desktop(list.clone(), Count::default(), bridge.clone()).await;
        let p = phone(key()).await;

        let code = closing_code(&p, addr_of(&d), REMOTE_ALPN).await;

        assert_eq!(code, Some(NOT_PAIRED as u64), "refused with the code the phone reads");
        settle().await;
        assert_eq!(bridge.seen(), 0, "the bridge never saw an unpaired phone");
        assert_eq!(list.asked(), 1, "refused by the hook, before the router handed it on");
        d.stop().await;
    }

    #[tokio::test]
    async fn a_paired_id_reaches_the_bridge() {
        let phone_key = key();
        let bridge = Count::default();
        let d = desktop(List::with(&[phone_key.public()]), Count::default(), bridge.clone()).await;
        let p = phone(phone_key.clone()).await;

        let conn = p.connect(addr_of(&d), REMOTE_ALPN).await.expect("a paired phone connects");
        settle().await;

        assert_eq!(bridge.seen(), 1);
        assert!(d.connections().connected(&phone_key.public()));
        let status = d.status();
        assert_eq!(status.links.len(), 1);
        assert_eq!(status.links[0].id, phone_key.public().to_string());
        assert_eq!(status.links[0].path, PathKind::Direct, "loopback has no relay to be on");
        assert!(status.relays.is_empty(), "relays are off in this test");
        conn.close(0u32.into(), b"done");
        d.stop().await;
    }

    #[tokio::test]
    async fn the_pairing_alpn_is_open_to_an_unpaired_id() {
        let pair = Count::default();
        let d = desktop(List::with(&[]), pair.clone(), Count::default()).await;
        let p = phone(key()).await;

        let conn = p.connect(addr_of(&d), PAIR_ALPN).await.expect("pairing is reachable");
        settle().await;

        assert_eq!(pair.seen(), 1, "a phone not yet paired can start pairing");
        conn.close(0u32.into(), b"done");
        d.stop().await;
    }

    #[tokio::test]
    async fn an_unknown_alpn_is_refused() {
        let pair = Count::default();
        let bridge = Count::default();
        let d = desktop(List::with(&[]), pair.clone(), bridge.clone()).await;
        let p = phone(key()).await;

        let result = tokio::time::timeout(
            Duration::from_secs(10),
            p.connect(addr_of(&d), b"vibe/spike/0"),
        )
        .await
        .expect("the attempt ends rather than hangs");

        assert!(result.is_err(), "no connection on an ALPN the desktop does not speak");
        settle().await;
        assert_eq!(pair.seen() + bridge.seen(), 0);
        d.stop().await;
    }

    #[tokio::test]
    async fn a_revoke_drops_a_live_connection_and_refuses_the_next_dial() {
        let phone_key = key();
        let list = List::with(&[phone_key.public()]);
        let bridge = Count::default();
        let d = desktop(list.clone(), Count::default(), bridge.clone()).await;
        let p = phone(phone_key.clone()).await;
        let conn = p.connect(addr_of(&d), REMOTE_ALPN).await.expect("connects while paired");
        settle().await;

        // The order #341's revoke uses: off the list first, then close.
        list.remove(&phone_key.public());
        assert_eq!(d.connections().close(&phone_key.public()), 1);

        let ended = tokio::time::timeout(Duration::from_secs(10), conn.closed())
            .await
            .expect("the live connection is dropped");
        assert!(
            matches!(&ended, ConnectionError::ApplicationClosed(c) if c.error_code.into_inner() == NOT_PAIRED as u64),
            "dropped with NOT_PAIRED, got {ended:?}"
        );
        assert!(!d.connections().connected(&phone_key.public()));

        let again = closing_code(&p, addr_of(&d), REMOTE_ALPN).await;
        assert_eq!(again, Some(NOT_PAIRED as u64), "and refused on the next dial");
        assert_eq!(bridge.seen(), 1, "the second dial never reached the bridge");
        d.stop().await;
    }

    #[tokio::test]
    async fn closing_a_phone_with_nothing_open_closes_nothing() {
        let d = desktop(List::with(&[]), Count::default(), Count::default()).await;
        assert_eq!(d.connections().close(&key().public()), 0);
        d.stop().await;
    }

    /// The internet road, for real: n0's preset with mDNS, online through a relay.
    ///
    /// **`#[ignore]` on purpose**: it reaches n0's relays and DNS server, and the
    /// suite never touches the network. Run it by hand:
    ///
    /// ```text
    /// cargo test --lib remote::endpoint::tests::goes_online -- --ignored --nocapture
    /// ```
    ///
    /// It prints the endpoint id, so the published record can be checked with
    /// `dig TXT _iroh.<z32 id>.dns.iroh.link` for a relay URL and no IP address.
    #[tokio::test]
    #[ignore = "reaches n0's relays and DNS; run with --ignored"]
    async fn goes_online_through_a_relay_with_mdns_on() {
        let config = Config {
            key: key(),
            reach: Reach::Internet { relay: None, mdns: true },
        };
        let d = RemoteEndpoint::start(config, List::with(&[]), Count::default(), Count::default())
            .await
            .expect("an internet endpoint starts");
        tokio::time::timeout(Duration::from_secs(30), d.endpoint().online())
            .await
            .expect("online within 30s");
        let status = d.status();
        println!("endpoint {} relays {:?}", status.endpoint_id, status.relays);
        assert!(status.relays.iter().any(|r| r.connected), "a home relay is connected");
        assert!(d.relay_hint().is_some(), "the QR code has a relay to name");
        // Long enough for the publisher to have written the record.
        tokio::time::sleep(Duration::from_secs(5)).await;
        d.stop().await;
    }

    /// A desktop whose connection set counts its announcements (#344).
    async fn announcing(gate: Arc<dyn Gate>) -> (RemoteEndpoint, Arc<AtomicUsize>) {
        let announced = Arc::new(AtomicUsize::new(0));
        let count = announced.clone();
        let live = Live::notifying(move || {
            count.fetch_add(1, Ordering::SeqCst);
        });
        let config = Config { key: key(), reach: Reach::Loopback };
        let d = RemoteEndpoint::start_with(config, gate, live, Count::default(), Count::default())
            .await
            .expect("a loopback endpoint starts");
        (d, announced)
    }

    async fn until_count(count: &AtomicUsize, n: usize) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while count.load(Ordering::SeqCst) < n {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("only {} announcements, waiting for {n}", count.load(Ordering::SeqCst)));
    }

    #[tokio::test]
    async fn a_connect_and_a_disconnect_are_each_announced_once() {
        let phone_key = key();
        let (d, announced) = announcing(List::with(&[phone_key.public()])).await;
        let p = phone(phone_key).await;

        let conn = p.connect(addr_of(&d), REMOTE_ALPN).await.expect("connects");
        until_count(&announced, 1).await;
        settle().await;
        assert_eq!(announced.load(Ordering::SeqCst), 1, "a connect is one announcement");

        conn.close(0u32.into(), b"bye");
        until_count(&announced, 2).await;
        settle().await;
        assert_eq!(announced.load(Ordering::SeqCst), 2, "and a disconnect one more");
        d.stop().await;
        assert_eq!(announced.load(Ordering::SeqCst), 2, "stopping with nobody connected says nothing");
    }

    #[tokio::test]
    async fn stopping_with_a_phone_connected_announces_its_disconnect_once() {
        let phone_key = key();
        let (d, announced) = announcing(List::with(&[phone_key.public()])).await;
        let p = phone(phone_key).await;
        let conn = p.connect(addr_of(&d), REMOTE_ALPN).await.expect("connects");
        until_count(&announced, 1).await;

        d.stop().await;
        tokio::time::timeout(Duration::from_secs(10), conn.closed()).await.expect("the phone is dropped");
        settle().await;
        assert_eq!(announced.load(Ordering::SeqCst), 2, "the guard is the only source");
    }

    #[tokio::test]
    async fn an_unpaired_dial_announces_nothing() {
        let (d, announced) = announcing(List::with(&[])).await;
        let p = phone(key()).await;
        assert_eq!(closing_code(&p, addr_of(&d), REMOTE_ALPN).await, Some(NOT_PAIRED as u64));
        // Nor does a pairing connection: it is not a paired phone connecting.
        let pairing = p.connect(addr_of(&d), PAIR_ALPN).await.expect("pairing is reachable");
        settle().await;
        pairing.close(0u32.into(), b"done");
        settle().await;
        assert_eq!(announced.load(Ordering::SeqCst), 0);
        d.stop().await;
    }
    #[test]
    fn the_wire_constants_are_pinned() {
        // A phone reads these from a desktop of another version. Changing one
        // breaks every paired phone in a way neither end can explain.
        assert_eq!(PAIR_ALPN, b"vibe/pair/1");
        assert_eq!(REMOTE_ALPN, b"vibe/remote/1");
        assert_eq!(NOT_PAIRED, 1);
    }

    #[test]
    fn the_status_shape_is_pinned() {
        let status = Status {
            endpoint_id: "id".into(),
            relays: vec![RelayInfo {
                url: "https://relay.example".into(),
                connected: false,
                error: None,
            }],
            links: vec![LinkInfo {
                id: "phone".into(),
                path: PathKind::Relay,
            }],
        };
        let json = serde_json::to_value(&status).expect("serialises");
        assert_eq!(
            json,
            serde_json::json!({
                "endpointId": "id",
                "relays": [{ "url": "https://relay.example", "connected": false, "error": null }],
                "links": [{ "id": "phone", "path": "relay" }],
            })
        );
    }
}
