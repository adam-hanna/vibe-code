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
//! - `content_block_delta` carries several delta types. `text_delta` is the
//!   reply and `input_json_delta` is a tool call being assembled;
//!   `thinking_delta` is neither, and appending it would put something in front
//!   of the user that the model did not say to them.
//! - An `error` event can arrive **mid-stream**, after a 200. A client that only
//!   checked the status code would show a truncated reply as a complete one.
//! - **A tool call spans three events**: `content_block_start` carries the id and
//!   the name, any number of `input_json_delta`s carry its arguments, and
//!   `content_block_stop` closes it. That is why `fold` takes a `State` -
//!   OpenAI's accumulation is keyed differently and finishes elsewhere, so the
//!   two are not one mechanism with a flag.

use serde_json::{json, Value};

use super::event::{PilotEvent, Usage};
use super::request::{Message, Turn};

pub const URL: &str = "https://api.anthropic.com/v1/messages";

/// The version header this adapter is written against.
///
/// Pinned rather than omitted: the API requires it, and a floating version is a
/// stream whose shape can change without this file changing.
pub const VERSION: &str = "2023-06-01";

/// The conversation, in the shape this vendor takes it.
///
/// **Two rules that are this vendor's alone**, and both would be wrong for the
/// other one:
///
/// 1. A tool result is carried on a **user** message, as a `tool_result` content
///    block. OpenAI has a `tool` role for it; Anthropic does not.
/// 2. **Every result for one assistant turn goes in a single user message.** The
///    API rejects a conversation that splits two results across two messages, so
///    consecutive results are grouped - which is the one place this function
///    does something other than map one message to one message.
fn messages(turn: &Turn) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::with_capacity(turn.messages.len());
    // The user message currently collecting `tool_result` blocks, if any.
    let mut results: Vec<Value> = Vec::new();

    let flush = |out: &mut Vec<Value>, results: &mut Vec<Value>| {
        if !results.is_empty() {
            out.push(json!({ "role": "user", "content": std::mem::take(results) }));
        }
    };

    for message in &turn.messages {
        match message {
            Message::Tool { id, content, .. } => results.push(json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": content,
            })),
            Message::User { content } => {
                flush(&mut out, &mut results);
                out.push(json!({ "role": "user", "content": content }));
            }
            Message::Assistant { content, calls } => {
                flush(&mut out, &mut results);
                if calls.is_empty() {
                    // Plain text stays a plain string rather than becoming a
                    // one-element block list. Both are accepted; the string is
                    // what every conversation before #144 sent, and keeping it
                    // means this change is invisible to a turn with no tools.
                    out.push(json!({ "role": "assistant", "content": content }));
                    continue;
                }
                let mut blocks: Vec<Value> = Vec::with_capacity(calls.len() + 1);
                if !content.is_empty() {
                    blocks.push(json!({ "type": "text", "text": content }));
                }
                for call in calls {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": call.input,
                    }));
                }
                out.push(json!({ "role": "assistant", "content": blocks }));
            }
        }
    }
    flush(&mut out, &mut results);
    out
}

/// The request body.
///
/// `system` is a top-level field here, not a message with `role: "system"` -
/// which is the first place the two vendors stop being interchangeable.
pub fn body(turn: &Turn) -> Value {
    let mut body = json!({
        "model": turn.model,
        "max_tokens": turn.max_tokens,
        "stream": true,
        "messages": messages(turn),
    });
    if let Some(system) = turn.system.as_deref().filter(|s| !s.trim().is_empty()) {
        body["system"] = json!(system);
    }
    // Omitted entirely when there are none. An empty `tools: []` is accepted but
    // it is a different request from one that never mentioned tools, and while
    // this build declares nothing it should send exactly what it always sent.
    if !turn.tools.is_empty() {
        body["tools"] = json!(turn
            .tools
            .iter()
            .map(|t| json!({
                "name": t.name,
                "description": t.description,
                // This vendor's name for the schema field. OpenAI calls it
                // `parameters`, nests it, and wraps the whole thing.
                "input_schema": t.input_schema,
            }))
            .collect::<Vec<_>>());
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

/// A `tool_use` block being assembled, and the buffer its arguments arrive in.
struct Partial {
    id: String,
    name: String,
    /// The JSON the vendor is streaming, a fragment at a time. Never parsed
    /// here - the executor parses it against the schema it declared.
    arguments: String,
}

/// What has to be remembered between events.
///
/// **A tool call does not arrive in one event.** It opens on
/// `content_block_start`, its arguments stream as `input_json_delta` fragments
/// across any number of events, and it closes on `content_block_stop` - so `fold`
/// cannot be pure per-event the way it was when the only thing streaming was
/// text. Keyed by the block index, because a turn can open several at once and
/// their deltas interleave.
#[derive(Default)]
pub struct State {
    calls: std::collections::BTreeMap<u64, Partial>,
}

/// What a single event did to the turn.
///
/// The recorded events below are the reason this is testable without a socket:
/// every case is a real stream replayed as a string.
pub fn fold(turn: u64, name: Option<&str>, data: &str, state: &mut State) -> Vec<PilotEvent> {
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

        // A tool call opening. The id and the name are here and nowhere else -
        // the deltas that follow carry only the block index - so a call whose
        // start was missed can never be reassembled.
        Some("content_block_start") => {
            let block = &value["content_block"];
            if block["type"].as_str() != Some("tool_use") {
                return vec![];
            }
            let (Some(index), Some(id), Some(name)) = (
                value["index"].as_u64(),
                block["id"].as_str(),
                block["name"].as_str(),
            ) else {
                // Refuse, never repair. Inventing an index or an id would
                // assemble a call the model did not make.
                return vec![PilotEvent::Failed {
                    turn,
                    message: "Anthropic opened a tool call with no index, id or name".to_string(),
                }];
            };
            state.calls.insert(
                index,
                Partial {
                    id: id.to_string(),
                    name: name.to_string(),
                    arguments: String::new(),
                },
            );
            vec![]
        }

        Some("content_block_delta") => {
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
                // A tool call's arguments, a fragment at a time. Appended to
                // whichever block opened at this index; a fragment for an index
                // that never opened is dropped, because there is nothing to
                // attribute it to and a measurement that cannot be attributed
                // is not recorded.
                Some("input_json_delta") => {
                    if let (Some(index), Some(fragment)) = (
                        value["index"].as_u64(),
                        value["delta"]["partial_json"].as_str(),
                    ) {
                        if let Some(partial) = state.calls.get_mut(&index) {
                            partial.arguments.push_str(fragment);
                        }
                    }
                    vec![]
                }
                // Thinking is not the reply. Appending it would put something in
                // front of the user that the model did not say to them.
                _ => vec![],
            }
        }

        // A tool call is complete. Emitted here rather than being held to the
        // end of the turn, so the window can start on the first call while the
        // model is still writing the second.
        Some("content_block_stop") => value["index"]
            .as_u64()
            .and_then(|index| state.calls.remove(&index))
            .map(|partial| {
                vec![PilotEvent::ToolCall {
                    turn,
                    id: partial.id,
                    name: partial.name,
                    arguments: partial.arguments,
                }]
            })
            .unwrap_or_default(),

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

        // `message_stop`, `ping`, and whatever a later version adds. None of
        // them change what the pane shows, and an unknown one must not end the
        // stream.
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
    use crate::pilot::request::{AssistantCall, Message, Tool};

    fn turn() -> Turn {
        Turn {
            provider: Provider::Anthropic,
            model: "claude-opus-5".into(),
            system: Some("  ".into()),
            messages: vec![Message::User {
                content: "hello".into(),
            }],
            tools: vec![],
            max_tokens: 1024,
        }
    }

    /// One event, into a state nothing else has touched.
    ///
    /// Most cases are about a single event, and a fresh state says so. The
    /// multi-event cases below thread one deliberately, because assembling a
    /// tool call across events is exactly what they are testing.
    fn fold1(name: &str, data: &str) -> Vec<PilotEvent> {
        fold(1, Some(name), data, &mut State::default())
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
        let events = fold1("message_start",
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
            fold1("content_block_delta",
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
        assert!(fold1("content_block_delta",
            r#"{"index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}"#
        )
        .is_empty());
        assert!(fold1("content_block_delta",
            r#"{"index":0,"delta":{"type":"input_json_delta","partial_json":"{\"a\":"}}"#
        )
        .is_empty());
    }

    #[test]
    fn message_delta_carries_the_output_count_and_ends_the_turn() {
        // Both facts on one event, which is why the turn ends here rather than
        // on `message_stop` - that event carries nothing, so ending on it would
        // mean reporting a stop reason one event after it was available.
        let events = fold1("message_delta",
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
        let events = fold1("message_delta",
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
            fold1("error",
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
        // must not appear in the transcript either. `content_block_start` and
        // `content_block_stop` have left this list since #144 - they carry a
        // tool call now - and a TEXT block's start and stop are covered below.
        for name in ["ping", "message_stop", "something_new"] {
            assert!(fold1(name, r#"{"type":"whatever"}"#).is_empty(), "{name}");
        }
    }

    #[test]
    fn a_text_blocks_start_and_stop_still_change_nothing() {
        // The other half of the case above. A text block opens and closes with
        // the same two event names a tool call uses, and neither should produce
        // anything: the text arrived in the deltas between them.
        let mut state = State::default();
        assert!(fold(
            1,
            Some("content_block_start"),
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            &mut state,
        )
        .is_empty());
        assert!(fold(
            1,
            Some("content_block_stop"),
            r#"{"type":"content_block_stop","index":0}"#,
            &mut state,
        )
        .is_empty());
    }

    #[test]
    fn a_tool_call_is_assembled_across_three_kinds_of_event() {
        // Recorded from a real stream. The id and the name arrive once, at the
        // start; the arguments arrive as fragments that are not individually
        // valid JSON; the call is emitted when its block closes.
        let mut state = State::default();
        let mut events = Vec::new();
        for (name, data) in [
            ("content_block_start", r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01A","name":"start_run","input":{}}}"#),
            ("content_block_delta", r#"{"index":1,"delta":{"type":"input_json_delta","partial_json":"{\"task\":"}}"#),
            ("content_block_delta", r#"{"index":1,"delta":{"type":"input_json_delta","partial_json":" \"fix #7\"}"}}"#),
            ("content_block_stop", r#"{"type":"content_block_stop","index":1}"#),
        ] {
            events.extend(fold(1, Some(name), data, &mut state));
        }

        assert_eq!(
            events,
            vec![PilotEvent::ToolCall {
                turn: 1,
                id: "toolu_01A".into(),
                name: "start_run".into(),
                // **Unparsed.** The executor parses it against the schema it
                // declared; doing it here too would be two readings of the same
                // bytes with two chances to disagree.
                arguments: r#"{"task": "fix #7"}"#.into(),
            }]
        );
    }

    #[test]
    fn two_calls_in_one_turn_keep_their_own_arguments() {
        // The reason state is keyed by block index rather than being a single
        // buffer: a turn can open several tool calls and their deltas interleave.
        let mut state = State::default();
        let mut events = Vec::new();
        for (name, data) in [
            ("content_block_start", r#"{"index":1,"content_block":{"type":"tool_use","id":"toolu_A","name":"first"}}"#),
            ("content_block_start", r#"{"index":2,"content_block":{"type":"tool_use","id":"toolu_B","name":"second"}}"#),
            ("content_block_delta", r#"{"index":2,"delta":{"type":"input_json_delta","partial_json":"{\"b\":2}"}}"#),
            ("content_block_delta", r#"{"index":1,"delta":{"type":"input_json_delta","partial_json":"{\"a\":1}"}}"#),
            ("content_block_stop", r#"{"index":1}"#),
            ("content_block_stop", r#"{"index":2}"#),
        ] {
            events.extend(fold(1, Some(name), data, &mut state));
        }

        assert_eq!(
            events,
            vec![
                PilotEvent::ToolCall {
                    turn: 1,
                    id: "toolu_A".into(),
                    name: "first".into(),
                    arguments: r#"{"a":1}"#.into(),
                },
                PilotEvent::ToolCall {
                    turn: 1,
                    id: "toolu_B".into(),
                    name: "second".into(),
                    arguments: r#"{"b":2}"#.into(),
                },
            ]
        );
    }

    #[test]
    fn a_call_with_no_arguments_still_arrives() {
        // A tool whose schema takes no input gets no `input_json_delta` at all.
        // Emitting nothing for it would lose the call entirely.
        let mut state = State::default();
        fold(
            1,
            Some("content_block_start"),
            r#"{"index":0,"content_block":{"type":"tool_use","id":"toolu_A","name":"list_runs"}}"#,
            &mut state,
        );
        assert_eq!(
            fold(1, Some("content_block_stop"), r#"{"index":0}"#, &mut state),
            vec![PilotEvent::ToolCall {
                turn: 1,
                id: "toolu_A".into(),
                name: "list_runs".into(),
                arguments: String::new(),
            }]
        );
    }

    #[test]
    fn a_call_that_opens_without_an_id_is_refused_rather_than_assembled() {
        // Refuse, never repair. The id is the only thing that pairs a result
        // with its call, and inventing one would produce a request the vendor
        // rejects with a 400 that does not say which pair was wrong.
        let mut state = State::default();
        let events = fold(
            1,
            Some("content_block_start"),
            r#"{"index":0,"content_block":{"type":"tool_use","name":"start_run"}}"#,
            &mut state,
        );
        assert!(matches!(events.as_slice(), [PilotEvent::Failed { .. }]));
    }

    #[test]
    fn a_fragment_for_a_block_that_never_opened_is_dropped() {
        // It cannot be attributed to a call, and a fragment that cannot be
        // attributed is not recorded - the same rule the heartbeat follows.
        let mut state = State::default();
        assert!(fold(
            1,
            Some("content_block_delta"),
            r#"{"index":9,"delta":{"type":"input_json_delta","partial_json":"{\"a\":1}"}}"#,
            &mut state,
        )
        .is_empty());
        assert!(fold(1, Some("content_block_stop"), r#"{"index":9}"#, &mut state).is_empty());
    }

    #[test]
    fn a_turn_that_asks_for_a_tool_ends_with_the_vendors_own_word_for_it() {
        let events = fold1(
            "message_delta",
            r#"{"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":52}}"#,
        );
        assert!(events.contains(&PilotEvent::Ended {
            turn: 1,
            stop: Some("tool_use".into())
        }));
    }

    #[test]
    fn a_declared_tool_takes_this_vendors_field_names() {
        // `input_schema`, flat. OpenAI calls it `parameters`, nests it inside a
        // `function` object, and wraps that in a `type: "function"` envelope -
        // which is why there are two `body` functions and not one with a flag.
        let mut t = turn();
        t.tools.push(Tool {
            name: "start_run".into(),
            description: "Start a run from a brief".into(),
            input_schema: json!({"type": "object", "properties": {"task": {"type": "string"}}}),
        });
        let tools = body(&t);
        let tools = tools["tools"].as_array().expect("tools");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], json!("start_run"));
        assert_eq!(tools[0]["input_schema"]["type"], json!("object"));
        assert!(tools[0].get("parameters").is_none());
        assert!(tools[0].get("function").is_none());
    }

    #[test]
    fn a_request_with_no_tools_does_not_mention_tools_at_all() {
        // The groundwork claim, from this vendor's side: an empty `tools: []` is
        // accepted but it is a different request from one that never mentioned
        // them, and this build must send exactly what it always sent.
        assert!(body(&turn()).get("tools").is_none());
    }

    #[test]
    fn a_tool_result_rides_on_a_user_message_because_this_vendor_has_no_tool_role() {
        let mut t = turn();
        t.messages.push(Message::Assistant {
            content: String::new(),
            calls: vec![AssistantCall {
                id: "toolu_A".into(),
                name: "start_run".into(),
                input: json!({"task": "x"}),
            }],
        });
        t.messages.push(Message::Tool {
            id: "toolu_A".into(),
            name: "start_run".into(),
            content: "started 20260904-1".into(),
        });

        let body = body(&t);
        let messages = body["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 3);
        // The assistant's turn became a block list, with no empty text block.
        assert_eq!(messages[1]["role"], json!("assistant"));
        assert_eq!(messages[1]["content"][0]["type"], json!("tool_use"));
        assert_eq!(messages[1]["content"][0]["input"], json!({"task": "x"}));
        assert_eq!(messages[1]["content"].as_array().expect("blocks").len(), 1);
        // And the result is a USER message.
        assert_eq!(messages[2]["role"], json!("user"));
        assert_eq!(messages[2]["content"][0]["type"], json!("tool_result"));
        assert_eq!(messages[2]["content"][0]["tool_use_id"], json!("toolu_A"));
    }

    #[test]
    fn every_result_for_one_turn_goes_in_a_single_user_message() {
        // **This vendor's rule, and it is a 400 if broken.** Two results split
        // across two user messages is refused; OpenAI requires the opposite,
        // one message per result. Nothing above the adapters knows either.
        let mut t = turn();
        t.messages.push(Message::Assistant {
            content: "I'll check both.".into(),
            calls: vec![
                AssistantCall {
                    id: "toolu_A".into(),
                    name: "first".into(),
                    input: json!({}),
                },
                AssistantCall {
                    id: "toolu_B".into(),
                    name: "second".into(),
                    input: json!({}),
                },
            ],
        });
        t.messages.push(Message::Tool {
            id: "toolu_A".into(),
            name: "first".into(),
            content: "a".into(),
        });
        t.messages.push(Message::Tool {
            id: "toolu_B".into(),
            name: "second".into(),
            content: "b".into(),
        });

        let body = body(&t);
        let messages = body["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 3, "hello, the assistant turn, one result message");
        // Text first, then both calls, in order.
        assert_eq!(messages[1]["content"][0]["type"], json!("text"));
        assert_eq!(messages[1]["content"][1]["id"], json!("toolu_A"));
        assert_eq!(messages[1]["content"][2]["id"], json!("toolu_B"));
        // Both results, in one message, in order.
        let blocks = messages[2]["content"].as_array().expect("blocks");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["tool_use_id"], json!("toolu_A"));
        assert_eq!(blocks[1]["tool_use_id"], json!("toolu_B"));
    }

    #[test]
    fn a_conversation_with_no_tools_is_shaped_exactly_as_it_was_before() {
        // The groundwork claim from the other direction: plain text stays a
        // plain string rather than becoming a one-element block list. Both are
        // accepted by the API; only one of them is what we used to send.
        let mut t = turn();
        t.messages.push(Message::Assistant {
            content: "Hello.".into(),
            calls: vec![],
        });
        let body = body(&t);
        assert_eq!(body["messages"][0]["content"], json!("hello"));
        assert_eq!(body["messages"][1]["content"], json!("Hello."));
    }

    #[test]
    fn a_payload_that_is_not_json_is_reported_rather_than_skipped() {
        // `sse.rs` skips lines it does not recognise, which is right for a
        // framing layer. A malformed payload is not unrecognised - it means the
        // stream is broken, and continuing would show a truncated reply as whole.
        let events = fold1("message_start", "<html>502 Bad Gateway</html>");
        assert!(matches!(events.as_slice(), [PilotEvent::Failed { .. }]));
    }

    #[test]
    fn an_error_shape_this_version_does_not_know_is_reported_as_itself() {
        assert_eq!(describe(&json!({"detail": "nope"})), r#"{"detail":"nope"}"#);
        assert_eq!(describe(&Value::Null), "Anthropic gave no reason");
        assert_eq!(describe(&json!({"message": "bad key"})), "bad key");
    }
}

