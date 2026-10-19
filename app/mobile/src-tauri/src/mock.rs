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
//! - The `phone_*` side (#346): one paired desktop, the current one, which
//!   opens at once as generation 1 with the request range above the window's.
//!   Pairing and unpairing are refused: there is no desktop to pair with.
//! - **The recorded place is this phone's too.** The recording holds the
//!   desktop window's `vibe.where`, and since #347 a phone reads its place
//!   from `vibe.where.phone.<its endpoint id>` instead, so a mock build
//!   opened on no run and never asked for the recorded one. The endpoint id
//!   is made fresh on every install, so it cannot be recorded: the `memory`
//!   answer carries the recorded place under this phone's key as well
//!   (`for_phone`). Nothing else in the memory is device-scoped.

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use crate::desktop::{Answer, Desktop};

const RECORDED: &str = include_str!("../fixtures/desktop.json");

/// The relay's name for the service host, as `host.ts` has it.
const SERVICE: &str = "service";

pub struct Recorded {
    app: AppHandle,
    fixture: Value,
    /// This phone's endpoint id, when it has a key.
    phone: Option<String>,
}

impl Recorded {
    pub fn new(app: AppHandle, phone: Option<String>) -> Self {
        let fixture = serde_json::from_str(RECORDED).expect("the recorded desktop is JSON");
        Recorded { app, fixture, phone }
    }
}

/// The desktop's place key, as `WHERE_KEY` in `app/src/cockpit/where.ts` has it.
const WHERE_KEY: &str = "vibe.where";

/// A `memory` answer with the desktop's place also under `phone`'s own key,
/// as `deviceKey` spells it. Any other frame, or a phone with no id, or a
/// memory that already holds the phone's key, comes back unchanged. Pure.
pub fn for_phone(mut frame: Value, phone: Option<&str>) -> Value {
    let Some(phone) = phone.filter(|p| !p.trim().is_empty()) else { return frame };
    if frame.get("type").and_then(Value::as_str) != Some("memory") {
        return frame;
    }
    let own = format!("{WHERE_KEY}.phone.{phone}");
    let Some(entries) = frame.get_mut("entries").and_then(Value::as_array_mut) else { return frame };
    if entries.iter().any(|e| e.get("key").and_then(Value::as_str) == Some(own.as_str())) {
        return frame;
    }
    let place = entries.iter().find(|e| e.get("key").and_then(Value::as_str) == Some(WHERE_KEY)).and_then(|e| e.get("value")).cloned();
    if let Some(value) = place {
        entries.push(json!({ "key": own, "value": value }));
    }
    frame
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
                    let frame = for_phone(answer(&self.fixture, line), self.phone.as_deref());
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

    fn desktops(&self) -> Value {
        let id = desktop_id();
        json!({
            "desktops": [{
                "id": id,
                "relay": null,
                "desktopName": "Recorded desktop",
                "name": null,
                "pairedAt": 0,
                "lastSeen": null,
                "reach": { "state": "open" },
            }],
            "problem": null,
            "current": id,
            "link": { "id": id, "phase": "up", "reason": null, "path": "direct", "connectMs": null },
        })
    }

    fn open(&self, id: Option<String>) -> Answer<'_> {
        Box::pin(async move {
            if id.is_none() {
                return Ok(json!({ "generation": null }));
            }
            self.app
                .emit("phone://connected", json!({ "generation": GENERATION }))
                .map_err(|e| format!("the mock desktop could not emit: {e}"))?;
            Ok(json!({ "generation": GENERATION }))
        })
    }

    fn session(&self) -> Result<Value, String> {
        Ok(json!({ "generation": GENERATION, "idBase": vibe_remote::control::ID_RANGE }))
    }

    fn pair(&self, _payload: String, _phone_name: String, _attempt: u64) -> Answer<'_> {
        Box::pin(async { Err("the mock desktop cannot be paired with".to_string()) })
    }

    fn unpair(&self, _id: String) -> Answer<'_> {
        Box::pin(async { Err("the mock desktop cannot be unpaired".to_string()) })
    }
}

/// The recorded session is one connection.
const GENERATION: u64 = 1;

/// A fixed endpoint id for the recorded desktop, so the list has a real-looking one.
fn desktop_id() -> String {
    iroh_base::SecretKey::from_bytes(&[7; 32]).public().to_string()
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
    fn the_recorded_place_is_also_under_the_phone_s_own_key() {
        let memory = answer(&fixture(), r#"{"type":"memory","id":5}"#);
        let desktop = memory["entries"].as_array().unwrap().iter().find(|e| e["key"] == WHERE_KEY).unwrap()["value"].clone();
        let got = for_phone(memory.clone(), Some("abc"));
        let own = got["entries"].as_array().unwrap().iter().find(|e| e["key"] == "vibe.where.phone.abc").expect("the phone's key");
        assert_eq!(own["value"], desktop, "the same place the desktop recorded");
        assert_eq!(for_phone(memory.clone(), None), memory, "a phone with no id keeps no key");
        assert_eq!(for_phone(got.clone(), Some("abc")), got, "an existing key is not added twice");
        let other = answer(&fixture(), r#"{"type":"chats","id":6}"#);
        assert_eq!(for_phone(other.clone(), Some("abc")), other, "only the memory read");
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
    fn the_recorded_desktop_is_the_one_current_desktop() {
        let d = desktop_id();
        assert_eq!(d.len(), 64);
        assert_ne!(d, iroh_base::SecretKey::from_bytes(&[8; 32]).public().to_string());
    }

    #[test]
    fn the_status_carries_the_recorded_ready_frame() {
        let s = status(&fixture());
        assert_eq!(s["ready"]["type"], "ready");
        assert_eq!(s["ready"]["protocol"], 2);
        assert_eq!(s["runs"], json!([]));
    }
}
