//! What the window may ask the pilot for.
//!
//! Everything here crosses the IPC boundary, so everything here is a closed
//! shape serde will refuse rather than repair. **What is not here matters as
//! much as what is**: no URL, no headers, no key, and no provider that is not
//! one of the two. The window says what to ask and which vendor to ask; the
//! endpoint and the credential are this crate's, and neither is nameable from a
//! page.

use serde::{Deserialize, Serialize};

use crate::keys::Provider;

/// Who said a thing. Two values, because the system prompt is not one of them -
/// it is `Turn::system`, and each adapter puts it where its vendor wants it.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Message {
    pub role: Role,
    pub content: String,
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
        if self.messages.iter().any(|m| m.content.trim().is_empty()) {
            return Err("a message is empty".into());
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
            messages: vec![Message {
                role: Role::User,
                content: "hello".into(),
            }],
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
        t.messages[0].content = "   ".into();
        assert!(t.check().is_err());
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
        // `system` is deliberately not one: it is `Turn::system`, because the
        // two vendors want it in different places and a page must not be able
        // to smuggle one in as a message on the vendor that takes it that way.
        assert!(serde_json::from_str::<Role>("\"user\"").is_ok());
        assert!(serde_json::from_str::<Role>("\"assistant\"").is_ok());
        assert!(serde_json::from_str::<Role>("\"system\"").is_err());
        assert!(serde_json::from_str::<Role>("\"tool\"").is_err());
    }

    #[test]
    fn a_provider_this_build_does_not_speak_to_is_refused() {
        assert!(serde_json::from_str::<Turn>(
            r#"{"provider":"gemini","model":"g","messages":[{"role":"user","content":"hi"}]}"#
        )
        .is_err());
    }
}
