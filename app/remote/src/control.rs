//! The control stream on `vibe/remote/1` (#343): what a paired phone and the
//! desktop say to each other once the phone is connected.
//!
//! ```text
//! phone → desktop   Hello   { remoteProtocol, appVersion, phoneName }
//! desktop → phone   Welcome { remoteProtocol, appVersion, desktopName, idBase }
//!                   or a close with VERSION_MISMATCH carrying both versions
//! phone → desktop   Call    { call, command, args }        an invoke
//! phone → desktop   Unpair                                 forget this phone
//! desktop → phone   Return  { call, ok | err }             its answer
//! desktop → phone   Event   { name, payload }              an emit
//! ```
//!
//! One stream, opened by the phone. Calls are concurrent and each `Return`
//! names its call; events are in the order the desktop emitted them. Every
//! message is framed by [`crate::framing`] under [`CONTROL_MAX`].
//!
//! The desktop's side is `app/src-tauri/src/remote/bridge.rs`; the phone's is
//! #346, which uses these types and nothing of its own.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;

/// This wire's version. A `Hello` carrying any other number is closed with
/// [`crate::VERSION_MISMATCH`].
///
/// **It also moves whenever the host's `PROTOCOL_VERSION` does**, because the
/// phone's webview folds the desktop's host frames through the same `reduce`
/// the window does: a phone built against another frame protocol would draw
/// the wrong run, silently. [`HOST_PROTOCOL`] and the test below hold the two
/// together.
pub const REMOTE_PROTOCOL: u32 = 1;

/// The host frame protocol (`PROTOCOL_VERSION` in `src/protocol.ts`) this wire
/// was cut against. A test reads the core's source and fails when they differ.
pub const HOST_PROTOCOL: u32 = 2;

/// The bound on every control message, in both directions: the most a `u32`
/// length can say. Deliberately not smaller, for three reasons:
///
/// 1. **Host frames are uncapped.** `model_said` carries whatever the model
///    wrote, and `host.rs` reads host stdout with an unbounded `.lines()`. A
///    smaller cap would drop a real frame, and a dropped frame breaks the
///    live-run buffer's rule of no gap.
/// 2. **Pilot conversations and chat saves grow without bound.** `pilot_send`'s
///    turn carries the conversation, and so does a chat save through
///    `host_send`. One chat was 2.16 MB on the day `localStorage` failed; that
///    is a measurement of one day, not a ceiling, so no limit follows from it.
/// 3. **The desktop window's own IPC has no cap**, and under full parity a
///    phone gets none either.
///
/// This guards against a **buggy** paired peer, not a hostile one: a hostile
/// paired phone already has full parity, and revoking it is the answer. What
/// makes the size safe to allow is that a read grows with the bytes that
/// arrive, never with the length that was claimed (see `framing.rs`).
pub const CONTROL_MAX: usize = u32::MAX as usize;

/// The size of each client's range of request ids. A phone connection's
/// `idBase` is a multiple of it, and the window counts from 1, below the first.
pub const ID_RANGE: u64 = 1 << 40;

/// The phone's first message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub remote_protocol: u32,
    pub app_version: String,
    /// What the desktop stamps on the phone's frames as `phone:<phoneName>`.
    pub phone_name: String,
}

/// The desktop's answer to a `Hello` it accepts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Welcome {
    pub remote_protocol: u32,
    pub app_version: String,
    /// The machine's name, or null when it could not be read. Never invented.
    pub desktop_name: Option<String>,
    /// Where this connection's request ids start: a multiple of [`ID_RANGE`]
    /// the desktop has not handed out since it started. Per connection, never
    /// per phone, because a reconnect restarts the phone's counter.
    pub id_base: u64,
}

/// The reason a [`crate::VERSION_MISMATCH`] close carries, as JSON, so the
/// phone can say which of the two apps to update.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMismatch {
    pub desktop_app_version: String,
    pub phone_app_version: String,
}

/// One desktop command, by the name the window invokes it under, with the
/// window's own arguments.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Call {
    /// The phone's id for this call; its `Return` carries it back.
    pub call: u64,
    pub command: String,
    pub args: Value,
}

/// What a phone sends after its `Hello`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ToDesktop {
    Call(Call),
    /// Forget this phone. The desktop removes **the connection's authenticated
    /// endpoint id** - never an id a message names, so this one carries none -
    /// exactly as a revoke from the desktop does, and closes its connections
    /// with [`crate::NOT_PAIRED`].
    Unpair,
}

/// A command's answer, or its refusal as a sentence the phone can show.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Ok(Value),
    Err(String),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Return {
    pub call: u64,
    #[serde(flatten)]
    pub outcome: Outcome,
}

/// An event the desktop emitted, under its own name, with its payload as the
/// bytes the desktop serialised - carried, never parsed.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub name: String,
    pub payload: Box<RawValue>,
}

/// What the desktop sends after its `Welcome`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ToPhone {
    Return(Return),
    Event(Event),
}

/// The desktop commands a phone may call: the window's whole surface, since
/// the design is full parity. Every command in the desktop's
/// `generate_handler!` is in this list or in [`REFUSED_COMMANDS`], and a test
/// there fails by name on one that is in neither.
pub const ALLOWED_COMMANDS: &[&str] = &[
    "host_start",
    "host_send",
    "host_status",
    "key_set",
    "key_clear",
    "key_status",
    "pilot_send",
    "pilot_cancel",
    "pilot_models",
    "app_quit",
    "update_check",
    "update_install",
    "remote_status",
    "remote_pair_begin",
    "remote_pair_answer",
    "remote_revoke",
    // The switch, start at login, keep awake and the relay (#344). Allowed, so a
    // phone can turn remote access off: full parity. Its answer reaches the
    // phone before its own connection closes.
    "remote_set",
];

/// Desktop commands decided to be the desktop window's alone. None yet: a name
/// goes here when somebody decides a command must not be reachable from a phone.
pub const REFUSED_COMMANDS: &[&str] = &[];

/// The events forwarded to every connected phone, in emit order.
///
/// `remote://pair-request` reaches phones because `remote_pair_answer` is
/// allowed from one, and `remote://pair-ended` with it, because that is what
/// closes the prompt on every client when any one of them answers. Neither
/// reaches the phone being paired, which is not on the paired list yet and so
/// has no control stream.
pub const REMOTE_EVENTS: &[&str] = &[
    "host://frame",
    "host://log",
    "host://exit",
    "pilot://event",
    "app://update-progress",
    "remote://pair-request",
    "remote://pair-ended",
    // A paired phone connected or went (#344). It carries nothing: it means
    // the `remote_status` a client holds is stale, so a client reads
    // `remote_status` once after it joins and again on every one of these.
    // Forwarded because a phone draws the connected clients too.
    "remote://connections",
];

/// The events that never leave the desktop: `app://quit-requested` is the
/// desktop tray asking the desktop window.
pub const DESKTOP_ONLY_EVENTS: &[&str] = &["app://quit-requested"];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn json_of<T: Serialize>(v: &T) -> Value {
        serde_json::to_value(v).expect("serialises")
    }

    #[test]
    fn the_messages_have_the_shapes_the_phone_reads() {
        assert_eq!(
            json_of(&Hello { remote_protocol: 1, app_version: "1.7.0".into(), phone_name: "Pixel".into() }),
            json!({ "remoteProtocol": 1, "appVersion": "1.7.0", "phoneName": "Pixel" })
        );
        assert_eq!(
            json_of(&Welcome { remote_protocol: 1, app_version: "1.7.0".into(), desktop_name: None, id_base: ID_RANGE }),
            json!({ "remoteProtocol": 1, "appVersion": "1.7.0", "desktopName": null, "idBase": 1u64 << 40 })
        );
        assert_eq!(
            json_of(&VersionMismatch { desktop_app_version: "1.7.0".into(), phone_app_version: "1.8.0".into() }),
            json!({ "desktopAppVersion": "1.7.0", "phoneAppVersion": "1.8.0" })
        );
        assert_eq!(
            json_of(&ToDesktop::Call(Call { call: 3, command: "host_status".into(), args: json!({}) })),
            json!({ "type": "call", "call": 3, "command": "host_status", "args": {} })
        );
        assert_eq!(json_of(&ToDesktop::Unpair), json!({ "type": "unpair" }));
        assert_eq!(
            json_of(&ToPhone::Return(Return { call: 7, outcome: Outcome::Ok(json!(5)) })),
            json!({ "type": "return", "call": 7, "ok": 5 })
        );
        assert_eq!(
            json_of(&ToPhone::Return(Return { call: 7, outcome: Outcome::Err("no".into()) })),
            json!({ "type": "return", "call": 7, "err": "no" })
        );
        let payload = RawValue::from_string(r#"{"host":"run-1","frame":{"type":"x"}}"#.into()).unwrap();
        let event = serde_json::to_string(&ToPhone::Event(Event { name: "host://frame".into(), payload })).unwrap();
        assert_eq!(event, r#"{"type":"event","name":"host://frame","payload":{"host":"run-1","frame":{"type":"x"}}}"#);
    }

    #[test]
    fn the_messages_read_back() {
        let unpair: ToDesktop = serde_json::from_str(r#"{"type":"unpair"}"#).unwrap();
        assert_eq!(unpair, ToDesktop::Unpair);
        // An Unpair carrying an id reads as the same Unpair: the id is ignored,
        // because the desktop removes the connection's own.
        let unpair: ToDesktop = serde_json::from_str(r#"{"type":"unpair","id":"someone-else"}"#).unwrap();
        assert_eq!(unpair, ToDesktop::Unpair);
        let ret: ToPhone = serde_json::from_str(r#"{"type":"return","call":2,"err":"refused"}"#).unwrap();
        assert!(matches!(ret, ToPhone::Return(Return { call: 2, outcome: Outcome::Err(ref e) }) if e == "refused"));
    }

    #[test]
    fn every_name_has_exactly_one_decision() {
        for name in ALLOWED_COMMANDS {
            assert!(!REFUSED_COMMANDS.contains(name), "{name} is both allowed and refused");
        }
        for name in REMOTE_EVENTS {
            assert!(!DESKTOP_ONLY_EVENTS.contains(name), "{name} is both forwarded and held back");
        }
        assert!(DESKTOP_ONLY_EVENTS.contains(&"app://quit-requested"));
    }

    #[test]
    fn the_remote_protocol_moves_with_the_host_protocol() {
        let source = include_str!("../../../src/protocol.ts");
        let marker = "export const PROTOCOL_VERSION = ";
        let at = source.find(marker).expect("src/protocol.ts declares PROTOCOL_VERSION") + marker.len();
        let digits: String = source[at..].chars().take_while(char::is_ascii_digit).collect();
        let host: u32 = digits.parse().expect("PROTOCOL_VERSION is an integer");
        assert_eq!(
            host, HOST_PROTOCOL,
            "src/protocol.ts is at PROTOCOL_VERSION {host} and this wire was cut against {HOST_PROTOCOL}: \
             bump REMOTE_PROTOCOL with it, then HOST_PROTOCOL"
        );
        // Neither moves without editing this line.
        assert_eq!((REMOTE_PROTOCOL, HOST_PROTOCOL), (1, 2));
    }
}
