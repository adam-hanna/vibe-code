//! The desktop this phone talks to, as one trait (#345).
//!
//! The webview's `transport.mobile.ts` sends every desktop command here as a
//! `remote_call`, and whatever implements [`Desktop`] carries it. What the
//! desktop says back - its answer, or its refusal, or an event - reaches the
//! webview unchanged: **the phone's Rust relays and decides nothing**, the
//! design's rule for both ends.
//!
//! Since #346 the trait also carries what the phone does about its desktops:
//! the paired list, opening one, the reconnect generation, pairing and
//! unpairing. Those are the `phone_*` commands, and they are about the device,
//! never about a run.
//!
//! Three implementations, and the trait is what lets the cockpit not care:
//!
//! - [`Unconnected`]: no desktop at all. Every call says so, in a sentence the
//!   cockpit draws where it would draw a host error.
//! - `link::Link`: the iroh connection, on #343's control stream (#346).
//! - `mock::Recorded`, behind the `mock-desktop` feature: a recorded session,
//!   so the cockpit can be seen drawing frames on a simulator with no desktop.

use std::future::Future;
use std::pin::Pin;

use serde_json::{json, Value};

/// A desktop command's answer, as the desktop's Rust returned it.
pub type Answer<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

/// Any other answer that has to be waited for.
pub type Later<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait Desktop: Send + Sync {
    /// One command, by the name the window invokes it under (`host_send`,
    /// `host_status`, ...), with the window's own arguments.
    fn call(&self, command: &str, args: Value) -> Answer<'_>;

    /// `phone_desktops`: the paired list, each with how it can be reached, and
    /// the live link.
    fn desktops(&self) -> Value {
        json!({ "desktops": [], "problem": null, "current": null, "link": null })
    }

    /// `phone_probe`: try every paired desktop that is not the open one.
    fn probe(&self) {}

    /// `phone_open`: dial a desktop and keep it connected, or (`None`) stop.
    fn open(&self, _id: Option<String>) -> Answer<'_> {
        Box::pin(async { Err(UNCONNECTED.to_string()) })
    }

    /// `phone_session`: the live connection's generation and request range.
    fn session(&self) -> Result<Value, String> {
        Err(UNCONNECTED.to_string())
    }

    /// `phone_release`: the webview is listening for this generation's events.
    fn release(&self, _generation: u64) {}

    /// `phone_pair`: pair from a scanned payload.
    fn pair(&self, _payload: String, _phone_name: String, _attempt: u64) -> Answer<'_> {
        Box::pin(async { Err(UNCONNECTED.to_string()) })
    }

    /// `phone_pair_cancel`: Back, during the pairing for `attempt`.
    fn pair_cancel(&self, _attempt: u64) {}

    /// `phone_unpair`.
    fn unpair(&self, _id: String) -> Answer<'_> {
        Box::pin(async { Err(UNCONNECTED.to_string()) })
    }

    /// `phone_rename`: the phone's own name for a desktop. Never sent.
    fn rename(&self, _id: &str, _name: Option<String>) -> Result<(), String> {
        Err(UNCONNECTED.to_string())
    }

    /// The OS said the network changed, or the app came to the foreground:
    /// reconnect now rather than at the next backoff.
    fn network_changed(&self, _online: Option<bool>) -> Later<'_, ()> {
        Box::pin(async {})
    }
}

/// What a call says before any desktop is reachable.
pub const UNCONNECTED: &str = "this phone is not connected to a desktop";

/// No desktop.
#[cfg_attr(not(test), allow(dead_code))]
pub struct Unconnected;

impl Desktop for Unconnected {
    fn call(&self, _command: &str, _args: Value) -> Answer<'_> {
        Box::pin(async { Err(UNCONNECTED.to_string()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unconnected_phone_refuses_every_call_with_one_sentence() {
        let rt = tauri::async_runtime::block_on(async {
            (
                Unconnected.call("host_status", Value::Null).await,
                Unconnected.call("host_send", serde_json::json!({ "handle": "service", "line": "{}" })).await,
            )
        });
        assert_eq!(rt.0, Err(UNCONNECTED.to_string()));
        assert_eq!(rt.1, Err(UNCONNECTED.to_string()));
    }
}
