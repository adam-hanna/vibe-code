//! The OpenAI adapter: chat completions, streaming.
//!
//! The counterpart to `anthropic.rs`, and deliberately not its mirror image.
//! Four differences survive into the vocabulary rather than being papered over,
//! and each of them is a place where a shared abstraction would have had to
//! invent something:
//!
//! - **The system prompt is a message**, with `role: "system"`, rather than a
//!   top-level field. Same intent, different request, two `body` functions.
//! - **No event is named.** Every event is a bare `data:` line, so `fold`
//!   branches on the payload where the other branches on the name.
//! - **The stream ends with a sentinel**, `data: [DONE]`, which is not JSON.
//! - **Usage arrives once, at the end, and only if asked for.** Without
//!   `stream_options.include_usage` there is no usage at all - and even with it,
//!   there is no cache *write* count, because the API has no such concept to
//!   report. `Usage::cache_write` is `None` on every OpenAI turn, and `None`
//!   means "this vendor did not say".

use serde_json::{json, Value};

use super::event::{PilotEvent, Usage};
use super::request::Turn;

pub const URL: &str = "https://api.openai.com/v1/chat/completions";

/// The last line of a finished stream. Not JSON, and it is not an error.
pub const DONE: &str = "[DONE]";

/// The request body.
///
/// `stream_options.include_usage` is what makes a turn reportable at all:
/// without it the stream carries no `usage` object and the pane would have
/// nothing to show but a dash. It is asked for on every request rather than
/// configured, because a pilot that cannot say what it spent is the thing #145
/// exists to prevent.
pub fn body(turn: &Turn) -> Value {
    let mut messages: Vec<Value> = Vec::with_capacity(turn.messages.len() + 1);
    if let Some(system) = turn.system.as_deref().filter(|s| !s.trim().is_empty()) {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for message in &turn.messages {
        messages.push(json!({ "role": message.role, "content": message.content }));
    }
    json!({
        "model": turn.model,
        "max_completion_tokens": turn.max_tokens,
        "stream": true,
        "stream_options": { "include_usage": true },
        "messages": messages,
    })
}

pub fn headers(key: &str) -> [(&'static str, String); 2] {
    [
        ("content-type", "application/json".to_string()),
        ("authorization", format!("Bearer {key}")),
    ]
}

/// What a single event did to the turn.
///
/// `first` is whether a `Started` has already been emitted. OpenAI has no
/// opening event of its own - the model name arrives on the first chunk, the
/// same as every subsequent one - so the adapter is told rather than guessing,
/// and the caller owns the flag. That keeps this function pure.
pub fn fold(turn: u64, data: &str, first: bool) -> Vec<PilotEvent> {
    if data.trim() == DONE {
        // The sentinel is the end of the stream, not the end of the turn: the
        // `finish_reason` arrived on an earlier chunk and `Ended` was emitted
        // there, with the reason attached. Ending again here would end the turn
        // twice, the second time with no reason at all.
        return vec![];
    }

    let value: Value = match serde_json::from_str(data) {
        Ok(value) => value,
        Err(e) => {
            return vec![PilotEvent::Failed {
                turn,
                message: format!("OpenAI sent an event that is not JSON: {e}"),
            }]
        }
    };

    // An error object on a stream that already returned 200. Rarer than
    // Anthropic's but the same hazard, and the same handling.
    if !value["error"].is_null() {
        return vec![PilotEvent::Failed {
            turn,
            message: describe(&value["error"]),
        }];
    }

    let mut out = Vec::new();
    if first {
        out.push(PilotEvent::Started {
            turn,
            provider: crate::keys::Provider::Openai,
            model: value["model"].as_str().map(str::to_string),
        });
    }

    // The final usage chunk carries an EMPTY `choices` array, so the delta and
    // usage arms are independent rather than nested.
    let choice = &value["choices"][0];
    if let Some(text) = choice["delta"]["content"].as_str() {
        if !text.is_empty() {
            out.push(PilotEvent::Text {
                turn,
                delta: text.to_string(),
            });
        }
    }

    let usage = usage_of(&value["usage"]);
    if !usage.is_empty() {
        out.push(PilotEvent::Spent { turn, usage });
    }

    if let Some(stop) = choice["finish_reason"].as_str() {
        out.push(PilotEvent::Ended {
            turn,
            stop: Some(stop.to_string()),
        });
    }

    out
}

/// OpenAI's `usage` object, read field by field.
///
/// **`cache_write` is never set**, and that is not an omission. The API reports
/// `cached_tokens` - a read - and has no cache-write charge to report. Deriving
/// one from the other, or writing a zero, would be a number nobody measured in
/// the pane where a user reads what their pilot cost.
fn usage_of(usage: &Value) -> Usage {
    Usage {
        input: usage["prompt_tokens"].as_u64(),
        output: usage["completion_tokens"].as_u64(),
        cache_read: usage["prompt_tokens_details"]["cached_tokens"].as_u64(),
        cache_write: None,
    }
}

/// The vendor's own words, or a statement that it gave none.
pub fn describe(error: &Value) -> String {
    match (error["code"].as_str(), error["message"].as_str()) {
        (Some(code), Some(message)) => format!("{code}: {message}"),
        (None, Some(message)) => message.to_string(),
        (Some(code), None) => code.to_string(),
        (None, None) if error.is_null() => "OpenAI gave no reason".to_string(),
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
            provider: Provider::Openai,
            model: "gpt-5".into(),
            system: Some("be brief".into()),
            messages: vec![Message {
                role: Role::User,
                content: "hello".into(),
            }],
            max_tokens: 1024,
        }
    }

    #[test]
    fn the_system_prompt_is_a_message_and_it_goes_first() {
        // Anthropic puts this in a top-level field. Same intent, different
        // request - which is exactly the difference a shared body-builder would
        // have had to pick a side on.
        let body = body(&turn());
        let messages = body["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0], json!({"role":"system","content":"be brief"}));
        assert_eq!(messages[1]["role"], json!("user"));
        assert!(body.get("system").is_none());
    }

    #[test]
    fn usage_is_asked_for_because_it_is_not_offered() {
        // Without this the stream carries no usage at all and the pane has
        // nothing to show.
        assert_eq!(body(&turn())["stream_options"]["include_usage"], json!(true));
    }

    #[test]
    fn a_blank_system_prompt_adds_no_message() {
        let mut t = turn();
        t.system = Some("   ".into());
        assert_eq!(body(&t)["messages"].as_array().expect("messages").len(), 1);
    }

    #[test]
    fn the_first_chunk_starts_the_turn_and_the_rest_do_not() {
        // OpenAI has no opening event: the model name is on every chunk. The
        // caller owns the flag so this function stays pure.
        let chunk = r#"{"id":"c1","object":"chat.completion.chunk","model":"gpt-5-2026-04-01","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}"#;
        assert_eq!(
            fold(1, chunk, true),
            vec![
                PilotEvent::Started {
                    turn: 1,
                    provider: Provider::Openai,
                    model: Some("gpt-5-2026-04-01".into()),
                },
                PilotEvent::Text {
                    turn: 1,
                    delta: "Hel".into()
                }
            ]
        );
        assert_eq!(
            fold(1, chunk, false),
            vec![PilotEvent::Text {
                turn: 1,
                delta: "Hel".into()
            }]
        );
    }

    #[test]
    fn a_finish_reason_ends_the_turn_in_the_vendors_own_word() {
        // `stop`, not translated into Anthropic's `end_turn`.
        let events = fold(
            1,
            r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
            false,
        );
        assert_eq!(
            events,
            vec![PilotEvent::Ended {
                turn: 1,
                stop: Some("stop".into())
            }]
        );
    }

    #[test]
    fn the_usage_chunk_has_no_choices_at_all() {
        // The shape that makes the delta and usage arms independent rather than
        // nested: `choices` is an empty array on the chunk that carries usage.
        let events = fold(
            1,
            r#"{"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":38,"total_tokens":158,"prompt_tokens_details":{"cached_tokens":64}}}"#,
            false,
        );
        assert_eq!(
            events,
            vec![PilotEvent::Spent {
                turn: 1,
                usage: Usage {
                    input: Some(120),
                    output: Some(38),
                    cache_read: Some(64),
                    // Never set. The API has no cache-write charge to report,
                    // and a zero here would be a number nobody measured.
                    cache_write: None,
                }
            }]
        );
    }

    #[test]
    fn this_vendor_never_reports_a_cache_write() {
        // Pinned as its own case because it is the single clearest instance of
        // the rule this issue is arranged around. If somebody "fixes" the
        // asymmetry by defaulting it to zero, this is what says no.
        let events = fold(
            1,
            r#"{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":0}}}"#,
            false,
        );
        match &events[0] {
            PilotEvent::Spent { usage, .. } => {
                assert_eq!(usage.cache_write, None);
                // And the read it DID report, including its zero.
                assert_eq!(usage.cache_read, Some(0));
            }
            other => panic!("expected spend, got {other:?}"),
        }
    }

    #[test]
    fn the_done_sentinel_ends_nothing_because_the_turn_already_ended() {
        // `[DONE]` is not JSON and is not an error. The `finish_reason` came on
        // an earlier chunk, so ending here as well would end the turn twice -
        // the second time with no reason attached.
        assert!(fold(1, DONE, false).is_empty());
        assert!(fold(1, " [DONE] ", false).is_empty());
    }

    #[test]
    fn an_error_object_on_a_200_stream_is_a_failure() {
        assert_eq!(
            fold(
                1,
                r#"{"error":{"code":"rate_limit_exceeded","message":"Rate limit reached"}}"#,
                false
            ),
            vec![PilotEvent::Failed {
                turn: 1,
                message: "rate_limit_exceeded: Rate limit reached".into()
            }]
        );
    }

    #[test]
    fn an_empty_delta_produces_no_text_event() {
        // The opening chunk of every OpenAI reply carries `{"role":"assistant"}`
        // and no content. Emitting an empty text event for it would put a
        // zero-length append in the transcript for every turn.
        assert!(fold(
            1,
            r#"{"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}"#,
            false
        )
        .is_empty());
    }

    #[test]
    fn a_payload_that_is_not_json_is_reported() {
        let events = fold(1, "<html>502 Bad Gateway</html>", false);
        assert!(matches!(events.as_slice(), [PilotEvent::Failed { .. }]));
    }

    #[test]
    fn an_error_shape_this_version_does_not_know_is_reported_as_itself() {
        assert_eq!(describe(&json!({"detail": "nope"})), r#"{"detail":"nope"}"#);
        assert_eq!(describe(&Value::Null), "OpenAI gave no reason");
    }
}
