//! The bridge: what a paired phone's connection on `vibe/remote/1` is for (#343).
//!
//! The phone opens one control stream and says `Hello`. The bridge answers
//! `Welcome` - or closes with `VERSION_MISMATCH`, naming both app versions -
//! and from then on:
//!
//! - **runs the phone's calls**, concurrently, each answered by a `Return`
//!   naming it, so a slow `pilot_models` never holds up a `host_send`. A
//!   command not on the allowed list is refused by name. An allowed one runs
//!   **through the same function its `#[tauri::command]` calls**, so a phone
//!   and the window cannot reach two implementations of one command;
//! - **sends it every event the window is sent**, through the hub (`hub.rs`),
//!   starting with the frames of every live run so far;
//! - **forgets the phone on `Unpair`**: the same removal a revoke from the
//!   desktop does, keyed by the endpoint id the handshake authenticated.
//!
//! ## Rust relays, and decides nothing
//!
//! The bridge reads three things off what it carries: the command name, the
//! invoke `id` (which `host.rs` already reads, unchanged), and `origin`. And it
//! writes one: on every line a phone sends through `host_send` or `host_start`,
//! the top-level `origin` becomes `phone:<phoneName>`, whatever the phone put
//! there, so a phone cannot say it is the desktop or another phone.
//! `host_start` is stamped as well because since #246 a run's `invoke` travels
//! as its `line`, and a run started from a phone has to say so.
//!
//! ## When the connection ends
//!
//! A revoke, an `Unpair`, or the phone going away all end the same way: every
//! task the bridge started for the connection is aborted. A call waiting on
//! the network stops there; one inside a single blocking step finishes that
//! step and its answer goes nowhere. Work a call had already started - a run
//! host, a pilot turn - goes on, exactly as it does when the window that
//! started it goes away, and the desktop window can still see and stop it.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use iroh::endpoint::{Connection, RecvStream, SendStream, VarInt};
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh::EndpointId;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use tokio::task::JoinSet;
use vibe_remote::control::{
    Event, Hello, Outcome, Return, ToDesktop, ToPhone, VersionMismatch, Welcome, ALLOWED_COMMANDS, CONTROL_MAX,
    ID_RANGE, REMOTE_PROTOCOL,
};
use vibe_remote::framing::{read_message, write_message};
use vibe_remote::VERSION_MISMATCH;

use super::endpoint::Live;
use super::hub::{Hub, Outgoing};
use super::store::Store;

/// A command's answer, as the shared function returned it.
pub(crate) type Answer<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

/// Where an allowed call is run. The app's is [`TauriCommands`]; the tests
/// record what reached it.
pub(crate) trait Commands: Send + Sync + 'static {
    fn call(&self, command: &str, args: Value, written: Written) -> Answer<'_>;
}

/// Resolves once a call's `Return` has reached the phone (#344): the peer
/// acknowledged every byte of the control stream, the connection closed, or
/// [`WRITTEN_CEILING`] passed. A command that is about to close this very
/// connection - a phone turning remote access off - holds it and stops the
/// endpoint only after it resolves, so the phone hears its answer first.
///
/// **Holding it ends the control stream** once the answer is written, because
/// nothing more will be sent on a connection about to close. Every other call
/// drops it, and the writer then carries on as before.
///
/// It names **who asked** (#346): the endpoint id the handshake authenticated
/// for the connection the call came in on, so the stop can close that phone by
/// id with `REMOTE_OFF` once its answer has arrived.
pub(crate) struct Written {
    pub(crate) reached: tokio::sync::oneshot::Receiver<()>,
    pub(crate) asker: EndpointId,
}

impl Written {
    pub(crate) fn new(reached: tokio::sync::oneshot::Receiver<()>, asker: EndpointId) -> Self {
        Written { reached, asker }
    }

    pub(crate) async fn wait(self) {
        let _ = self.reached.await;
    }
}

/// The longest a closing command waits for its answer to be acknowledged. Not
/// a measurement: iroh documents about 3s as how long closing takes on a poor
/// connection, and a phone that has stopped answering must not keep remote
/// access from turning off.
const WRITTEN_CEILING: std::time::Duration = std::time::Duration::from_secs(3);

/// How a phone that unpairs itself is removed.
pub(crate) trait Unpairer: Send + Sync + 'static {
    fn unpair(&self, id: &EndpointId) -> Result<(), String>;
}

/// The desktop revoke, exactly: off the paired list, then every connection the
/// phone has open closed with `NOT_PAIRED`.
pub(crate) struct StoreUnpair(pub(crate) Result<Store, String>, pub(crate) Live);

impl Unpairer for StoreUnpair {
    fn unpair(&self, id: &EndpointId) -> Result<(), String> {
        let store = self.0.as_ref().map_err(Clone::clone)?;
        super::revoke(store, &self.1, &id.to_string())
    }
}

/// The handler for `vibe/remote/1`, behind the endpoint's paired-only checks.
#[derive(Clone)]
pub(crate) struct Bridge {
    inner: Arc<Inner>,
}

struct Inner {
    commands: Arc<dyn Commands>,
    hub: Arc<Hub>,
    unpair: Arc<dyn Unpairer>,
    app_version: String,
    desktop_name: Option<String>,
}

impl fmt::Debug for Bridge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Bridge").field("app_version", &self.inner.app_version).finish()
    }
}

impl Bridge {
    pub(crate) fn new(
        commands: Arc<dyn Commands>,
        hub: Arc<Hub>,
        unpair: Arc<dyn Unpairer>,
        app_version: String,
        desktop_name: Option<String>,
    ) -> Self {
        Bridge { inner: Arc::new(Inner { commands, hub, unpair, app_version, desktop_name }) }
    }
}

impl ProtocolHandler for Bridge {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        serve(&self.inner, conn).await;
        Ok(())
    }
}

/// The ranges handed out since this process started; the window's is the one
/// below the first.
static NEXT_RANGE: AtomicU64 = AtomicU64::new(1);

/// The last range whose ids a JavaScript number can still hold exactly:
/// `8192 * 2^40 - 1` is `Number.MAX_SAFE_INTEGER`.
const LAST_RANGE: u64 = 8191;

/// A request-id base no connection has had before. Per connection, never per
/// phone: a reconnect restarts the phone's counter, so it needs a new range.
fn next_id_base() -> Option<u64> {
    let n = NEXT_RANGE.fetch_add(1, Ordering::SeqCst);
    (n <= LAST_RANGE).then(|| n * ID_RANGE)
}

/// At most `max` characters of `text`, cut on a character boundary.
fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

async fn read<T: DeserializeOwned>(conn: &Connection, recv: &mut RecvStream, what: &str) -> Option<Result<T, String>> {
    // `biased`: a connection that has been closed - a revoke, an Unpair -
    // reads nothing more, even with a message already waiting on the stream.
    tokio::select! {
        biased;
        _ = conn.closed() => None,
        read = read_message::<T>(recv, CONTROL_MAX, what) => Some(read),
    }
}

async fn serve(inner: &Inner, conn: Connection) {
    let who = conn.remote_id();
    let Ok((mut send, mut recv)) = conn.accept_bi().await else { return };

    let hello: Hello = match read(&conn, &mut recv, "hello").await {
        None => return,
        Some(Ok(hello)) => hello,
        Some(Err(why)) => {
            crate::applog::app(&format!("remote access: phone {who} sent no readable hello: {why}"));
            conn.close(VarInt::from_u32(0), b"unreadable hello");
            return;
        }
    };
    if hello.remote_protocol != REMOTE_PROTOCOL {
        let reason = VersionMismatch {
            desktop_app_version: inner.app_version.clone(),
            // A close reason has to fit one packet.
            phone_app_version: cut(&hello.app_version, 64),
        };
        crate::applog::app(&format!(
            "remote access: phone {who} speaks control protocol {}, this desktop {REMOTE_PROTOCOL}",
            hello.remote_protocol
        ));
        conn.close(VarInt::from_u32(VERSION_MISMATCH), &serde_json::to_vec(&reason).unwrap_or_default());
        return;
    }
    let Some(id_base) = next_id_base() else {
        conn.close(VarInt::from_u32(0), b"this desktop has handed out every request range; restart it");
        return;
    };

    // Joined before the Welcome is written, so anything emitted after the phone
    // reads its Welcome is already queued for it.
    let (tx, rx) = unbounded_channel();
    let phone = inner.hub.join(tx.clone());
    let welcome = Welcome {
        remote_protocol: REMOTE_PROTOCOL,
        app_version: inner.app_version.clone(),
        desktop_name: inner.desktop_name.clone(),
        id_base,
    };
    let mut tasks = JoinSet::new();
    if write_message(&mut send, &welcome).await.is_ok() {
        tasks.spawn(writer(conn.clone(), send, rx));
        loop {
            match read::<ToDesktop>(&conn, &mut recv, "control message").await {
                None => break,
                // A close the select had not seen yet: a call read after the
                // phone's access ended is never run.
                Some(Ok(ToDesktop::Call(_))) if conn.close_reason().is_some() => break,
                Some(Ok(ToDesktop::Call(call))) => {
                    let commands = inner.commands.clone();
                    let tx = tx.clone();
                    let name = hello.phone_name.clone();
                    let (reached, written) = tokio::sync::oneshot::channel();
                    tasks.spawn(async move {
                        let outcome = answer(&*commands, &call.command, call.args, &name, Written::new(written, who)).await;
                        let _ = tx.send(Outgoing::Return(Return { call: call.call, outcome }, Some(reached)));
                    });
                }
                // The connection's own id, which the handshake authenticated;
                // the message names none. A removal closes this connection,
                // and nothing after the Unpair is read: the phone's access
                // ends here, not when the close is next noticed.
                Some(Ok(ToDesktop::Unpair)) => match inner.unpair.unpair(&who) {
                    Ok(()) => break,
                    // Still paired, so the connection stays.
                    Err(why) => {
                        crate::applog::app(&format!("remote access: phone {who} asked to unpair and could not be: {why}"))
                    }
                },
                Some(Err(why)) => {
                    crate::applog::app(&format!("remote access: phone {who}: {why}"));
                    conn.close(VarInt::from_u32(0), b"unreadable control message");
                    break;
                }
            }
            // Finished calls are dropped as they go, so a long connection holds
            // only the calls still running.
            while tasks.try_join_next().is_some() {}
        }
    }

    inner.hub.leave(phone);
    drop(tx);
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}

/// The connection's one writer: everything queued for the phone, in order. A
/// stream that cannot be written closes the connection, so the reader stops
/// taking calls whose answers could never arrive.
async fn writer(conn: Connection, mut send: SendStream, mut rx: UnboundedReceiver<Outgoing>) {
    while let Some(out) = rx.recv().await {
        let mut waiting = None;
        let message = match out {
            Outgoing::Event { name, payload } => match RawValue::from_string(payload.to_string()) {
                Ok(payload) => ToPhone::Event(Event { name: name.into(), payload }),
                Err(_) => continue,
            },
            Outgoing::Return(ret, reached) => {
                waiting = reached.filter(|r| !r.is_closed());
                ToPhone::Return(ret)
            }
        };
        if let Err(why) = write_message(&mut send, &message).await {
            crate::applog::app(&format!("remote access: phone {}: {why}", conn.remote_id()));
            conn.close(VarInt::from_u32(0), b"the control stream could not be written");
            break;
        }
        // Somebody is about to close this connection and wants the phone to
        // have its answer first: finish the stream and wait for the peer to
        // acknowledge it, bounded.
        if let Some(reached) = waiting.take() {
            let _ = send.finish();
            tokio::select! {
                _ = send.stopped() => {}
                _ = conn.closed() => {}
                () = tokio::time::sleep(WRITTEN_CEILING) => {}
            }
            let _ = reached.send(());
            break;
        }
    }
}

/// Why a command is refused, in a sentence the phone can show.
fn refusal(command: &str) -> String {
    format!("{} is not a command a phone may call on this desktop", cut(command, 80))
}

async fn answer(commands: &dyn Commands, command: &str, args: Value, phone: &str, written: Written) -> Outcome {
    if !ALLOWED_COMMANDS.contains(&command) {
        return Outcome::Err(refusal(command));
    }
    match commands.call(command, stamp(command, args, phone), written).await {
        Ok(value) => Outcome::Ok(value),
        Err(why) => Outcome::Err(why),
    }
}

/// `readOrigin`'s bound in `src/host.ts`: a JavaScript string length, so UTF-16
/// units, checked after a trim.
const MAX_ORIGIN: usize = 40;

/// `phone:<name>`, cut on a character boundary to at most [`MAX_ORIGIN`] UTF-16
/// units. Never empty after a trim, because of the prefix.
pub(crate) fn origin_for(name: &str) -> String {
    let mut origin = String::from("phone:");
    let mut units = origin.encode_utf16().count();
    for c in name.chars() {
        if units + c.len_utf16() > MAX_ORIGIN {
            break;
        }
        units += c.len_utf16();
        origin.push(c);
    }
    origin
}

/// The one write: a phone's `host_send` or `host_start` line, when it is a JSON
/// object, gets `origin: phone:<name>` in place of whatever it carried.
/// Anything else is passed on unchanged, and the host refuses it as it would
/// from the window.
pub(crate) fn stamp(command: &str, mut args: Value, phone: &str) -> Value {
    if command != "host_send" && command != "host_start" {
        return args;
    }
    let Some(line) = args.get("line").and_then(Value::as_str) else { return args };
    let Ok(Value::Object(mut frame)) = serde_json::from_str::<Value>(line) else { return args };
    frame.insert("origin".into(), Value::String(origin_for(phone)));
    args["line"] = Value::String(Value::Object(frame).to_string());
    args
}

/// The app's commands, run through the functions their `#[tauri::command]`
/// wrappers call. Arguments arrive as the window sends them.
pub(crate) struct TauriCommands(pub(crate) AppHandle);

impl Commands for TauriCommands {
    fn call(&self, command: &str, args: Value, written: Written) -> Answer<'_> {
        let app = self.0.clone();
        let command = command.to_string();
        Box::pin(async move { run(app, &command, args, written).await })
    }
}

fn args_of<T: DeserializeOwned>(command: &str, args: Value) -> Result<T, String> {
    serde_json::from_value(args).map_err(|e| format!("the arguments to {command} could not be read: {e}"))
}

fn value_of<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

/// A synchronous command body, off the async runtime as Tauri runs it.
async fn blocking<T: Serialize + Send + 'static>(
    body: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(body).await.map_err(|e| e.to_string())?.and_then(value_of)
}

#[derive(Deserialize)]
struct Line {
    handle: String,
    line: String,
}

#[derive(Deserialize)]
struct Start {
    handle: Option<String>,
    line: Option<String>,
}

#[derive(Deserialize)]
struct KeySet {
    provider: crate::keys::Provider,
    key: String,
}

#[derive(Deserialize)]
struct ProviderArg {
    provider: crate::keys::Provider,
}

#[derive(Deserialize)]
struct TurnArg {
    turn: crate::pilot::request::Turn,
}

#[derive(Deserialize)]
struct TurnId {
    turn: u64,
}

#[derive(Deserialize)]
struct Quit {
    quit: bool,
}

#[derive(Deserialize)]
struct Install {
    page: bool,
    confirmed: bool,
}

#[derive(Deserialize)]
struct Yes {
    yes: bool,
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

#[derive(Deserialize)]
struct SetArgs {
    patch: super::settings::Patch,
}

/// A phone's `page` opens nothing on the desktop: the phone opens the release
/// page itself, from its own copy of the constant, on `openOnPhone`.
fn open_on_phone() -> Result<(), String> {
    Ok(())
}

async fn run(app: AppHandle, command: &str, args: Value, written: Written) -> Result<Value, String> {
    use crate::host::HostProcess;
    use super::Remote;
    match command {
        "host_start" => {
            let a: Start = args_of(command, args)?;
            blocking(move || crate::host::start_host(&app, a.handle, a.line)).await
        }
        "host_send" => {
            let a: Line = args_of(command, args)?;
            blocking(move || app.state::<HostProcess>().send(&a.handle, &a.line)).await
        }
        "host_status" => blocking(move || Ok(app.state::<HostProcess>().status())).await,
        // Neither answers with anything but success or a sentence: a key goes
        // into the keychain and never comes back out, on either road.
        "key_set" => {
            let a: KeySet = args_of(command, args)?;
            blocking(move || crate::keys::set_key(&app, a.provider, &a.key)).await
        }
        "key_clear" => {
            let a: ProviderArg = args_of(command, args)?;
            blocking(move || crate::keys::clear_key(&app, a.provider)).await
        }
        // Presence only, as it is for the window.
        "key_status" => blocking(|| Ok(crate::keys::status())).await,
        "pilot_send" => {
            let a: TurnArg = args_of(command, args)?;
            blocking(move || crate::pilot::send_turn(&app, &app.state::<crate::pilot::Pilot>(), a.turn)).await
        }
        "pilot_cancel" => {
            let a: TurnId = args_of(command, args)?;
            blocking(move || app.state::<crate::pilot::Pilot>().cancel(a.turn)).await
        }
        "pilot_turns" => blocking(move || app.state::<crate::pilot::Pilot>().turns()).await,
        "pilot_models" => {
            let a: ProviderArg = args_of(command, args)?;
            blocking(move || crate::pilot::models::list(a.provider)).await
        }
        "app_quit" => {
            let a: Quit = args_of(command, args)?;
            blocking(move || {
                crate::host::quit_app(&app, a.quit);
                Ok(())
            })
            .await
        }
        "update_check" => {
            let pending = app.state::<crate::update::Pending>();
            let found = crate::update::check(&app, &pending)
                .await
                .map_err(|()| "the update check failed".to_string())?;
            value_of(found)
        }
        "update_install" => {
            let a: Install = args_of(command, args)?;
            let pending = app.state::<crate::update::Pending>();
            match crate::update::install(&app, &pending, a.page, a.confirmed, open_on_phone).await? {
                crate::update::Outcome::Opened => Ok(Value::String("openOnPhone".into())),
                other => value_of(other),
            }
        }
        "remote_status" => blocking(move || Ok(super::status_now(&app, &app.state::<Remote>()))).await,
        "remote_pair_begin" => blocking(move || super::pair_begin(&app, &app.state::<Remote>())).await,
        "remote_pair_answer" => {
            let a: Yes = args_of(command, args)?;
            blocking(move || super::pair_answer(&app, &app.state::<Remote>(), a.yes)).await
        }
        "remote_revoke" => {
            let a: Id = args_of(command, args)?;
            blocking(move || super::revoke_phone(&app, &app.state::<Remote>(), &a.id)).await
        }
        // The one command that may close this very connection, so the one that
        // holds `written` (#344): a stop waits until this answer has arrived.
        "remote_set" => {
            let a: SetArgs = args_of(command, args)?;
            let remote = app.state::<Remote>();
            value_of(super::set_remote_from_phone(&app, &remote, a.patch, written).await?)
        }
        // Unreachable from a phone, which `answer` has already refused; said
        // rather than panicked, in case the allowed list grows without an arm.
        other => Err(refusal(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::endpoint::tests::{addr_of, key, phone, Count};
    use crate::remote::endpoint::{Config, Reach, RemoteEndpoint};
    use crate::remote::store::tests::Scratch;
    use crate::remote::store::Phone;
    use crate::remote::PairedList;
    use iroh::endpoint::{ApplicationClose, ConnectionError};
    use iroh::SecretKey;
    use serde_json::json;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::sync::Notify;
    use vibe_remote::control::{REFUSED_COMMANDS, REMOTE_PROTOCOL};
    use vibe_remote::{NOT_PAIRED, REMOTE_ALPN, REMOTE_OFF};

    /// Records every call that reaches it and echoes it back. `pilot_models`
    /// waits for `release`, which is how a test holds a call in flight.
    #[derive(Default)]
    struct Fake {
        seen: Mutex<Vec<(String, Value)>>,
        release: Notify,
        resumed: AtomicBool,
        /// Set by a test: `remote_set` closes these connections once written.
        closing: Mutex<Option<(Live, EndpointId)>>,
        order: Arc<Mutex<Vec<&'static str>>>,
    }

    impl Fake {
        fn seen(&self) -> Vec<(String, Value)> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl Commands for Fake {
        fn call(&self, command: &str, args: Value, written: Written) -> Answer<'_> {
            let command = command.to_string();
            Box::pin(async move {
                self.seen.lock().unwrap().push((command.clone(), args.clone()));
                // What `set_remote_from_phone` does when the patch turns remote
                // access off: answer now, close the connection once the
                // answer has reached the phone.
                if command == "remote_set" {
                    let closing = self.closing.lock().unwrap().clone();
                    if let Some((live, id)) = closing {
                        let order = self.order.clone();
                        tokio::spawn(async move {
                            written.wait().await;
                            order.lock().unwrap().push("written");
                            live.close_with(&id, REMOTE_OFF, b"remote access is off");
                        });
                    }
                }
                if command == "pilot_models" {
                    self.release.notified().await;
                    self.resumed.store(true, Ordering::SeqCst);
                }
                Ok(json!({ "command": command, "args": args }))
            })
        }
    }

    const PHONE_NAME: &str = "Pixel";

    struct World {
        desktop: RemoteEndpoint,
        live: Live,
        hub: Arc<Hub>,
        fake: Arc<Fake>,
        store: Store,
        phone_key: SecretKey,
        desktop_key: SecretKey,
        _dir: Scratch,
    }

    async fn world(tag: &str) -> World {
        let dir = Scratch::new(tag);
        let store = Store::in_dir(&dir.0);
        let phone_key = key();
        store
            .add(Phone { id: phone_key.public().to_string(), name: PHONE_NAME.into(), paired_at: 0, last_seen: None })
            .unwrap();
        let hub = Arc::new(Hub::default());
        // Announced through the hub, as the app's `start` wires it (#344).
        let announce = hub.clone();
        let live = Live::notifying(move || announce.event("remote://connections", Arc::from("null"), |_| {}));
        let fake = Arc::new(Fake::default());
        let bridge = Bridge::new(
            fake.clone(),
            hub.clone(),
            Arc::new(StoreUnpair(Ok(store.clone()), live.clone())),
            "1.7.0".into(),
            Some("desk".into()),
        );
        let desktop_key = key();
        let desktop = RemoteEndpoint::start_with(
            Config { key: desktop_key.clone(), reach: Reach::Loopback },
            // The real paired list, so a revoke and an Unpair are seen by the
            // next dial exactly as in the app.
            Arc::new(PairedList(Ok(store.clone()))),
            live.clone(),
            Count::default(),
            bridge,
        )
        .await
        .expect("a loopback endpoint starts");
        World { desktop, live, hub, fake, store, phone_key, desktop_key, _dir: dir }
    }

    struct TestPhone {
        /// Held so the phone's endpoint outlives the dial.
        _endpoint: iroh::Endpoint,
        conn: Connection,
        send: SendStream,
        recv: RecvStream,
    }

    fn hello(protocol: u32) -> Hello {
        Hello { remote_protocol: protocol, app_version: "9.9.9".into(), phone_name: PHONE_NAME.into() }
    }

    async fn dial(w: &World, hello: Hello) -> TestPhone {
        let p = phone(w.phone_key.clone()).await;
        let conn = p.connect(addr_of(&w.desktop), REMOTE_ALPN).await.expect("a paired phone connects");
        let (mut send, recv) = conn.open_bi().await.expect("a control stream");
        write_message(&mut send, &hello).await.expect("hello is written");
        TestPhone { _endpoint: p, conn, send, recv }
    }

    async fn welcomed(w: &World) -> (TestPhone, Welcome) {
        let mut phone = dial(w, hello(REMOTE_PROTOCOL)).await;
        let welcome: Welcome = within(read_message(&mut phone.recv, CONTROL_MAX, "welcome")).await.expect("a welcome");
        (phone, welcome)
    }

    async fn within<T>(fut: impl Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(10), fut).await.expect("in time")
    }

    impl TestPhone {
        async fn call(&mut self, call: u64, command: &str, args: Value) {
            let message = ToDesktop::Call(vibe_remote::control::Call { call, command: command.into(), args });
            write_message(&mut self.send, &message).await.expect("a call is written");
        }

        async fn next(&mut self) -> Value {
            within(read_message::<Value>(&mut self.recv, CONTROL_MAX, "message")).await.expect("readable")
        }

        async fn closed_with(&self) -> (u64, Vec<u8>) {
            match within(self.conn.closed()).await {
                ConnectionError::ApplicationClosed(ApplicationClose { error_code, reason }) => {
                    (error_code.into_inner(), reason.to_vec())
                }
                other => panic!("closed some other way: {other:?}"),
            }
        }
    }

    async fn until(what: &str, ready: impl Fn() -> bool) {
        for _ in 0..200 {
            if ready() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("{what} never happened");
    }

    #[tokio::test]
    async fn hello_welcome_then_a_call_returns_and_an_event_arrives() {
        let w = world("bridge-roundtrip").await;
        let (mut phone, welcome) = welcomed(&w).await;
        assert_eq!(welcome.remote_protocol, REMOTE_PROTOCOL);
        assert_eq!(welcome.app_version, "1.7.0");
        assert_eq!(welcome.desktop_name.as_deref(), Some("desk"));
        assert!(welcome.id_base > 0 && welcome.id_base % ID_RANGE == 0, "{}", welcome.id_base);

        phone.call(1, "host_status", json!({})).await;
        let ret = phone.next().await;
        assert_eq!(ret["type"], "return");
        assert_eq!(ret["call"], 1);
        assert_eq!(ret["ok"]["command"], "host_status");

        w.hub.event("pilot://event", Arc::from(r#"{"turn":4}"#), |_| {});
        let event = phone.next().await;
        assert_eq!(event, json!({ "type": "event", "name": "pilot://event", "payload": { "turn": 4 } }));
        // The pairing prompt's ending reaches the phone too, so its copy closes.
        w.hub.event("remote://pair-ended", Arc::from(r#"{"outcome":"paired"}"#), |_| {});
        let ended = phone.next().await;
        assert_eq!(ended["name"], "remote://pair-ended");
        assert_eq!(ended["payload"]["outcome"], "paired");

        // A slow call does not hold up the next one.
        phone.call(2, "pilot_models", json!({ "provider": "anthropic" })).await;
        phone.call(3, "host_send", json!({ "handle": "service", "line": "{}" })).await;
        let first = phone.next().await;
        assert_eq!(first["call"], 3, "the quick call answered while the slow one waits");
        w.fake.release.notify_one();
        let second = phone.next().await;
        assert_eq!(second["call"], 2);
        assert_eq!(second["ok"]["command"], "pilot_models");
        w.desktop.stop().await;
    }

    #[tokio::test]
    async fn a_protocol_mismatch_closes_with_both_versions() {
        let w = world("bridge-mismatch").await;
        let phone = dial(&w, hello(REMOTE_PROTOCOL + 98)).await;
        let (code, reason) = phone.closed_with().await;
        assert_eq!(code, VERSION_MISMATCH as u64);
        let versions: VersionMismatch = serde_json::from_slice(&reason).expect("the reason names both versions");
        assert_eq!(
            versions,
            VersionMismatch { desktop_app_version: "1.7.0".into(), phone_app_version: "9.9.9".into() }
        );
        assert!(w.fake.seen().is_empty());
        w.desktop.stop().await;
    }

    #[tokio::test]
    async fn a_command_not_on_the_list_is_refused_by_name() {
        let w = world("bridge-refused").await;
        let (mut phone, _) = welcomed(&w).await;
        phone.call(9, "remote_identity", json!({})).await;
        let ret = phone.next().await;
        assert_eq!(ret["call"], 9);
        let why = ret["err"].as_str().expect("refused with a sentence");
        assert_eq!(why, "remote_identity is not a command a phone may call on this desktop");
        assert!(w.fake.seen().is_empty(), "the refused command never ran");
        w.desktop.stop().await;
    }

    #[tokio::test]
    async fn two_connections_get_disjoint_id_ranges() {
        let w = world("bridge-ranges").await;
        let (_a, first) = welcomed(&w).await;
        let (_b, second) = welcomed(&w).await;
        assert_ne!(first.id_base, second.id_base);
        for base in [first.id_base, second.id_base] {
            assert!(base > 0 && base % ID_RANGE == 0);
        }
        w.desktop.stop().await;
    }

    #[tokio::test]
    async fn a_phone_cannot_claim_to_be_the_desktop() {
        let w = world("bridge-origin").await;
        let (mut phone, _) = welcomed(&w).await;
        let line = r#"{"type":"answer","id":3,"origin":"desktop","decision":"continue"}"#;
        phone.call(1, "host_send", json!({ "handle": "run-1", "line": line })).await;
        phone.call(2, "host_start", json!({ "handle": "run-2", "line": r#"{"type":"invoke","id":4,"origin":"desktop"}"# })).await;
        phone.next().await;
        phone.next().await;
        let seen = w.fake.seen();
        assert_eq!(seen.len(), 2);
        for (_, args) in &seen {
            let frame: Value = serde_json::from_str(args["line"].as_str().unwrap()).unwrap();
            assert_eq!(frame["origin"], "phone:Pixel");
        }
        let sent: Value = serde_json::from_str(seen.iter().find(|(c, _)| c == "host_send").unwrap().1["line"].as_str().unwrap()).unwrap();
        assert_eq!(sent["id"], 3, "nothing else in the frame moved");
        assert_eq!(sent["decision"], "continue");
        w.desktop.stop().await;
    }

    /// The JavaScript length `readOrigin` checks, after its trim.
    fn js_len(s: &str) -> usize {
        s.trim().encode_utf16().count()
    }

    #[test]
    fn origin_for_fits_read_origin_on_a_character_boundary() {
        assert_eq!(origin_for("Pixel"), "phone:Pixel");
        let long = origin_for(&"a".repeat(60));
        assert_eq!(js_len(&long), 40);
        assert!(long.starts_with("phone:aaaa"));
        // Surrogate pairs count two units each, and are never split.
        let emoji = origin_for(&"📱".repeat(30));
        assert!(js_len(&emoji) <= 40);
        assert_eq!(emoji.chars().filter(|c| *c == '📱').count(), 17, "6 + 17 * 2 = 40 units");
        // A name of spaces still leaves an origin after the trim.
        assert_eq!(origin_for("      ").trim(), "phone:");
        assert!(js_len(&origin_for("")) > 0);
    }

    #[test]
    fn only_a_json_object_line_is_stamped_and_only_on_the_two_host_commands() {
        let args = json!({ "handle": "service", "line": "not json" });
        assert_eq!(stamp("host_send", args.clone(), "P"), args);
        let args = json!({ "handle": "service", "line": "[1,2]" });
        assert_eq!(stamp("host_send", args.clone(), "P"), args);
        let args = json!({ "handle": null, "line": null });
        assert_eq!(stamp("host_start", args.clone(), "P"), args);
        let args = json!({ "line": r#"{"origin":"desktop"}"# });
        assert_eq!(stamp("pilot_send", args.clone(), "P"), args, "only host lines carry an origin");
    }

    #[tokio::test]
    async fn a_phone_joining_mid_run_gets_the_buffer_then_the_live_stream() {
        let w = world("bridge-buffer").await;
        let frame = |host: &str, n: u32| Arc::<str>::from(format!(r#"{{"host":"{host}","frame":{{"n":{n}}}}}"#));
        // Two run hosts interleaved, with service frames between them.
        let before = [("run-a", 1), ("run-b", 2), ("service", 3), ("run-a", 4), ("run-b", 5), ("service", 6)];
        for (host, n) in before {
            w.hub.frame(host, frame(host, n), |_| {});
        }
        let (mut phone, _) = welcomed(&w).await;
        let after = [("service", 7), ("run-a", 8), ("run-b", 9)];
        for (host, n) in after {
            w.hub.frame(host, frame(host, n), |_| {});
        }
        let mut got = Vec::new();
        for _ in 0..7 {
            let event = phone.next().await;
            assert_eq!(event["name"], "host://frame");
            got.push(event["payload"]["frame"]["n"].as_u64().unwrap());
        }
        // The kept run frames in emission order, then every live frame.
        assert_eq!(got, [1, 2, 4, 5, 7, 8, 9]);
        w.desktop.stop().await;
    }

    #[tokio::test]
    async fn a_revoke_closes_a_bridged_connection_and_its_tasks_end() {
        let w = world("bridge-revoke").await;
        let (mut phone, _) = welcomed(&w).await;
        assert_eq!(w.hub.phone_count(), 1);
        phone.call(1, "pilot_models", json!({ "provider": "openai" })).await;
        until("the slow call reaches the commands", || !w.fake.seen().is_empty()).await;

        let id = w.phone_key.public().to_string();
        super::super::revoke(&w.store, &w.live, &id).unwrap();

        let (code, _) = phone.closed_with().await;
        assert_eq!(code, NOT_PAIRED as u64);
        until("the phone leaves the hub", || w.hub.phone_count() == 0).await;
        // Every task the bridge started held the commands; they are all gone.
        until("the connection's tasks end", || Arc::strong_count(&w.fake) == 2).await;
        w.fake.release.notify_one();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!w.fake.resumed.load(Ordering::SeqCst), "the call in flight was cancelled, not finished");
        w.desktop.stop().await;
    }

    /// A control stream the desktop can no longer write closes the connection
    /// and leaves the hub, rather than taking calls whose answers go nowhere.
    #[tokio::test]
    async fn a_control_stream_that_cannot_be_written_closes_the_connection() {
        let w = world("bridge-writer-fails").await;
        let (mut phone, _) = welcomed(&w).await;
        phone.recv.stop(VarInt::from_u32(7)).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        w.hub.event("pilot://event", Arc::from(r#"{"turn":1}"#), |_| {});
        let (code, reason) = phone.closed_with().await;
        assert_eq!(code, 0);
        assert_eq!(reason, b"the control stream could not be written");
        until("the phone leaves the hub", || w.hub.phone_count() == 0).await;
        w.desktop.stop().await;
    }

    /// A call sent right behind an Unpair is never run: the phone's access
    /// ends at the Unpair.
    #[tokio::test]
    async fn nothing_after_an_unpair_is_run() {
        let w = world("bridge-unpair-then-call").await;
        let (mut phone, _) = welcomed(&w).await;
        let mut bytes = vibe_remote::framing::encode(&ToDesktop::Unpair).unwrap();
        bytes.extend(
            vibe_remote::framing::encode(&ToDesktop::Call(vibe_remote::control::Call {
                call: 1,
                command: "host_status".into(),
                args: json!({}),
            }))
            .unwrap(),
        );
        phone.send.write_all(&bytes).await.unwrap();
        let (code, _) = phone.closed_with().await;
        assert_eq!(code, NOT_PAIRED as u64);
        until("the phone leaves the hub", || w.hub.phone_count() == 0).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(w.fake.seen().is_empty(), "the call behind the Unpair ran: {:?}", w.fake.seen());
        w.desktop.stop().await;
    }

    #[tokio::test]
    async fn unpair_removes_the_phone_and_closes_it() {
        let w = world("bridge-unpair").await;
        let (mut phone, _) = welcomed(&w).await;
        write_message(&mut phone.send, &ToDesktop::Unpair).await.unwrap();

        let (code, _) = phone.closed_with().await;
        assert_eq!(code, NOT_PAIRED as u64);
        let id = w.phone_key.public().to_string();
        assert!(w.store.load().unwrap().iter().all(|p| p.id != id), "off the paired list");
        until("the phone leaves the hub", || w.hub.phone_count() == 0).await;

        // And the next dial is refused before any stream.
        let p = super::super::endpoint::tests::phone(w.phone_key.clone()).await;
        let again = super::super::endpoint::tests::closing_code(&p, addr_of(&w.desktop), REMOTE_ALPN).await;
        assert_eq!(again, Some(NOT_PAIRED as u64));
        w.desktop.stop().await;
    }

    /// The command names a `generate_handler!` list registers.
    #[tokio::test]
    async fn a_phone_turning_remote_access_off_reads_its_return_before_the_close() {
        let w = world("bridge-off-written").await;
        let (mut phone, _) = welcomed(&w).await;
        *w.fake.closing.lock().unwrap() = Some((w.live.clone(), w.phone_key.public()));

        phone.call(4, "remote_set", json!({ "patch": { "enabled": false } })).await;
        let answer = phone.next().await;
        assert_eq!(answer["type"], "return", "{answer}");
        assert_eq!(answer["call"], 4);
        // Only now does the desktop close it - once the answer was acknowledged -
        // and with REMOTE_OFF, so the phone says why (#346).
        let (code, _) = phone.closed_with().await;
        assert_eq!(code, REMOTE_OFF as u64);
        assert_eq!(*w.fake.order.lock().unwrap(), ["written"]);
        w.desktop.stop().await;
    }

    #[tokio::test]
    async fn a_call_that_closes_nothing_leaves_the_stream_open() {
        let w = world("bridge-not-closing").await;
        let (mut phone, _) = welcomed(&w).await;
        // No `closing` set: the command drops its `Written`, as every command
        // that does not close the connection does.
        phone.call(1, "remote_set", json!({ "patch": { "keepAwake": true } })).await;
        assert_eq!(phone.next().await["call"], 1);
        phone.call(2, "host_status", json!({})).await;
        assert_eq!(phone.next().await["call"], 2, "the stream carries on");
        w.desktop.stop().await;
    }

    #[tokio::test]
    async fn a_phone_already_joined_hears_a_second_phone_connect() {
        let w = world("bridge-connections").await;
        let second = key();
        w.store
            .add(Phone { id: second.public().to_string(), name: "Tablet".into(), paired_at: 0, last_seen: None })
            .unwrap();
        let (mut first, _) = welcomed(&w).await;

        let p = phone(second).await;
        let conn = p.connect(addr_of(&w.desktop), REMOTE_ALPN).await.expect("the second phone connects");
        let event = first.next().await;
        assert_eq!(event["type"], "event", "{event}");
        assert_eq!(event["name"], "remote://connections");
        assert_eq!(event["payload"], Value::Null, "it carries nothing");

        conn.close(0u32.into(), b"bye");
        let event = first.next().await;
        assert_eq!(event["name"], "remote://connections", "and again when it goes");
        w.desktop.stop().await;
    }

    /// The phone's real client (`vibe_remote::client`) against this real
    /// bridge, in one process (#346).
    mod client {
        use super::*;
        use crate::remote::endpoint::tests::{phone_finding, settle};
        use iroh::address_lookup::memory::MemoryLookup;
        use vibe_remote::client::{self as phone_client, Client, Net, NetReader, Reason, Session, Timeouts, Unpaired};
        use vibe_remote::paired::{DesktopEntry, PairedList as PhoneList};

        fn online() -> NetReader {
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

        fn hello_at(version: &str) -> Hello {
            Hello { remote_protocol: REMOTE_PROTOCOL, app_version: version.into(), phone_name: PHONE_NAME.into() }
        }

        struct PhoneSide {
            client: Client,
            list: PhoneList,
            lookup: MemoryLookup,
            entry: DesktopEntry,
            _dir: Scratch,
        }

        async fn phone_of(w: &World, key: SecretKey, tag: &str, timeouts: Timeouts, net: NetReader) -> PhoneSide {
            let (ep, lookup) = phone_finding(key).await;
            lookup.add_endpoint_info(addr_of(&w.desktop));
            let dir = Scratch::new(tag);
            let list = PhoneList::in_dir(&dir.0);
            let entry = DesktopEntry {
                id: w.desktop.id().to_string(),
                relay: None,
                desktop_name: Some("desk".into()),
                name: None,
                paired_at: 0,
                last_seen: None,
            };
            list.add(entry.clone()).unwrap();
            list.set_current(Some(&entry.id)).unwrap();
            PhoneSide { client: Client::new(ep, net, timeouts), list, lookup, entry, _dir: dir }
        }

        async fn connected(w: &World, tag: &str) -> (PhoneSide, Session) {
            let p = phone_of(w, w.phone_key.clone(), tag, quick(), online()).await;
            let session = phone_client::connect(&p.client, &p.entry, hello_at("1.7.0")).await.expect("welcomed");
            (p, session)
        }

        async fn ended(session: &Session) -> Reason {
            within(session.closed()).await.reason
        }

        #[tokio::test]
        async fn hello_welcome_a_call_returns_and_an_event_arrives() {
            let w = world("cl-bridge-roundtrip").await;
            let (_p, session) = connected(&w, "cl-bridge-roundtrip-phone").await;
            let welcome = session.welcome();
            assert!(welcome.id_base > 0 && welcome.id_base % ID_RANGE == 0, "{}", welcome.id_base);
            assert_eq!(welcome.app_version, "1.7.0", "the desktop's own version is welcomed");
            let answer = session.call("host_status", json!({ "n": 1 })).await.expect("answered");
            assert_eq!(answer, json!({ "command": "host_status", "args": { "n": 1 } }));

            let mut events = session.events().expect("events");
            w.hub.event("pilot://event", Arc::from(r#"{"turn":4}"#), |_| {});
            let event = within(events.recv()).await.expect("an event");
            assert_eq!(event.name, "pilot://event");
            assert_eq!(event.payload.get(), r#"{"turn":4}"#);
            w.desktop.stop().await;
        }

        #[tokio::test]
        async fn two_clients_never_take_each_other_s_answers() {
            let w = world("cl-bridge-two").await;
            let second = key();
            w.store
                .add(Phone { id: second.public().to_string(), name: "Tablet".into(), paired_at: 0, last_seen: None })
                .unwrap();
            let (_a, first) = connected(&w, "cl-bridge-two-a").await;
            let b = phone_of(&w, second, "cl-bridge-two-b", quick(), online()).await;
            let other = phone_client::connect(&b.client, &b.entry, hello_at("1.7.0")).await.expect("welcomed");
            assert_ne!(first.welcome().id_base, other.welcome().id_base);

            // Both count their calls from 1, so the ids collide on the wire;
            // each answer still reaches only its own connection.
            let calls = (0..5).map(|n| {
                let (a, b) = (&first, &other);
                async move {
                    let (x, y) = tokio::join!(
                        a.call("host_status", json!({ "from": "a", "n": n })),
                        b.call("host_status", json!({ "from": "b", "n": n }))
                    );
                    (x.unwrap(), y.unwrap())
                }
            });
            for (n, (x, y)) in futures_join_all(calls).await.into_iter().enumerate() {
                assert_eq!(x["args"], json!({ "from": "a", "n": n }));
                assert_eq!(y["args"], json!({ "from": "b", "n": n }));
            }
            w.desktop.stop().await;
        }

        async fn futures_join_all<F: Future>(futs: impl Iterator<Item = F>) -> Vec<F::Output> {
            let mut out = Vec::new();
            for f in futs {
                out.push(f.await);
            }
            out
        }

        #[tokio::test]
        async fn a_mismatch_names_both_versions() {
            let w = world("cl-bridge-mismatch").await;
            let p = phone_of(&w, w.phone_key.clone(), "cl-bridge-mismatch-phone", quick(), online()).await;
            let mut hello = hello_at("9.9.9");
            hello.remote_protocol += 98;
            let got = phone_client::connect(&p.client, &p.entry, hello).await;
            assert_eq!(
                got.err(),
                Some(Reason::VersionMismatch { desktop_app_version: Some("1.7.0".into()), phone_app_version: "9.9.9".into() })
            );
            w.desktop.stop().await;
        }

        #[tokio::test]
        async fn a_revoke_reads_as_not_paired() {
            let w = world("cl-bridge-revoke").await;
            let (_p, session) = connected(&w, "cl-bridge-revoke-phone").await;
            super::super::super::revoke(&w.store, &w.live, &w.phone_key.public().to_string()).unwrap();
            assert_eq!(ended(&session).await, Reason::NotPaired);
            w.desktop.stop().await;
        }

        #[tokio::test]
        async fn remote_access_off_reads_as_remote_off() {
            let w = world("cl-bridge-off").await;
            let (_p, session) = connected(&w, "cl-bridge-off-phone").await;
            w.live.close_all(REMOTE_OFF, b"remote access is off");
            assert_eq!(ended(&session).await, Reason::RemoteOff);
            w.desktop.stop().await;
        }

        #[tokio::test]
        async fn a_stopped_desktop_or_a_code_zero_close_reads_as_unreachable() {
            let w = world("cl-bridge-stopped").await;
            let (_p, session) = connected(&w, "cl-bridge-stopped-phone").await;
            w.live.close_with(&w.phone_key.public(), 0, b"bye");
            assert_eq!(ended(&session).await, Reason::Unreachable, "code 0");

            let (_q, session) = connected(&w, "cl-bridge-stopped-phone-2").await;
            let gone = phone_of(&w, w.phone_key.clone(), "cl-bridge-stopped-phone-3", Timeouts { dial: Duration::from_millis(500), ..quick() }, online()).await;
            w.desktop.stop().await;
            assert_eq!(ended(&session).await, Reason::Unreachable, "the endpoint stopped");

            // And dialling a stopped desktop is unreachable too.
            assert_eq!(phone_client::connect(&gone.client, &gone.entry, hello_at("1.7.0")).await.err(), Some(Reason::Unreachable));
        }

        /// A direct path that ends is never blamed on the relays, however they
        /// are doing.
        #[tokio::test]
        async fn a_direct_session_ending_with_every_relay_failed_is_unreachable() {
            let w = world("cl-bridge-direct").await;
            let failing: NetReader = Arc::new(|| {
                let url: iroh::RelayUrl = "https://use1-1.relay.n0.iroh.link./".parse().unwrap();
                Net {
                    online: true,
                    relays: vec![vibe_remote::client::RelaySeen { url: url.clone(), state: vibe_remote::client::RelayLink::Failed }],
                    phone_relays: vec![url],
                }
            });
            let p = phone_of(&w, w.phone_key.clone(), "cl-bridge-direct-phone", quick(), failing).await;
            let session = phone_client::connect(&p.client, &p.entry, hello_at("1.7.0")).await.expect("welcomed");
            assert_eq!(session.path(), vibe_remote::client::PathKind::Direct);
            w.live.close_with(&w.phone_key.public(), 0, b"bye");
            assert_eq!(ended(&session).await, Reason::Unreachable);
            w.desktop.stop().await;
        }

        /// A desktop that accepts and never answers the Hello.
        #[tokio::test]
        async fn a_stalled_peer_is_unreachable_within_a_second() {
            let w = world("cl-bridge-stall").await;
            let stalled = RemoteEndpoint::start(
                Config { key: key(), reach: Reach::Loopback },
                Arc::new(PairedList(Ok(w.store.clone()))),
                Count::default(),
                Count::default(),
            )
            .await
            .expect("a stalled desktop starts");
            let (ep, lookup) = phone_finding(w.phone_key.clone()).await;
            lookup.add_endpoint_info(addr_of(&stalled));
            let client = Client::new(ep, online(), Timeouts { dial: Duration::from_millis(200), ..quick() });
            let entry = DesktopEntry { id: stalled.id().to_string(), relay: None, desktop_name: None, name: None, paired_at: 0, last_seen: None };
            let started = std::time::Instant::now();
            let got = phone_client::connect(&client, &entry, hello_at("1.7.0")).await;
            assert_eq!(got.err(), Some(Reason::Unreachable));
            assert!(started.elapsed() < Duration::from_secs(1), "took {:?}", started.elapsed());
            stalled.stop().await;
            w.desktop.stop().await;
        }

        #[tokio::test]
        async fn unpairing_a_reachable_desktop_tells_it_and_both_forget() {
            let w = world("cl-bridge-unpair").await;
            let (p, session) = connected(&w, "cl-bridge-unpair-phone").await;
            let got = phone_client::unpair(&p.client, &p.list, &p.entry, Some(&session), hello_at("1.7.0")).await;
            assert_eq!(got, Ok(Unpaired::Sent));
            assert!(p.list.read().unwrap().desktops.is_empty());
            let id = w.phone_key.public().to_string();
            assert!(w.store.load().unwrap().iter().all(|p| p.id != id), "the desktop forgot the phone");
            w.desktop.stop().await;
        }

        #[tokio::test]
        async fn unpairing_without_a_session_dials_and_tells_it() {
            let w = world("cl-bridge-unpair-dial").await;
            let mut p = phone_of(&w, w.phone_key.clone(), "cl-bridge-unpair-dial-phone", quick(), online()).await;
            // A stale hint: reached only by the lookup.
            p.entry.relay = Some("https://stale.relay.example./".into());
            let got = phone_client::unpair(&p.client, &p.list, &p.entry, None, hello_at("1.7.0")).await;
            assert_eq!(got, Ok(Unpaired::Sent));
            let id = w.phone_key.public().to_string();
            until("the desktop forgets the phone", || w.store.load().unwrap().iter().all(|p| p.id != id)).await;
            assert!(p.list.read().unwrap().desktops.is_empty());
            w.desktop.stop().await;
        }

        #[tokio::test]
        async fn unpairing_a_stopped_desktop_only_forgets_it_here() {
            let w = world("cl-bridge-unpair-stopped").await;
            let p = phone_of(&w, w.phone_key.clone(), "cl-bridge-unpair-stopped-phone", quick(), online()).await;
            w.desktop.stop().await;
            let got = phone_client::unpair(&p.client, &p.list, &p.entry, None, hello_at("1.7.0")).await;
            assert_eq!(got, Ok(Unpaired::Unreachable));
            let file = p.list.read().unwrap();
            assert!(file.desktops.is_empty());
            assert_eq!(file.current, None, "current is cleared with it");
        }

        #[tokio::test]
        async fn a_rename_is_the_phone_s_own_and_sends_nothing() {
            let w = world("cl-bridge-rename").await;
            let (p, _session) = connected(&w, "cl-bridge-rename-phone").await;
            p.list.rename(&p.entry.id, Some("Studio")).unwrap();
            settle().await;
            assert!(w.fake.seen().is_empty(), "no call reached the desktop");
            assert_eq!(w.store.load().unwrap().len(), 1, "the desktop's list is as it was");
            assert_eq!(p.list.get(&p.entry.id).unwrap().unwrap().name.as_deref(), Some("Studio"));
            w.desktop.stop().await;
        }

        #[tokio::test]
        async fn a_stale_hint_reconnects_by_lookup_and_the_hint_is_replaced() {
            let w = world("cl-bridge-stale").await;
            let mut p = phone_of(&w, w.phone_key.clone(), "cl-bridge-stale-phone", quick(), online()).await;
            p.entry.relay = Some("https://stale.relay.example./".into());
            p.list.add(p.entry.clone()).unwrap();
            let session = phone_client::connect(&p.client, &p.entry, hello_at("1.7.0")).await.expect("reached by id");
            // What the phone's link does on a Welcome: keep the relay it saw.
            p.list.set_relay(&p.entry.id, session.relay()).unwrap();
            assert_eq!(p.list.get(&p.entry.id).unwrap().unwrap().relay, None, "a loopback desktop has no relay");
            drop(session);
            w.desktop.stop().await;
        }

        #[tokio::test]
        async fn a_desktop_restarted_on_a_new_address_is_reached() {
            let w = world("cl-bridge-restart").await;
            let p = phone_of(&w, w.phone_key.clone(), "cl-bridge-restart-phone", quick(), online()).await;
            let session = phone_client::connect(&p.client, &p.entry, hello_at("1.7.0")).await.expect("welcomed");
            w.desktop.stop().await;
            assert_eq!(ended(&session).await, Reason::Unreachable);

            let bridge = Bridge::new(
                w.fake.clone(),
                w.hub.clone(),
                Arc::new(StoreUnpair(Ok(w.store.clone()), w.live.clone())),
                "1.7.0".into(),
                Some("desk".into()),
            );
            let again = RemoteEndpoint::start_with(
                Config { key: w.desktop_key.clone(), reach: Reach::Loopback },
                Arc::new(PairedList(Ok(w.store.clone()))),
                w.live.clone(),
                Count::default(),
                bridge,
            )
            .await
            .expect("the desktop comes back");
            p.lookup.add_endpoint_info(addr_of(&again));
            let back = phone_client::connect(&p.client, &p.entry, hello_at("1.7.0")).await.expect("reached again, same key");
            assert_eq!(back.call("host_status", json!({})).await.unwrap()["command"], "host_status");
            again.stop().await;
        }
    }

    fn registered_in(lib: &str) -> Vec<String> {
        let start = lib.find("generate_handler![").expect("lib.rs registers commands") + "generate_handler![".len();
        let body = &lib[start..start + lib[start..].find(']').expect("a closed list")];
        body.lines()
            .map(|line| line.split("//").next().unwrap_or(""))
            .flat_map(|line| line.split(|c: char| !(c.is_alphanumeric() || c == '_')))
            .filter(|w| !w.is_empty())
            .map(str::to_string)
            .collect()
    }

    /// Every way the list and the handler disagree, each naming the command.
    fn disagreements(registered: &[String]) -> Vec<String> {
        let mut found = Vec::new();
        for command in registered {
            if !ALLOWED_COMMANDS.contains(&command.as_str()) && !REFUSED_COMMANDS.contains(&command.as_str()) {
                found.push(format!(
                    "{command} is registered in generate_handler! with no remote decision: add it to \
                     ALLOWED_COMMANDS or REFUSED_COMMANDS in app/remote/src/control.rs"
                ));
            }
        }
        for command in ALLOWED_COMMANDS {
            if !registered.iter().any(|r| r == command) {
                found.push(format!("{command} is allowed but the desktop registers no such command"));
            }
        }
        found
    }

    #[test]
    fn every_window_command_has_a_remote_decision() {
        let registered = registered_in(include_str!("../lib.rs"));
        assert!(registered.len() >= 16, "read only {registered:?}; the parse is broken");
        let found = disagreements(&registered);
        assert!(found.is_empty(), "{}", found.join("\n"));
    }

    /// The check above, against a handler list that grew a command nobody
    /// decided about - which is what a real new command looks like to it.
    #[test]
    fn a_new_command_with_no_decision_fails_by_name() {
        // `remote_set` was this example until #344 decided it; the name is now
        // one no command has.
        let lib = include_str!("../lib.rs").replacen("            remote_set\n", "            remote_set,\n            remote_teleport\n", 1);
        let found = disagreements(&registered_in(&lib));
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].starts_with("remote_teleport is registered in generate_handler! with no remote decision"));
    }

    #[test]
    fn every_allowed_command_has_an_arm() {
        let source = include_str!("bridge.rs");
        let production = &source[..source.find("#[cfg(test)]\nmod tests").expect("a test module")];
        for command in ALLOWED_COMMANDS {
            assert!(production.contains(&format!("\"{command}\" =>")), "{command} is allowed and has no arm in `run`");
        }
    }
}
