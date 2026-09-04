//! The one vocabulary, and the two shapes a turn is described in.
//!
//! Both adapters produce these and nothing above them knows which vendor
//! answered - the same relationship `src/claude.ts` and `src/codex.ts` have to
//! the loop.
//!
//! **Every count is an `Option` and every absent one stays absent.** This is the
//! repo's one recurring rule applied to a place it would be very easy to break:
//! the two vendors do not report the same numbers, they do not report them at
//! the same time, and one of them reports several of them not at all. Filling a
//! zero in for a figure a vendor never sent would produce a number nobody
//! measured, in the pane where a user reads what their pilot cost them.

use serde::Serialize;

use crate::keys::Provider;

/// The Tauri event every one of these is emitted on.
pub const EVENT: &str = "pilot://event";

/// What a turn spent, exactly as far as the vendor said.
///
/// | field | Anthropic | OpenAI |
/// |---|---|---|
/// | `input` | `usage.input_tokens` | `usage.prompt_tokens` |
/// | `output` | `usage.output_tokens` | `usage.completion_tokens` |
/// | `cache_read` | `usage.cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` |
/// | `cache_write` | `usage.cache_creation_input_tokens` | **never** |
///
/// The last row is the whole reason this struct is six `Option`s rather than
/// four numbers. OpenAI's API has no concept of a cache *write* charge to
/// report, so `cache_write` is `None` for every OpenAI turn - and `None` here
/// means "this vendor did not say", which is a different fact from zero and is
/// rendered differently.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Usage {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
}

impl Usage {
    /// True when the vendor said nothing at all. Used to decide whether an
    /// event is worth emitting, never to substitute a value.
    pub fn is_empty(&self) -> bool {
        self == &Usage::default()
    }

    /// Take whatever the other one actually carried.
    ///
    /// Needed because Anthropic reports a turn's usage in **two** events -
    /// input and cache counts on `message_start`, output on `message_delta` -
    /// so a turn's total is assembled rather than received. A `None` never
    /// overwrites a `Some`: a later event that omits a field has not retracted
    /// it.
    pub fn merge(&mut self, other: &Usage) {
        if other.input.is_some() {
            self.input = other.input;
        }
        if other.output.is_some() {
            self.output = other.output;
        }
        if other.cache_read.is_some() {
            self.cache_read = other.cache_read;
        }
        if other.cache_write.is_some() {
            self.cache_write = other.cache_write;
        }
    }
}

/// Everything the pilot pane is ever told about a turn.
///
/// Tagged by `kind`, and flat, because the webview's rule is the cockpit's:
/// draw what a frame carried and re-derive nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PilotEvent {
    /// The request was accepted and the stream has begun.
    Started {
        turn: u64,
        provider: Provider,
        /// The model the vendor says it is answering with, which is not always
        /// the one that was asked for - an alias resolves to a dated version.
        model: Option<String>,
    },
    /// A piece of the reply. Deltas, never a running total: the pane appends.
    Text { turn: u64, delta: String },
    /// What the vendor has said this turn cost so far.
    Spent { turn: u64, usage: Usage },
    /// The stream ended normally.
    Ended {
        turn: u64,
        /// The vendor's own stop reason, unmapped. `end_turn` and `stop` are
        /// different words for the same thing and neither is translated into
        /// the other, because a shared spelling would be a shared meaning we
        /// have not established.
        stop: Option<String>,
    },
    /// The stream ended badly. Terminal, like `Ended`.
    Failed { turn: u64, message: String },
    /// The user stopped it. Terminal, and deliberately not a failure.
    Cancelled { turn: u64 },
}

impl PilotEvent {
    /// Whether nothing further will arrive for this turn.
    pub fn is_final(&self) -> bool {
        matches!(
            self,
            PilotEvent::Ended { .. } | PilotEvent::Failed { .. } | PilotEvent::Cancelled { .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merging_never_lets_an_absence_overwrite_a_number() {
        // Anthropic's two-event usage. `message_delta` carries only the output
        // count; treating its silence about input as a retraction would lose
        // the input figure on every single turn.
        let mut total = Usage {
            input: Some(120),
            cache_read: Some(4000),
            ..Usage::default()
        };
        total.merge(&Usage {
            output: Some(38),
            ..Usage::default()
        });
        assert_eq!(
            total,
            Usage {
                input: Some(120),
                output: Some(38),
                cache_read: Some(4000),
                cache_write: None,
            }
        );
    }

    #[test]
    fn a_zero_a_vendor_actually_sent_is_kept() {
        // The other direction, and the one that makes `Option` worth the
        // trouble: a reported zero is a measurement. Only an absent field is an
        // absence.
        let mut total = Usage::default();
        total.merge(&Usage {
            cache_read: Some(0),
            ..Usage::default()
        });
        assert_eq!(total.cache_read, Some(0));
        assert!(!total.is_empty());
    }

    #[test]
    fn an_absent_count_serialises_as_null_and_never_as_zero() {
        let json = serde_json::to_value(Usage {
            input: Some(10),
            ..Usage::default()
        })
        .expect("serialises");
        assert_eq!(json["input"], serde_json::json!(10));
        assert!(json["cache_write"].is_null(), "absent is null, not 0");
    }

    #[test]
    fn every_terminal_event_says_it_is_terminal() {
        // The pane stops its spinner on this and nothing else, so a new
        // terminal variant that forgot to be listed would hang the UI forever.
        assert!(PilotEvent::Ended { turn: 1, stop: None }.is_final());
        assert!(PilotEvent::Failed {
            turn: 1,
            message: "no".into()
        }
        .is_final());
        assert!(PilotEvent::Cancelled { turn: 1 }.is_final());
        assert!(!PilotEvent::Text {
            turn: 1,
            delta: "hi".into()
        }
        .is_final());
        assert!(!PilotEvent::Spent {
            turn: 1,
            usage: Usage::default()
        }
        .is_final());
    }

    #[test]
    fn the_wire_tag_is_the_kind() {
        let json = serde_json::to_value(PilotEvent::Text {
            turn: 3,
            delta: "hello".into(),
        })
        .expect("serialises");
        assert_eq!(json["kind"], serde_json::json!("text"));
        assert_eq!(json["turn"], serde_json::json!(3));
        assert_eq!(json["delta"], serde_json::json!("hello"));
    }
}
