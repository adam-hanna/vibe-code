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
//! - **Nothing says a tool call is complete**, only that the turn is. Fragments
//!   arrive inside `delta.tool_calls[]` keyed by their own index, the id and
//!   name appear on the first fragment only, and every call has to be held until
//!   `finish_reason`. Anthropic closes each call with its own event and can hand
//!   it over the moment it lands - which is why the two accumulators are two
//!   accumulators and not one with a flag.
//! - **A tool result is a message with a `tool` role, one per result.** Anthropic
//!   requires the exact opposite: every result for a turn in a single user
//!   message. Neither is a preference and both are a 400 if broken.

use serde_json::{json, Value};

use super::event::{PilotEvent, Usage};
use super::request::{Message, Turn};

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
        messages.push(match message {
            Message::User { content } => json!({ "role": "user", "content": content }),
            // **One message per result**, with a role of its own. Anthropic
            // requires the exact opposite - every result for a turn in a single
            // user message - and neither is a preference.
            Message::Tool { id, content, .. } => json!({
                "role": "tool",
                "tool_call_id": id,
                "content": content,
            }),
            Message::Assistant { content, calls } if calls.is_empty() => {
                json!({ "role": "assistant", "content": content })
            }
            Message::Assistant { content, calls } => json!({
                "role": "assistant",
                // Null rather than "" when the turn was only tool calls. The API
                // takes either, but an empty string is a thing the model said
                // and null is the absence of one.
                "content": if content.is_empty() { Value::Null } else { json!(content) },
                "tool_calls": calls.iter().map(|c| json!({
                    "id": c.id,
                    "type": "function",
                    "function": {
                        "name": c.name,
                        // A **string**, not an object. Anthropic takes the
                        // parsed value; this vendor takes the JSON text of it,
                        // which is also how it streams them out.
                        "arguments": c.input.to_string(),
                    },
                })).collect::<Vec<_>>(),
            }),
        });
    }
    let mut body = json!({
        "model": turn.model,
        "max_completion_tokens": turn.max_tokens,
        "stream": true,
        "stream_options": { "include_usage": true },
        "messages": messages,
    });
    // Omitted when there are none, for the reason the other adapter omits it:
    // while this build declares nothing it should send what it always sent.
    if !turn.tools.is_empty() {
        body["tools"] = json!(turn
            .tools
            .iter()
            .map(|t| json!({
                // The envelope this vendor wraps every tool in. Anthropic has
                // no equivalent, and calls the schema `input_schema` besides.
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.input_schema,
                },
            }))
            .collect::<Vec<_>>());
    }
    body
}

pub fn headers(key: &str) -> [(&'static str, String); 2] {
    [
        ("content-type", "application/json".to_string()),
        ("authorization", format!("Bearer {key}")),
    ]
}

/// A tool call being assembled out of chunks.
#[derive(Default)]
struct Partial {
    /// Sent once, on the fragment that opens the call, and never repeated.
    id: String,
    name: String,
    arguments: String,
}

/// What has to be remembered between chunks.
///
/// **Nothing about this matches the other adapter.** There, a call opens and
/// closes with its own events and the arguments arrive keyed by a content-block
/// index. Here, every fragment rides inside a `delta.tool_calls[]` entry keyed by
/// its own index, the id and name appear only on the first fragment, and nothing
/// says a call is complete until `finish_reason` ends the whole turn. Two
/// mechanisms, and a shared one would have had to pick a side.
#[derive(Default)]
pub struct State {
    /// Whether the turn has been opened. Held here rather than passed in, so
    /// the caller does not have to reason about which chunk was first.
    started: bool,
    calls: std::collections::BTreeMap<u64, Partial>,
}

/// What a single event did to the turn.
pub fn fold(turn: u64, data: &str, state: &mut State) -> Vec<PilotEvent> {
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
    if !state.started {
        state.started = true;
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

    // Tool-call fragments. Each carries the index of the call it belongs to;
    // the id and the name arrive only on the first fragment of each, and every
    // fragment after that carries arguments alone.
    if let Some(fragments) = choice["delta"]["tool_calls"].as_array() {
        for fragment in fragments {
            let Some(index) = fragment["index"].as_u64() else {
                // Without the index there is nothing to attribute this to.
                // Refusing is right: assembling it into whichever call happened
                // to be open would build arguments the model did not write.
                return vec![PilotEvent::Failed {
                    turn,
                    message: "OpenAI sent a tool-call fragment with no index".to_string(),
                }];
            };
            let partial = state.calls.entry(index).or_default();
            if let Some(id) = fragment["id"].as_str() {
                partial.id = id.to_string();
            }
            if let Some(name) = fragment["function"]["name"].as_str() {
                partial.name = name.to_string();
            }
            if let Some(arguments) = fragment["function"]["arguments"].as_str() {
                partial.arguments.push_str(arguments);
            }
        }
    }

    let usage = usage_of(&value["usage"]);
    if !usage.is_empty() {
        out.push(PilotEvent::Spent { turn, usage });
    }

    if let Some(stop) = choice["finish_reason"].as_str() {
        // **Every call is emitted here**, because nothing in this stream says a
        // single call is finished - only that the turn is. Anthropic closes each
        // one with its own event and can hand it over the moment it lands; this
        // vendor cannot, and pretending otherwise would mean guessing that a
        // call with parseable arguments must be complete.
        //
        // Before `Ended`, so a consumer that stops at the first terminal event
        // has already been told what was asked for.
        for (_, partial) in std::mem::take(&mut state.calls) {
            out.push(PilotEvent::ToolCall {
                turn,
                id: partial.id,
                name: partial.name,
                arguments: partial.arguments,
            });
        }
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
    use crate::pilot::request::{AssistantCall, Message, Tool};

    fn turn() -> Turn {
        Turn {
            provider: Provider::Openai,
            model: "gpt-5".into(),
            system: Some("be brief".into()),
            messages: vec![Message::User {
                content: "hello".into(),
            }],
            tools: vec![],
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

    /// One chunk, into a state nothing else has touched.
    fn fold1(data: &str) -> Vec<PilotEvent> {
        fold(1, data, &mut State::default())
    }

    /// A state whose turn is already open.
    ///
    /// Most cases are about a chunk in the middle of a reply, and a fresh state
    /// would have them assert a `Started` they are not testing.
    fn ongoing() -> State {
        State {
            started: true,
            ..State::default()
        }
    }

    #[test]
    fn the_first_chunk_starts_the_turn_and_the_rest_do_not() {
        // OpenAI has no opening event: the model name is on every chunk, so the
        // adapter remembers whether it has already opened the turn. That moved
        // from the caller into `State` in #144, because the same state now has
        // to hold half-assembled tool calls anyway.
        let chunk = r#"{"id":"c1","object":"chat.completion.chunk","model":"gpt-5-2026-04-01","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}"#;
        let mut state = State::default();
        assert_eq!(
            fold(1, chunk, &mut state),
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
            fold(1, chunk, &mut state),
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
            &mut ongoing(),
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
            &mut ongoing(),
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
            &mut ongoing(),
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
        assert!(fold1(DONE).is_empty());
        assert!(fold1(" [DONE] ").is_empty());
    }

    #[test]
    fn an_error_object_on_a_200_stream_is_a_failure() {
        assert_eq!(
            fold(
                1,
                r#"{"error":{"code":"rate_limit_exceeded","message":"Rate limit reached"}}"#,
                &mut ongoing()
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
            &mut ongoing()
        )
        .is_empty());
    }

    #[test]
    fn a_payload_that_is_not_json_is_reported() {
        let events = fold1("<html>502 Bad Gateway</html>");
        assert!(matches!(events.as_slice(), [PilotEvent::Failed { .. }]));
    }

    #[test]
    fn an_error_shape_this_version_does_not_know_is_reported_as_itself() {
        assert_eq!(describe(&json!({"detail": "nope"})), r#"{"detail":"nope"}"#);
        assert_eq!(describe(&Value::Null), "OpenAI gave no reason");
    }

    #[test]
    fn a_tool_call_is_assembled_out_of_chunks_and_held_until_the_turn_ends() {
        // Recorded from a real stream. The id and the name arrive on the first
        // fragment only; every fragment after it carries arguments alone; and
        // **nothing says the call is finished** until `finish_reason` ends the
        // whole turn - which is the difference from Anthropic, where each call
        // closes with an event of its own.
        let mut state = ongoing();
        let mut events = Vec::new();
        for chunk in [
            r#"{"choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"start_run","arguments":""}}]},"finish_reason":null}]}"#,
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"task\":"}}]},"finish_reason":null}]}"#,
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \"fix #7\"}"}}]},"finish_reason":null}]}"#,
        ] {
            events.extend(fold(1, chunk, &mut state));
        }
        assert!(events.is_empty(), "nothing is emitted until the turn ends");

        let events = fold(
            1,
            r#"{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
            &mut state,
        );
        assert_eq!(
            events,
            vec![
                PilotEvent::ToolCall {
                    turn: 1,
                    id: "call_abc".into(),
                    name: "start_run".into(),
                    arguments: r#"{"task": "fix #7"}"#.into(),
                },
                // The call comes BEFORE the ending, so a consumer that stops at
                // the first terminal event has already been told what was asked
                // for.
                PilotEvent::Ended {
                    turn: 1,
                    stop: Some("tool_calls".into())
                },
            ]
        );
    }

    #[test]
    fn two_calls_in_one_turn_keep_their_own_arguments() {
        // Keyed by the fragment's own index, which is what makes interleaved
        // fragments reassemble correctly.
        let mut state = ongoing();
        for chunk in [
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_A","function":{"name":"first","arguments":""}}]}}]}"#,
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_B","function":{"name":"second","arguments":""}}]}}]}"#,
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\"b\":2}"}}]}}]}"#,
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"a\":1}"}}]}}]}"#,
        ] {
            fold(1, chunk, &mut state);
        }
        let events = fold(
            1,
            r#"{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
            &mut state,
        );
        assert_eq!(
            &events[..2],
            &[
                PilotEvent::ToolCall {
                    turn: 1,
                    id: "call_A".into(),
                    name: "first".into(),
                    arguments: r#"{"a":1}"#.into(),
                },
                PilotEvent::ToolCall {
                    turn: 1,
                    id: "call_B".into(),
                    name: "second".into(),
                    arguments: r#"{"b":2}"#.into(),
                },
            ]
        );
    }

    #[test]
    fn a_fragment_with_no_index_is_refused_rather_than_guessed_at() {
        // Assembling it into whichever call happened to be open would build
        // arguments the model did not write.
        let events = fold(
            1,
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"{}"}}]}}]}"#,
            &mut ongoing(),
        );
        assert!(matches!(events.as_slice(), [PilotEvent::Failed { .. }]));
    }

    #[test]
    fn a_turn_that_only_called_tools_still_reports_its_text_as_absent() {
        // The opening chunk of a tool-calling turn carries `content: null`, not
        // an empty string. Emitting a text event for it would put a zero-length
        // append in the transcript.
        let events = fold(
            1,
            r#"{"choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"c","function":{"name":"n","arguments":""}}]}}]}"#,
            &mut ongoing(),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn a_declared_tool_is_wrapped_in_this_vendors_envelope() {
        // `type: "function"`, a nested `function` object, and the schema called
        // `parameters`. Anthropic takes a flat object with `input_schema` - so
        // the same declaration produces two genuinely different requests.
        let mut t = turn();
        t.tools.push(Tool {
            name: "start_run".into(),
            description: "Start a run from a brief".into(),
            input_schema: json!({"type": "object", "properties": {"task": {"type": "string"}}}),
        });
        let body = body(&t);
        let tools = body["tools"].as_array().expect("tools");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], json!("function"));
        assert_eq!(tools[0]["function"]["name"], json!("start_run"));
        assert_eq!(tools[0]["function"]["parameters"]["type"], json!("object"));
        assert!(tools[0]["function"].get("input_schema").is_none());
    }

    #[test]
    fn a_request_with_no_tools_does_not_mention_tools_at_all() {
        assert!(body(&turn()).get("tools").is_none());
    }

    #[test]
    fn each_result_is_its_own_message_with_a_role_of_its_own() {
        // **The opposite of Anthropic's rule**, and both are a 400 if broken:
        // that vendor requires every result for a turn in one user message.
        let mut t = turn();
        t.messages.push(Message::Assistant {
            content: String::new(),
            calls: vec![
                AssistantCall {
                    id: "call_A".into(),
                    name: "first".into(),
                    input: json!({"a": 1}),
                },
                AssistantCall {
                    id: "call_B".into(),
                    name: "second".into(),
                    input: json!({}),
                },
            ],
        });
        t.messages.push(Message::Tool {
            id: "call_A".into(),
            name: "first".into(),
            content: "a".into(),
        });
        t.messages.push(Message::Tool {
            id: "call_B".into(),
            name: "second".into(),
            content: "b".into(),
        });

        let body = body(&t);
        let messages = body["messages"].as_array().expect("messages");
        // system, hello, the assistant turn, and one message per result.
        assert_eq!(messages.len(), 5);
        assert_eq!(messages[2]["role"], json!("assistant"));
        // Null, not "": the turn was only calls, and an empty string is a thing
        // the model said where null is the absence of one.
        assert!(messages[2]["content"].is_null());
        assert_eq!(messages[2]["tool_calls"][0]["id"], json!("call_A"));
        assert_eq!(messages[2]["tool_calls"][0]["type"], json!("function"));
        // A **string**, not an object - which is what this vendor takes and
        // what Anthropic does not.
        assert_eq!(
            messages[2]["tool_calls"][0]["function"]["arguments"],
            json!(r#"{"a":1}"#)
        );
        assert_eq!(messages[3], json!({"role":"tool","tool_call_id":"call_A","content":"a"}));
        assert_eq!(messages[4], json!({"role":"tool","tool_call_id":"call_B","content":"b"}));
    }

    #[test]
    fn a_conversation_with_no_tools_is_shaped_exactly_as_it_was_before() {
        let mut t = turn();
        t.messages.push(Message::Assistant {
            content: "Hello.".into(),
            calls: vec![],
        });
        let body = body(&t);
        assert_eq!(body["messages"][2], json!({"role":"assistant","content":"Hello."}));
        assert!(body["messages"][2].get("tool_calls").is_none());
    }
}
