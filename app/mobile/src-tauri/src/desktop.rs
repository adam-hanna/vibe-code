//! The desktop this phone talks to, as one trait (#345).
//!
//! The webview's `transport.mobile.ts` sends every desktop command here as a
//! `remote_call`, and whatever implements [`Desktop`] carries it. What the
//! desktop says back - its answer, or its refusal, or an event - reaches the
//! webview unchanged: **the phone's Rust relays and decides nothing**, the
//! design's rule for both ends.
//!
//! Three implementations, and the trait is what lets the cockpit not care:
//!
//! - [`Unconnected`], until a desktop is paired and dialled (#346). Every call
//!   says so, in a sentence the cockpit draws where it would draw a host error.
//! - the iroh connection, on #343's control stream (#346).
//! - `mock::Recorded`, behind the `mock-desktop` feature: a recorded session,
//!   so the cockpit can be seen drawing frames on a simulator with no desktop.

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

/// A desktop command's answer, as the desktop's Rust returned it.
pub type Answer<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

pub trait Desktop: Send + Sync {
    /// One command, by the name the window invokes it under (`host_send`,
    /// `host_status`, ...), with the window's own arguments.
    fn call(&self, command: &str, args: Value) -> Answer<'_>;
}

/// What a call says before any desktop is reachable.
// Unused only in a mock build, which has a desktop of its own.
#[cfg_attr(feature = "mock-desktop", allow(dead_code))]
pub const UNCONNECTED: &str = "this phone is not connected to a desktop";

/// No desktop.
#[cfg_attr(feature = "mock-desktop", allow(dead_code))]
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
