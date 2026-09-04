//! What the window may ask the pilot for.
//!
//! Everything here crosses the IPC boundary, so everything here is a closed
//! shape serde will refuse rather than repair. **What is not here matters as
//! much as what is**: no URL, no headers, no key, and no provider that is not
//! one of the two. The window says what to ask and which vendor to ask; the
//! endpoint and the credential are this crate's, and neither is nameable from a
//! page.

use serde::Deserialize;

use crate::keys::Provider;

/// A tool the pilot is allowed to ask for, as declared to the vendor.
///
/// **This crate declares nothing.** The list arrives from the window, which is
/// also what executes a call - so a tool cannot exist without an implementation,
/// and the surface is exactly what `app/src/pilot` says it is (#144). Rust
/// forwards the declaration and parses the request; it never decides what a tool
/// means, for the same reason the relay never decides what a frame means.
///
/// `input_schema` is passed through verbatim. Validating a JSON Schema here
/// would be a second definition of the tool's contract, and the one that matters
/// is the vendor's.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// A call the model asked for, echoed back so it can be answered.
///
/// `input` is a parsed value rather than the string the vendor streamed, because
/// the window had to parse it to execute the call - and re-parsing it here would
/// be two readings of the same JSON with two chances to disagree.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct AssistantCall {
    /// The vendor's own id. Opaque, and it must come back unchanged.
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// One message in the conversation.
///
/// Tagged by `role`, so `{"role":"user","content":"hi"}` reads exactly as it did
/// before tools existed. **`system` is deliberately not a variant**: it is
/// `Turn::system`, because the two vendors want it in different places, and a
/// page must not be able to smuggle one in as a message on the vendor that takes
/// it that way.
///
/// `Tool` IS a variant, and that is the change #144 makes: a tool result is a
/// message, and both vendors say so - though they disagree about which role it
/// carries, which is `body()`'s problem in each adapter and not this type's.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum Message {
    User {
        content: String,
    },
    Assistant {
        /// What it said. Empty when the turn was nothing but tool calls, which
        /// is common and is not an error.
        #[serde(default)]
        content: String,
        #[serde(default)]
        calls: Vec<AssistantCall>,
    },
    /// The answer to one call. `id` is the vendor's, echoed back unchanged.
    Tool {
        id: String,
        /// Which tool answered. Carried for the transcript rather than for the
        /// vendors - neither reads it back - and it is what makes a recorded
        /// conversation legible without cross-referencing ids.
        name: String,
        content: String,
    },
}

/// A ceiling this build will not exceed, whatever it is asked for.
///
/// Not a tuned number and not pretending to be: it is a backstop against a bug
/// or a compromised page asking for a reply that costs a fortune. The pilot's
/// real accounting is #145's, and it is the issue with the sharpest constraint
/// in this milestone - so nothing here should look like it has settled the
/// question.
pub const MAX_TOKENS_CEILING: u32 = 32_000;

/// The default when the window names none.
pub const MAX_TOKENS_DEFAULT: u32 = 4_096;

/// One turn's request.
#[derive(Clone, Debug, Deserialize)]
pub struct Turn {
    pub provider: Provider,
    /// Named by the caller, and **not defaulted here**.
    ///
    /// A default would be a model name compiled into this crate, going stale on
    /// the vendor's schedule rather than ours, and silently answering with
    /// something nobody chose. The window knows what it offered; it says so.
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<Message>,
    /// What the model may ask for, declared by the window (#144).
    ///
    /// **Empty on every request this build makes**, and that is the point of
    /// shipping it this way: both adapters can now declare tools and read a call
    /// back out of a stream, and until something puts a tool in this list not one
    /// byte of a pilot turn changes. The table and its executor are the next
    /// step; this is the plumbing under them.
    #[serde(default)]
    pub tools: Vec<Tool>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
}

fn default_max_tokens() -> u32 {
    MAX_TOKENS_DEFAULT
}

impl Turn {
    /// Refuse what cannot be asked, before a socket is opened or a key is read.
    ///
    /// **Refuse, never repair** - the rule the host protocol already runs on. A
    /// request with no messages is not silently turned into a request with one,
    /// and a ceiling asked for above what this build allows is refused rather
    /// than clamped: quietly answering a different question than the one asked
    /// is how a caller comes to believe something untrue about what it got.
    pub fn check(&self) -> Result<(), String> {
        if self.model.trim().is_empty() {
            return Err("no model was named".into());
        }
        if self.messages.is_empty() {
            return Err("there is nothing to send".into());
        }
        for message in &self.messages {
            match message {
                Message::User { content } | Message::Tool { content, .. } => {
                    if content.trim().is_empty() {
                        return Err("a message is empty".into());
                    }
                }
                // An assistant turn that was nothing but tool calls carries no
                // text, and that is normal rather than empty. What would be
                // wrong is a turn that said nothing AND asked for nothing.
                Message::Assistant { content, calls } => {
                    if content.trim().is_empty() && calls.is_empty() {
                        return Err("an assistant message says nothing and asks for nothing".into());
                    }
                    if calls.iter().any(|c| c.id.trim().is_empty() || c.name.trim().is_empty()) {
                        return Err("a tool call has no id or no name".into());
                    }
                }
            }
        }
        // Every declared tool needs a name the model can ask for. Anthropic
        // refuses a nameless tool with a 400 and OpenAI refuses it differently;
        // refusing it here costs nothing and says which of ours was wrong.
        if self.tools.iter().any(|t| t.name.trim().is_empty()) {
            return Err("a declared tool has no name".into());
        }
        if self.max_tokens == 0 {
            return Err("max_tokens is zero, so there is no reply to ask for".into());
        }
        if self.max_tokens > MAX_TOKENS_CEILING {
            return Err(format!(
                "max_tokens {} is above this build's ceiling of {MAX_TOKENS_CEILING}",
                self.max_tokens
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn() -> Turn {
        Turn {
            provider: Provider::Anthropic,
            model: "claude-opus-5".into(),
            system: None,
            messages: vec![Message::User {
                content: "hello".into(),
            }],
            tools: vec![],
            max_tokens: MAX_TOKENS_DEFAULT,
        }
    }

    #[test]
    fn a_usable_request_is_accepted() {
        assert!(turn().check().is_ok());
    }

    #[test]
    fn nothing_to_send_is_refused_before_a_socket_opens() {
        let mut t = turn();
        t.messages.clear();
        assert!(t.check().is_err());
    }

    #[test]
    fn an_empty_message_is_refused_rather_than_dropped() {
        // Dropping it would send a request the caller did not write, and the
        // vendor would answer the wrong conversation.
        let mut t = turn();
        t.messages[0] = Message::User {
            content: "   ".into(),
        };
        assert!(t.check().is_err());
    }

    #[test]
    fn an_assistant_turn_that_was_only_tool_calls_is_not_empty() {
        // The common shape: the model says nothing and asks for two things. A
        // check that demanded text would refuse every tool-using conversation
        // on its second turn.
        let mut t = turn();
        t.messages.push(Message::Assistant {
            content: String::new(),
            calls: vec![AssistantCall {
                id: "toolu_1".into(),
                name: "start_run".into(),
                input: serde_json::json!({"task": "x"}),
            }],
        });
        t.messages.push(Message::Tool {
            id: "toolu_1".into(),
            name: "start_run".into(),
            content: "started".into(),
        });
        assert!(t.check().is_ok());
    }

    #[test]
    fn an_assistant_turn_that_said_nothing_and_asked_for_nothing_is_refused() {
        let mut t = turn();
        t.messages.push(Message::Assistant {
            content: "  ".into(),
            calls: vec![],
        });
        assert!(t.check().is_err());
    }

    #[test]
    fn a_call_with_no_id_is_refused_because_the_result_could_never_reach_it() {
        // The id is the vendor's and it is the only thing that pairs a result
        // with its call. Both APIs reject a mismatch with a 400 that does not
        // say which pair was wrong.
        let mut t = turn();
        t.messages.push(Message::Assistant {
            content: String::new(),
            calls: vec![AssistantCall {
                id: "  ".into(),
                name: "start_run".into(),
                input: serde_json::Value::Null,
            }],
        });
        assert!(t.check().is_err());
    }

    #[test]
    fn an_empty_tool_result_is_refused_like_any_other_empty_message() {
        let mut t = turn();
        t.messages.push(Message::Tool {
            id: "toolu_1".into(),
            name: "start_run".into(),
            content: "".into(),
        });
        assert!(t.check().is_err());
    }

    #[test]
    fn a_nameless_tool_is_refused_here_rather_than_by_a_400() {
        let mut t = turn();
        t.tools.push(Tool {
            name: " ".into(),
            description: "d".into(),
            input_schema: serde_json::json!({"type": "object"}),
        });
        assert!(t.check().is_err());
    }

    #[test]
    fn a_request_that_declares_no_tools_is_what_this_build_sends() {
        // The groundwork claim, pinned: `tools` defaults to empty, so every
        // request this build makes is byte-identical to one made before #144.
        let turn: Turn = serde_json::from_str(
            r#"{"provider":"openai","model":"gpt-5","messages":[{"role":"user","content":"hi"}]}"#,
        )
        .expect("parses");
        assert!(turn.tools.is_empty());
    }

    #[test]
    fn a_ceiling_that_is_too_high_is_refused_and_not_clamped() {
        // Refuse, never repair. Clamping answers a cheaper question than the
        // one asked and says nothing about having done so.
        let mut t = turn();
        t.max_tokens = MAX_TOKENS_CEILING + 1;
        let why = t.check().expect_err("refused");
        assert!(why.contains("ceiling"), "{why}");
        assert!(why.contains(&MAX_TOKENS_CEILING.to_string()), "{why}");
    }

    #[test]
    fn zero_tokens_is_refused_because_it_asks_for_no_reply() {
        let mut t = turn();
        t.max_tokens = 0;
        assert!(t.check().is_err());
    }

    #[test]
    fn a_model_is_never_defaulted() {
        // A default would be a model name compiled into this crate, going stale
        // on the vendor's schedule and answering with something nobody chose.
        let missing = serde_json::from_str::<Turn>(
            r#"{"provider":"anthropic","messages":[{"role":"user","content":"hi"}]}"#,
        );
        assert!(missing.is_err(), "a request with no model must be refused");
    }

    #[test]
    fn max_tokens_has_a_default_because_a_ceiling_is_not_a_question() {
        let turn: Turn = serde_json::from_str(
            r#"{"provider":"openai","model":"gpt-5","messages":[{"role":"user","content":"hi"}]}"#,
        )
        .expect("parses");
        assert_eq!(turn.max_tokens, MAX_TOKENS_DEFAULT);
        assert_eq!(turn.system, None);
    }

    #[test]
    fn a_role_is_a_closed_set_at_the_ipc_boundary() {
        // Three roles now, not two. `tool` became legal in #144 because a tool
        // result IS a message and both vendors say so - but `system` is still
        // refused, and that half is the one that matters: it is `Turn::system`,
        // because the two vendors want it in different places, and a page must
        // not be able to smuggle one in as a message on the vendor that takes it
        // that way.
        let parse = |s: &str| serde_json::from_str::<Message>(s);
        assert!(parse(r#"{"role":"user","content":"hi"}"#).is_ok());
        assert!(parse(r#"{"role":"assistant","content":"hi"}"#).is_ok());
        assert!(parse(r#"{"role":"tool","id":"t1","name":"n","content":"hi"}"#).is_ok());
        assert!(parse(r#"{"role":"system","content":"be brief"}"#).is_err());
        assert!(parse(r#"{"role":"developer","content":"hi"}"#).is_err());
    }

    #[test]
    fn a_message_from_before_tools_existed_reads_exactly_as_it_did() {
        // The shape the window has been sending since #143, unchanged. A tagged
        // enum was chosen over a new field precisely so this stayed true.
        assert_eq!(
            serde_json::from_str::<Message>(r#"{"role":"user","content":"hi"}"#).expect("parses"),
            Message::User {
                content: "hi".into()
            }
        );
    }

    #[test]
    fn an_assistant_message_needs_neither_field_to_parse() {
        // Both default, because a turn can be all text or all calls and neither
        // side should have to send an empty one to say so.
        assert_eq!(
            serde_json::from_str::<Message>(r#"{"role":"assistant","content":"hi"}"#)
                .expect("parses"),
            Message::Assistant {
                content: "hi".into(),
                calls: vec![]
            }
        );
    }

    #[test]
    fn a_provider_this_build_does_not_speak_to_is_refused() {
        assert!(serde_json::from_str::<Turn>(
            r#"{"provider":"gemini","model":"g","messages":[{"role":"user","content":"hi"}]}"#
        )
        .is_err());
    }
}
