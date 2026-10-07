//! Server-sent events, which is the one thing the two vendors genuinely share.
//!
//! **This is wire format, not meaning.** Both APIs stream `text/event-stream`
//! and both frame it the same way, because both are implementing the same
//! specification - so parsing it twice would be two chances to get the same
//! thing wrong. What each `data:` payload *means* is entirely the adapter's,
//! and nothing in this file knows either vendor exists.
//!
//! That division is the line #143 draws. A shared parser for a shared format is
//! not the "general LLM abstraction" the issue refuses; a shared parser for the
//! two usage shapes would be.
//!
//! Only the fields either vendor sends are read. `id:` and `retry:` exist in the
//! specification and neither API uses them, so they are skipped as unrecognised
//! rather than parsed into fields nothing reads.

use std::io::{BufRead, BufReader, Read};

/// One dispatched event: its name, if the stream gave one, and its data.
pub struct Event<'a> {
    /// The `event:` line. Anthropic sends one on every event; OpenAI sends none.
    pub name: Option<&'a str>,
    /// Every `data:` line of the event, joined with newlines as the spec says.
    pub data: &'a str,
}

/// What the caller wants to happen next.
pub enum Flow {
    Continue,
    /// Stop reading. The connection is dropped, which is what cancels a turn.
    Stop,
}

/// Read a stream to its end, calling `on` once per dispatched event.
///
/// Errors are the reader's, never the parser's: a line this does not recognise
/// is skipped, because that is what the specification requires of a conforming
/// client and it is what lets a vendor add a field without breaking us. A
/// payload that is not the JSON an adapter expected is the *adapter's* to
/// report - it is the one that knows what it was expecting.
pub fn read<R: Read>(source: R, mut on: impl FnMut(Event<'_>) -> Flow) -> Result<(), String> {
    let mut reader = BufReader::new(source);
    let mut name: Option<String> = None;
    let mut data = String::new();
    let mut line = String::new();

    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|e| format!("the stream ended badly: {e}"))?;
        if read == 0 {
            break;
        }

        // Both \n and \r\n. The trailing \r is not part of the value and a
        // header value with one in it is the kind of thing that fails much
        // later, somewhere that cannot say why.
        let line = line.trim_end_matches('\n').trim_end_matches('\r');

        // A blank line dispatches whatever has accumulated. An event with no
        // data lines is not dispatched - the spec says so, and it is also what
        // keeps a stray blank line from producing a phantom empty event.
        if line.is_empty() {
            if !data.is_empty() {
                let flow = on(Event {
                    name: name.as_deref(),
                    data: &data,
                });
                if matches!(flow, Flow::Stop) {
                    return Ok(());
                }
            }
            name = None;
            data.clear();
            continue;
        }

        // A comment. Anthropic uses these as its keep-alive, so they arrive on
        // any turn that thinks for a while.
        if line.starts_with(':') {
            continue;
        }

        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            // A field with no colon is a field with an empty value.
            None => (line, ""),
        };

        match field {
            "event" => name = Some(value.to_string()),
            "data" => {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value);
            }
            // `id` and `retry` are in the spec and unused by both vendors, and
            // anything else is a field from a version newer than this one.
            _ => {}
        }
    }

    // A stream that ended without a final blank line still dispatches what it
    // had. Both vendors terminate properly; this is here because losing the last
    // event of a reply - which is the one carrying usage - to a missing newline
    // would be a very quiet bug.
    if !data.is_empty() {
        on(Event {
            name: name.as_deref(),
            data: &data,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Collect every event a stream dispatches, as `(name, data)`.
    fn all(stream: &str) -> Vec<(Option<String>, String)> {
        let mut seen = Vec::new();
        read(stream.as_bytes(), |event| {
            seen.push((event.name.map(str::to_string), event.data.to_string()));
            Flow::Continue
        })
        .expect("reads");
        seen
    }

    #[test]
    fn a_named_event_carries_its_name_and_its_data() {
        let seen = all("event: message_start\ndata: {\"a\":1}\n\n");
        assert_eq!(seen, vec![(Some("message_start".into()), "{\"a\":1}".into())]);
    }

    #[test]
    fn an_unnamed_event_is_still_an_event() {
        // OpenAI's shape: every event is a bare `data:` line with no `event:`.
        let seen = all("data: {\"a\":1}\n\ndata: [DONE]\n\n");
        assert_eq!(
            seen,
            vec![(None, "{\"a\":1}".into()), (None, "[DONE]".into())]
        );
    }

    #[test]
    fn several_data_lines_join_with_newlines() {
        // The specification's rule, and the reason data is accumulated rather
        // than overwritten. Neither vendor does this today, and a client that
        // took only the last line would fail the day one starts.
        let seen = all("data: {\ndata: \"a\": 1}\n\n");
        assert_eq!(seen, vec![(None, "{\n\"a\": 1}".into())]);
    }

    #[test]
    fn comments_and_blank_lines_dispatch_nothing() {
        // Anthropic's keep-alive is a comment, so this arrives on every turn
        // that thinks for more than a moment.
        assert_eq!(all(": ping\n\n\n: keep-alive\n\n"), vec![]);
    }

    #[test]
    fn carriage_returns_are_not_part_of_the_value() {
        let seen = all("event: ping\r\ndata: {\"type\":\"ping\"}\r\n\r\n");
        assert_eq!(seen, vec![(Some("ping".into()), "{\"type\":\"ping\"}".into())]);
    }

    #[test]
    fn a_field_with_no_space_after_the_colon_reads_the_same() {
        assert_eq!(all("data:{\"a\":1}\n\n"), vec![(None, "{\"a\":1}".into())]);
    }

    #[test]
    fn an_unterminated_final_event_is_still_dispatched() {
        // The last event of a reply is the one carrying usage. Dropping it for
        // want of a trailing newline would lose exactly the number that matters.
        assert_eq!(all("data: {\"a\":1}"), vec![(None, "{\"a\":1}".into())]);
    }

    #[test]
    fn unknown_fields_are_skipped_rather_than_refused() {
        // `id` and `retry` are in the spec, and a field from a newer version of
        // either API must not stop the stream.
        let seen = all("id: 7\nretry: 100\nsomething: new\ndata: {\"a\":1}\n\n");
        assert_eq!(seen, vec![(None, "{\"a\":1}".into())]);
    }

    #[test]
    fn stopping_ends_the_read_immediately() {
        // What cancelling a turn does: the caller says stop, the connection is
        // dropped, and nothing after it is parsed.
        let mut count = 0;
        read(
            "data: 1\n\ndata: 2\n\ndata: 3\n\n".as_bytes(),
            |_| {
                count += 1;
                Flow::Stop
            },
        )
        .expect("reads");
        assert_eq!(count, 1);
    }

    #[test]
    fn an_event_name_does_not_leak_into_the_next_event() {
        // The reset that a stream of mixed named and unnamed events depends on.
        let seen = all("event: named\ndata: 1\n\ndata: 2\n\n");
        assert_eq!(seen, vec![(Some("named".into()), "1".into()), (None, "2".into())]);
    }
}
