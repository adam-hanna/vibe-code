//! A desktop that is not there (#345), behind the `mock-desktop` feature.
//!
//! It answers from `fixtures/desktop.json`, which
//! `scripts/record-mock-desktop.mjs` recorded from the real Node host: a
//! finished run, made with the core's own loop harness and fake agents, and
//! every read the cockpit makes about it. So what the phone draws here is the
//! real cockpit folding real frames, with only the connection pretended.
//!
//! - `host_status` is the desktop's `Status`, built around the recorded
//!   `ready` frame.
//! - `host_send` takes the request's `type` (and, for `artifact`, its name),
//!   finds the recorded answer, gives it the request's `id`, and emits it as a
//!   `host://frame` from the service host - what the desktop's relay does.
//!   A request it has no answer for is answered with an `error` frame naming
//!   it, so the cockpit says what is missing rather than waiting.
//! - Every other command is refused by name. A run is never started.

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use crate::desktop::{Answer, Desktop};

const RECORDED: &str = include_str!("../fixtures/desktop.json");

/// The relay's name for the service host, as `host.ts` has it.
const SERVICE: &str = "service";

pub struct Recorded {
    app: AppHandle,
    fixture: Value,
}

impl Recorded {
    pub fn new(app: AppHandle) -> Self {
        let fixture = serde_json::from_str(RECORDED).expect("the recorded desktop is JSON");
        Recorded { app, fixture }
    }
}

/// The recorded answer to one request line, with the request's id, or an
/// `error` frame saying there is none. Pure, for the tests.
pub fn answer(fixture: &Value, line: &str) -> Value {
    let request: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({ "type": "error", "id": null, "message": format!("the mock desktop could not read the request: {e}") }),
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let kind = request.get("type").and_then(Value::as_str).unwrap_or("");
    let found = if kind == "artifact" {
        request
            .get("name")
            .and_then(Value::as_str)
            .and_then(|name| fixture.pointer(&format!("/artifact/{}", name.replace('~', "~0").replace('/', "~1"))))
    } else {
        fixture.get("answers").and_then(|a| a.get(kind))
    };
    match found {
        Some(Value::Object(frame)) => {
            let mut frame: Map<String, Value> = frame.clone();
            frame.insert("id".into(), id);
            // A save is answered about the key it saved, not the one recorded.
            if let (Some(key), true) = (request.get("key"), frame.contains_key("key")) {
                frame.insert("key".into(), key.clone());
            }
            Value::Object(frame)
        }
        _ => json!({
            "type": "error",
            "id": id,
            "message": format!("the mock desktop has no recorded answer to a {kind} request"),
        }),
    }
}

/// The desktop's `host_status`, around the recorded `ready` frame.
pub fn status(fixture: &Value) -> Value {
    let ready = fixture.get("ready").cloned().unwrap_or(Value::Null);
    json!({
        "running": true,
        "pid": ready.get("pid").cloned().unwrap_or(Value::Null),
        "uptimeSecs": null,
        "ready": ready,
        "failure": null,
        "uncontained": null,
        "build": { "version": env!("CARGO_PKG_VERSION"), "commit": null, "at": null },
        "runs": [],
    })
}

impl Desktop for Recorded {
    fn call(&self, command: &str, args: Value) -> Answer<'_> {
        let command = command.to_string();
        Box::pin(async move {
            match command.as_str() {
                "host_status" => Ok(status(&self.fixture)),
                "host_send" => {
                    let line = args.get("line").and_then(Value::as_str).unwrap_or("");
                    let frame = answer(&self.fixture, line);
                    log::info!(
                        "mock desktop: answered {} with {}",
                        serde_json::from_str::<Value>(line).ok().and_then(|r| r.get("type").cloned()).unwrap_or(Value::Null),
                        frame.get("type").cloned().unwrap_or(Value::Null),
                    );
                    self.app
                        .emit("host://frame", json!({ "host": SERVICE, "frame": frame }))
                        .map_err(|e| format!("the mock desktop could not emit: {e}"))?;
                    Ok(Value::Null)
                }
                other => Err(format!("the mock desktop does not answer {other}")),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(RECORDED).expect("JSON")
    }

    #[test]
    fn a_recorded_read_comes_back_under_the_request_s_id() {
        let got = answer(&fixture(), r#"{"type":"archive","id":77,"dir":"/home/you/code/shop"}"#);
        assert_eq!(got["type"], "archive");
        assert_eq!(got["id"], 77);
        assert!(got["runs"].as_array().is_some_and(|r| !r.is_empty()), "the recorded run is listed");
    }

    #[test]
    fn an_artifact_is_found_by_its_name() {
        let got = answer(&fixture(), r#"{"type":"artifact","id":3,"name":"PLAN.md"}"#);
        assert_eq!(got["type"], "artifact");
        assert_eq!(got["id"], 3);
        let missing = answer(&fixture(), r#"{"type":"artifact","id":4,"name":"nope.md"}"#);
        assert_eq!(missing["type"], "error");
    }

    #[test]
    fn a_save_is_answered_about_the_key_it_saved() {
        let got = answer(&fixture(), r#"{"type":"memory_save","id":9,"key":"vibe.pinned","value":"[]"}"#);
        assert_eq!(got["type"], "memory_saved");
        assert_eq!(got["key"], "vibe.pinned");
    }

    #[test]
    fn a_request_with_no_recording_is_an_error_naming_it() {
        let got = answer(&fixture(), r#"{"type":"diff","id":5}"#);
        assert_eq!(got["type"], "error");
        assert_eq!(got["id"], 5);
        assert_eq!(got["message"], "the mock desktop has no recorded answer to a diff request");
    }

    #[test]
    fn the_status_carries_the_recorded_ready_frame() {
        let s = status(&fixture());
        assert_eq!(s["ready"]["type"], "ready");
        assert_eq!(s["ready"]["protocol"], 2);
        assert_eq!(s["runs"], json!([]));
    }
}
