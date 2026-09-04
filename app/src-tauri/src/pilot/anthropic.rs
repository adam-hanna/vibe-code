//! The Anthropic adapter: the Messages API, streaming.
//!
//! Its job is to turn one vendor's stream into `PilotEvent` and nothing else.
//! It is deliberately **not** written to look like `openai.rs` - where the two
//! APIs differ, this file says what Anthropic does, and the difference survives
//! into the vocabulary as an absent field rather than being smoothed into a
//! shared shape. That is the same rule that keeps Codex cost unreported.
//!
//! ## What this vendor actually does
//!
//! - Every event is **named** (`event: content_block_delta`), which OpenAI's is
//!   not, so `fold` branches on the name and ignores the payload's own `type`.
//! - Usage arrives in **two** events. `message_start` carries the input and both
//!   cache counts; `message_delta` carries the output count. A turn's total is
//!   assembled, which is why `Usage::merge` exists.
//! - `content_block_delta` carries several delta types. Only `text_delta` is
//!   read; `thinking_delta` and `input_json_delta` belong to features this issue
//!   does not ship, and rendering a tool call's JSON as prose would be worse
//!   than not rendering it.
//! - An `error` event can arrive **mid-stream**, after a 200. A client that only
//!   checked the status code would show a truncated reply as a complete one.

use serde_json::{json, Value};

use super::event::{PilotEvent, Usage};
use super::request::Turn;

pub const URL: &str = "https://api.anthropic.com/v1/messages";

/// The version header this adapter is written against.
///
/// Pinned rather than omitted: the API requires it, and a floating version is a
/// stream whose shape can change without this file changing.
pub const VERSION: &str = "2023-06-01";

/// The request body.
///
/// `system` is a top-level field here, not a message with `role: "system"` -
/// which is the first place the two vendors stop being interchangeable.
pub fn body(turn: &Turn) -> Value {
    let mut body = json!({
        "model": turn.model,
        "max_tokens": turn.max_tokens,
        "stream": true,
        "messages": turn.messages.iter().map(|m| json!({
            "role": m.role,
            "content": m.content,
        })).collect::<Vec<_>>(),
    });
    if let Some(system) = turn.system.as_deref().filter(|s| !s.trim().is_empty()) {
        body["system"] = json!(system);
    }
    body
}

/// The headers, including the one that carries the key.
///
/// Built here and consumed immediately by the caller. The key is a `&str`
/// borrowed from the caller's own read and is not stored anywhere.
pub fn headers(key: &str) -> [(&'static str, String); 3] {
    [
        ("content-type", "application/json".to_string()),
        ("anthropic-version", VERSION.to_string()),
        ("x-api-key", key.to_string()),
    ]
}

/// What a single event did to the turn.
///
/// Pure, and the reason the adapter is testable without a socket: every case
/// below is a recorded event from a real stream, replayed as a string.
pub fn fold(turn: u64, name: Option<&str>, data: &str) -> Vec<PilotEvent> {
    // A payload that is not JSON at all is this adapter's to report, because it
    // is the one that knows what it was expecting. `sse.rs` skips what it does
    // not recognise; a broken payload is not unrecognised, it is broken.
    let value: Value = match serde_json::from_str(data) {
        Ok(value) => value,
        Err(e) => {
            return vec![PilotEvent::Failed {
                turn,
                message: format!("Anthropic sent an event that is not JSON: {e}"),
            }]
        }
    };

    match name {
        Some("message_start") => {
            let message = &value["message"];
            let mut out = vec![PilotEvent::Started {
                turn,
                provider: crate::keys::Provider::Anthropic,
                model: message["model"].as_str().map(str::to_string),
            }];
            let usage = usage_of(&message["usage"]);
            if !usage.is_empty() {
                out.push(PilotEvent::Spent { turn, usage });
            }
            out
        }

        Some("content_block_delta") => {
            // Only text. A `thinking_delta` is not the reply and an
            // `input_json_delta` is a tool call being assembled - both belong to
            // features #144 scopes, and appending either to the transcript would
            // put something in front of the user that is not what the model
            // said to them.
            match value["delta"]["type"].as_str() {
                Some("text_delta") => value["delta"]["text"]
                    .as_str()
                    .filter(|text| !text.is_empty())
                    .map(|text| {
                        vec![PilotEvent::Text {
                            turn,
                            delta: text.to_string(),
                        }]
                    })
                    .unwrap_or_default(),
                _ => vec![],
            }
        }

        Some("message_delta") => {
            let mut out = Vec::new();
            let usage = usage_of(&value["usage"]);
            if !usage.is_empty() {
                out.push(PilotEvent::Spent { turn, usage });
            }
            // `stop_reason` arrives here rather than on `message_stop`, which
            // carries nothing at all. Ending on this event rather than that one
            // is what makes the reason available at the moment the turn ends.
            out.push(PilotEvent::Ended {
                turn,
                stop: value["delta"]["stop_reason"].as_str().map(str::to_string),
            });
            out
        }

        // An error AFTER a 200. Overloaded is the common one, and it arrives
        // mid-reply: a client that trusted the status code would show half an
        // answer as a whole one.
        Some("error") => vec![PilotEvent::Failed {
            turn,
            message: describe(&value["error"]),
        }],

        // `message_stop`, `content_block_start`, `content_block_stop`, `ping`,
        // and whatever a later version adds. None of them change what the pane
        // shows, and an unknown one must not end the stream.
        _ => vec![],
    }
}

/// Anthropic's `usage` object, read field by field.
fn usage_of(usage: &Value) -> Usage {
    Usage {
        input: usage["input_tokens"].as_u64(),
        output: usage["output_tokens"].as_u64(),
        cache_read: usage["cache_read_input_tokens"].as_u64(),
        cache_write: usage["cache_creation_input_tokens"].as_u64(),
    }
}

/// The vendor's own words for a failure, or a statement that it gave none.
///
/// Never a phrase invented for it. An error body whose shape this version does
/// not know is reported as the JSON it was, which is ugly and true, rather than
/// as "the request failed", which is tidy and says nothing.
pub fn describe(error: &Value) -> String {
    match (error["type"].as_str(), error["message"].as_str()) {
        (Some(kind), Some(message)) => format!("{kind}: {message}"),
        (None, Some(message)) => message.to_string(),
        (Some(kind), None) => kind.to_string(),
        (None, None) if error.is_null() => "Anthropic gave no reason".to_string(),
        (None, None) => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::Provider;
    use crate::pilot::request::{Message, Role};

    fn turn() -> Turn {
        Turn {
            provider: Provider::Anthropic,
            model: "claude-opus-5".into(),
            system: Some("  ".into()),
            messages: vec![Message {
                role: Role::User,
                content: "hello".into(),
            }],
            max_tokens: 1024,
        }
    }

    #[test]
    fn the_system_prompt_is_a_field_and_not_a_message() {
        // The first place the two vendors stop being interchangeable, and the
        // reason there are two `body` functions rather than one with a flag.
        let mut t = turn();
        t.system = Some("be brief".into());
        let body = body(&t);
        assert_eq!(body["system"], json!("be brief"));
        assert_eq!(body["messages"].as_array().expect("messages").len(), 1);
        assert_eq!(body["messages"][0]["role"], json!("user"));
        assert_eq!(body["stream"], json!(true));
    }

    #[test]
    fn a_blank_system_prompt_is_omitted_rather_than_sent_empty() {
        assert!(body(&turn()).get("system").is_none());
    }

    #[test]
    fn message_start_names_the_model_the_vendor_chose() {
        // Not the model that was asked for. An alias resolves to a dated
        // version, and what answered is the fact worth showing.
        let events = fold(
            1,
            Some("message_start"),
            r#"{"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5-20260501","usage":{"input_tokens":120,"cache_read_input_tokens":4000,"cache_creation_input_tokens":0,"output_tokens":1}}}"#,
        );
        assert_eq!(
            events[0],
            PilotEvent::Started {
                turn: 1,
                provider: Provider::Anthropic,
                model: Some("claude-opus-5-20260501".into()),
            }
        );
        assert_eq!(
            events[1],
            PilotEvent::Spent {
                turn: 1,
                usage: Usage {
                    input: Some(120),
                    output: Some(1),
                    cache_read: Some(4000),
                    // A zero the vendor sent, kept as a zero.
                    cache_write: Some(0),
                }
            }
        );
    }

    #[test]
    fn a_text_delta_is_the_reply_and_the_others_are_not() {
        assert_eq!(
            fold(
                1,
                Some("content_block_delta"),
                r#"{"index":0,"delta":{"type":"text_delta","text":"Hel"}}"#
            ),
            vec![PilotEvent::Text {
                turn: 1,
                delta: "Hel".into()
            }]
        );
        // Thinking is not the reply, and a tool call's JSON is not prose. Both
        // belong to #144; appending either would put something in front of the
        // user that the model did not say to them.
        assert!(fold(
            1,
            Some("content_block_delta"),
            r#"{"index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}"#
        )
        .is_empty());
        assert!(fold(
            1,
            Some("content_block_delta"),
            r#"{"index":0,"delta":{"type":"input_json_delta","partial_json":"{\"a\":"}}"#
        )
        .is_empty());
    }

    #[test]
    fn message_delta_carries_the_output_count_and_ends_the_turn() {
        // Both facts on one event, which is why the turn ends here rather than
        // on `message_stop` - that event carries nothing, so ending on it would
        // mean reporting a stop reason one event after it was available.
        let events = fold(
            1,
            Some("message_delta"),
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":38}}"#,
        );
        assert_eq!(
            events,
            vec![
                PilotEvent::Spent {
                    turn: 1,
                    usage: Usage {
                        output: Some(38),
                        ..Usage::default()
                    }
                },
                PilotEvent::Ended {
                    turn: 1,
                    stop: Some("end_turn".into())
                }
            ]
        );
    }

    #[test]
    fn a_stop_reason_is_reported_in_the_vendors_own_word() {
        // `end_turn` is not translated to `stop`, and `max_tokens` is not
        // translated to `length`. A shared spelling would claim a shared meaning
        // nobody has established.
        let events = fold(
            1,
            Some("message_delta"),
            r#"{"delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":1024}}"#,
        );
        assert!(events.contains(&PilotEvent::Ended {
            turn: 1,
            stop: Some("max_tokens".into())
        }));
    }

    #[test]
    fn an_error_after_a_200_is_a_failure_and_not_a_normal_ending() {
        // The case that makes checking the status code insufficient: an
        // overloaded error arrives mid-reply, on a stream that opened fine.
        assert_eq!(
            fold(
                1,
                Some("error"),
                r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#
            ),
            vec![PilotEvent::Failed {
                turn: 1,
                message: "overloaded_error: Overloaded".into()
            }]
        );
    }

    #[test]
    fn events_this_version_does_not_know_change_nothing() {
        // A new event type from a later API version must not end a stream, and
        // must not appear in the transcript either.
        for name in [
            "ping",
            "message_stop",
            "content_block_start",
            "content_block_stop",
            "something_new",
        ] {
            assert!(fold(1, Some(name), r#"{"type":"whatever"}"#).is_empty(), "{name}");
        }
    }

    #[test]
    fn a_payload_that_is_not_json_is_reported_rather_than_skipped() {
        // `sse.rs` skips lines it does not recognise, which is right for a
        // framing layer. A malformed payload is not unrecognised - it means the
        // stream is broken, and continuing would show a truncated reply as whole.
        let events = fold(1, Some("message_start"), "<html>502 Bad Gateway</html>");
        assert!(matches!(events.as_slice(), [PilotEvent::Failed { .. }]));
    }

    #[test]
    fn an_error_shape_this_version_does_not_know_is_reported_as_itself() {
        assert_eq!(describe(&json!({"detail": "nope"})), r#"{"detail":"nope"}"#);
        assert_eq!(describe(&Value::Null), "Anthropic gave no reason");
        assert_eq!(describe(&json!({"message": "bad key"})), "bad key");
    }
}
