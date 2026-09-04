//! The pilot's clients: the second half of #143, and the first socket this
//! product has ever opened.
//!
//! ## Why it is here and not in `src/`
//!
//! > There is no server, no daemon and no network code of its own - every
//! > external call is a child process.
//!
//! That has been true of the core since the first commit and it is why the tool
//! inherits whatever you are logged into, why there is no key to leak, and why
//! `npm audit` has nothing to say about a package with zero runtime
//! dependencies. **All of this lives in `app/` so all of that stays true.** A
//! user who installs `@adam-hanna/vibe-code` and runs `vibe run` is on the same
//! code they were on before this landed.
//!
//! ## Why it is in Rust and not in the webview
//!
//! Because the key is here. `keys::read` is `pub(crate)` and there is no command
//! that returns a credential, so the only place a request can be made from is
//! the only place a key can be read from. The CSP says the same thing from the
//! other side - `connect-src 'self' ipc: http://ipc.localhost` means the page
//! could not reach a vendor even holding one. Two mechanisms, one answer.
//!
//! ## Two adapters, and not an abstraction over them
//!
//! `anthropic.rs` and `openai.rs` each turn one vendor's stream into
//! `PilotEvent`, and each is written to say what its vendor actually does. The
//! differences are real - a system prompt is a field for one and a message for
//! the other; usage arrives twice for one and once for the other; **one of them
//! has no cache-write count to report at all** - and every one of them survives
//! into the vocabulary as an absent field rather than a smoothed one. An
//! abstraction that hid the last of those would have to invent the number it
//! hid, which is the same reason Codex cost is unreported.
//!
//! `sse.rs` is shared, and that is not a contradiction: it parses a wire format
//! both vendors implement to the same specification. Sharing a *format* is not
//! sharing a *meaning*.
//!
//! ## Threads, not an async runtime
//!
//! One blocking request per turn on its own thread, reading the stream a line at
//! a time - the same shape `host.rs` already uses for the host's stdout. This
//! crate is transport plus OS and has no runtime of its own; adding one to make
//! two HTTP calls would be a large amount of machinery for no behaviour.
//!
//! ## What is deliberately not here
//!
//! **Tools (#144) and token accounting (#145).** A turn here is: send a
//! conversation, stream a reply, report what the vendor said it cost. Nothing
//! reaches the loop, nothing is charged through `src/charge.ts`, and no tool can
//! be called. Those are separate issues because they have separate constraints,
//! and the sharpest of them is that a pilot's dollars are real money where a
//! run's are not.

pub mod anthropic;
pub mod event;
pub mod openai;
pub mod request;
pub mod sse;

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::keys::{self, Provider};
use event::{PilotEvent, EVENT};
use request::Turn;

/// How long a turn may take in total.
///
/// Generous, because a long reply from a reasoning model legitimately takes
/// minutes and a pilot cut off mid-sentence is worse than one that is slow. It
/// exists so a wedged connection cannot hold a thread and a spinner for the life
/// of the app - not to police the model's pace.
const TURN_TIMEOUT: Duration = Duration::from_secs(600);

/// How long to wait for the connection itself.
///
/// Short, and separate from the one above on purpose: a vendor that cannot be
/// reached is a different failure from one that is thinking, and reporting it
/// after ten minutes of apparent progress would be a lie about what happened.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// How much of a failed response is read back before it is reported.
///
/// An error body is a sentence; anything past this is a vendor's HTML error page
/// and quoting a megabyte of it into a pane helps nobody.
const MAX_ERROR_BYTES: u64 = 16 * 1024;

/// The turns in flight, and the next identity to hand out.
#[derive(Default)]
pub struct Pilot {
    next: AtomicU64,
    /// One flag per running turn, set by `pilot_cancel` and read between events.
    ///
    /// The flag rather than killing a thread: there is no safe way to kill one,
    /// and there does not need to be. A cancelled turn stops at the next event,
    /// drops the connection, and says it was cancelled - which takes as long as
    /// one token.
    running: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

impl Pilot {
    fn begin(&self) -> Result<(u64, Arc<AtomicBool>), String> {
        let turn = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = Arc::new(AtomicBool::new(false));
        self.running
            .lock()
            .map_err(|_| "the pilot lock was poisoned by a panic".to_string())?
            .insert(turn, cancel.clone());
        Ok((turn, cancel))
    }

    fn finish(&self, turn: u64) {
        if let Ok(mut running) = self.running.lock() {
            running.remove(&turn);
        }
    }

    /// Ask a turn to stop. Unknown ids are refused rather than ignored.
    fn cancel(&self, turn: u64) -> Result<(), String> {
        let running = self
            .running
            .lock()
            .map_err(|_| "the pilot lock was poisoned by a panic".to_string())?;
        match running.get(&turn) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                Ok(())
            }
            // Said rather than swallowed. A window cancelling a turn that is
            // already over should find that out, not watch a button do nothing.
            None => Err(format!("turn {turn} is not running")),
        }
    }
}

/// Everything one turn needs, resolved before the thread starts.
struct Wire {
    url: &'static str,
    headers: Vec<(&'static str, String)>,
    body: serde_json::Value,
}

/// The HTTP client, configured once and built per turn.
///
/// Roots come from `webpki-roots` rather than the OS trust store, which is the
/// portable choice and the honest limitation: **a machine behind a TLS-
/// intercepting proxy will not be able to reach either vendor**, and it will say
/// so as a connection failure rather than working by accident. The OS store
/// would handle that case and brings a much larger dependency; it is a change
/// worth making when somebody actually hits it, not before.
fn agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            // The vendor's own error body is worth far more than "HTTP 400", and
            // `true` here turns a 400 into an `Error` that has thrown the body
            // away - which is exactly the sentence that says whether the key is
            // wrong or the request is.
            .http_status_as_error(false)
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_global(Some(TURN_TIMEOUT))
            .build(),
    )
}

/// Build the request for whichever vendor this is.
///
/// The one place the two adapters are chosen between, and it is a `match` rather
/// than a trait: two arms are not a plugin system, and a trait here would be the
/// beginning of the abstraction this issue refuses.
fn wire(turn: &Turn, key: &str) -> Wire {
    match turn.provider {
        Provider::Anthropic => Wire {
            url: anthropic::URL,
            headers: anthropic::headers(key).to_vec(),
            body: anthropic::body(turn),
        },
        Provider::Openai => Wire {
            url: openai::URL,
            headers: openai::headers(key).to_vec(),
            body: openai::body(turn),
        },
    }
}

/// Read the stream, folding each event and emitting what it produced.
///
/// Returns the terminal event, or `None` if the stream simply stopped - which is
/// its own failure and is reported as one by the caller. A vendor that closes
/// mid-reply has not ended the turn; it has abandoned it, and saying "ended"
/// would show a truncated answer as a complete one.
///
/// ## Two rules the vendors' orderings forced, and both were bugs first
///
/// **The terminal event is held back until the stream ends.** The obvious
/// version - stop at the first `Ended` - loses the usage of every single OpenAI
/// turn, because OpenAI reports its `finish_reason` on one chunk and its usage
/// on the *next* one. Anthropic is the other way round, so a client written
/// against either alone gets this wrong for the other. Holding the ending back
/// also gives the pane a contract worth having: exactly one terminal event, and
/// it is always last.
///
/// A `Failed` still stops the read immediately. An ending says there may be more
/// worth reading; an error says the opposite.
///
/// **Every `Spent` carries the turn's total so far, not a fragment.** Anthropic
/// reports usage in two events and OpenAI in one, and reconciling that in the
/// webview would put arithmetic in the one place the app is not allowed to have
/// any. `Usage::merge` never lets an absence overwrite a number, so the last
/// `Spent` of a turn is that turn's whole reported cost and the pane draws it
/// without adding anything up.
fn pump(
    source: impl Read,
    provider: Provider,
    turn: u64,
    cancel: &AtomicBool,
    mut emit: impl FnMut(PilotEvent),
) -> Result<Option<PilotEvent>, String> {
    let mut started = false;
    let mut terminal: Option<PilotEvent> = None;
    let mut total = event::Usage::default();

    sse::read(source, |sse_event| {
        if cancel.load(Ordering::Relaxed) {
            return sse::Flow::Stop;
        }
        let produced = match provider {
            Provider::Anthropic => anthropic::fold(turn, sse_event.name, sse_event.data),
            Provider::Openai => {
                let out = openai::fold(turn, sse_event.data, !started);
                // Set only when the adapter actually opened the turn: a `[DONE]`
                // or an error arriving first produces no `Started`, and marking
                // it here anyway would suppress the one for the real first chunk.
                if out
                    .iter()
                    .any(|e| matches!(e, PilotEvent::Started { .. }))
                {
                    started = true;
                }
                out
            }
        };
        for produced in produced {
            // `is_final` rather than a list of variants, so a terminal event
            // added to the vocabulary later is held back and emitted last by
            // construction instead of leaking into the middle of a turn.
            if produced.is_final() {
                // An error stops the read; an ending does not. An ending says
                // there may be more worth reading - which for OpenAI there is.
                let stop = matches!(produced, PilotEvent::Failed { .. });
                if terminal.is_none() {
                    terminal = Some(produced);
                }
                if stop {
                    return sse::Flow::Stop;
                }
                continue;
            }
            match produced {
                PilotEvent::Spent { usage, .. } => {
                    total.merge(&usage);
                    emit(PilotEvent::Spent {
                        turn,
                        usage: total.clone(),
                    });
                }
                other => emit(other),
            }
        }
        sse::Flow::Continue
    })?;

    // Always last, and exactly once.
    if let Some(terminal) = &terminal {
        emit(terminal.clone());
    }
    Ok(terminal)
}

/// Remove a credential a vendor echoed back at us.
///
/// **Not defensive programming - OpenAI actually does this.** Its 401 reads
/// `Incorrect API key provided: sk-proj-…`, with the key that was sent quoted
/// back in full. Showing that in the pilot pane would put a user's credential on
/// screen at exactly the moment they are most likely to be looking at it,
/// screenshotting it, or pasting it into a bug report - and the mistyped key
/// that produced the 401 is very often one character away from the real one.
///
/// Found by the live reachability test below, which asserts no error carries the
/// key it was given. Anthropic does not echo; that it does not is not something
/// this can rely on either vendor continuing to do, which is why the redaction
/// is at the emit seam rather than in one adapter.
fn redact(text: &str, key: &str) -> String {
    // Nothing to look for. An empty key never reaches here - `keys::set` refuses
    // one - but a guard beats replacing every empty string in a sentence.
    if key.is_empty() {
        return text.to_string();
    }
    text.replace(key, "<redacted>")
}

/// Run one turn to completion. Called on its own thread.
fn drive(app: &AppHandle, turn_id: u64, turn: Turn, cancel: Arc<AtomicBool>) {
    // Read at the last possible moment, held only for the length of one request,
    // and never emitted, logged or returned. The `Wire` it becomes carries it in
    // a header value that is dropped with the response.
    let key = match keys::read(turn.provider) {
        Ok(key) => key,
        Err(why) => {
            // Our own sentence, and there is no key to redact from it - the read
            // is what failed.
            let _ = app.emit(
                EVENT,
                PilotEvent::Failed {
                    turn: turn_id,
                    message: why,
                },
            );
            return;
        }
    };

    // **The one seam every event leaves through**, so redaction cannot be
    // forgotten at one of the four places a failure is built.
    let emit = |event: PilotEvent| {
        let _ = app.emit(
            EVENT,
            match event {
                PilotEvent::Failed { turn, message } => PilotEvent::Failed {
                    turn,
                    message: redact(&message, &key),
                },
                other => other,
            },
        );
    };

    let wire = wire(&turn, &key);
    let agent = agent();
    let mut request = agent.post(wire.url);
    for (name, value) in &wire.headers {
        request = request.header(*name, value.as_str());
    }

    let response = match request.send_json(&wire.body) {
        Ok(response) => response,
        Err(e) => {
            emit(PilotEvent::Failed {
                turn: turn_id,
                // `e` is a transport failure - DNS, TLS, a refused connection.
                // It cannot contain the key: the key is a header value and this
                // error is about the socket.
                message: format!("could not reach {}: {e}", vendor(turn.provider)),
            });
            return;
        }
    };

    let status = response.status();
    let mut body = response.into_body();
    if !status.is_success() {
        // The vendor's own words. An unauthorised key produces the clearest
        // message either API returns, and paraphrasing it would lose exactly the
        // sentence that says which of the two things is wrong.
        let text = body
            .with_config()
            .limit(MAX_ERROR_BYTES)
            .read_to_string()
            .unwrap_or_default();
        emit(PilotEvent::Failed {
            turn: turn_id,
            message: format!(
                "{} returned {}: {}",
                vendor(turn.provider),
                status.as_u16(),
                explain(turn.provider, &text)
            ),
        });
        return;
    }

    let outcome = pump(
        body.into_reader(),
        turn.provider,
        turn_id,
        &cancel,
        |event| emit(event),
    );

    // Cancellation is checked before the outcome, because a cancelled read
    // returns `Ok(None)` - the same shape a stream that died would - and calling
    // the user's own stop a failure would be wrong in the one case they know
    // exactly what happened.
    if cancel.load(Ordering::Relaxed) {
        emit(PilotEvent::Cancelled { turn: turn_id });
        return;
    }

    match outcome {
        Ok(Some(_)) => {}
        // The stream stopped without ending. Not `Ended`: the reply on screen is
        // truncated and the user has to know that rather than being shown a
        // partial answer as a whole one.
        Ok(None) => emit(PilotEvent::Failed {
            turn: turn_id,
            message: format!("{} closed the stream without finishing", vendor(turn.provider)),
        }),
        Err(why) => emit(PilotEvent::Failed {
            turn: turn_id,
            message: why,
        }),
    }
}

/// A vendor's name, for prose.
fn vendor(provider: Provider) -> &'static str {
    match provider {
        Provider::Anthropic => "Anthropic",
        Provider::Openai => "OpenAI",
    }
}

/// A failure body in the vendor's own words, or the body itself.
fn explain(provider: Provider, body: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        // Not JSON - a gateway's HTML, usually. Reported as what arrived rather
        // than as a phrase invented for it.
        let trimmed = body.trim();
        return if trimmed.is_empty() {
            "no body".to_string()
        } else {
            trimmed.chars().take(500).collect()
        };
    };
    match provider {
        Provider::Anthropic => anthropic::describe(&value["error"]),
        Provider::Openai => openai::describe(&value["error"]),
    }
}

/// Start a turn. Returns its id immediately; everything else arrives as events.
///
/// **Never returns the reply.** A command that returned the whole answer would
/// have to hold it until the model finished, which is the streaming this exists
/// to provide - and it would put the transcript in a promise rather than in the
/// event stream the pane is built on.
#[tauri::command]
pub fn pilot_send(
    app: AppHandle,
    state: tauri::State<'_, Pilot>,
    turn: Turn,
) -> Result<u64, String> {
    // Before an id is handed out, before a key is read, before a socket opens.
    turn.check()?;

    let (id, cancel) = state.begin()?;
    let handle = app.clone();
    std::thread::spawn(move || {
        drive(&handle, id, turn, cancel);
        handle.state::<Pilot>().finish(id);
    });
    Ok(id)
}

#[tauri::command]
pub fn pilot_cancel(state: tauri::State<'_, Pilot>, turn: u64) -> Result<(), String> {
    state.cancel(turn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use event::Usage;
    use request::{Message, Role};

    fn turn(provider: Provider) -> Turn {
        Turn {
            provider,
            model: "m".into(),
            system: None,
            messages: vec![Message {
                role: Role::User,
                content: "hi".into(),
            }],
            max_tokens: 100,
        }
    }

    /// Drive a recorded stream through `pump` and collect what it produced.
    fn replay(provider: Provider, stream: &str) -> (Vec<PilotEvent>, Option<PilotEvent>) {
        let mut seen = Vec::new();
        let cancel = AtomicBool::new(false);
        let terminal = pump(stream.as_bytes(), provider, 1, &cancel, |e| seen.push(e))
            .expect("reads");
        (seen, terminal)
    }

    /// A real Anthropic reply, event for event.
    const ANTHROPIC: &str = concat!(
        "event: message_start\n",
        r#"data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5-20260501","usage":{"input_tokens":120,"cache_read_input_tokens":4000,"cache_creation_input_tokens":0,"output_tokens":1}}}"#,
        "\n\n",
        "event: content_block_start\n",
        r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        "\n\n",
        ": ping\n\n",
        "event: content_block_delta\n",
        r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}"#,
        "\n\n",
        "event: content_block_delta\n",
        r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo."}}"#,
        "\n\n",
        "event: content_block_stop\n",
        r#"data: {"type":"content_block_stop","index":0}"#,
        "\n\n",
        "event: message_delta\n",
        r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":38}}"#,
        "\n\n",
        "event: message_stop\n",
        r#"data: {"type":"message_stop"}"#,
        "\n\n",
    );

    /// A real OpenAI reply, chunk for chunk.
    const OPENAI: &str = concat!(
        r#"data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-5-2026-04-01","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}"#,
        "\n\n",
        r#"data: {"id":"c1","model":"gpt-5-2026-04-01","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}"#,
        "\n\n",
        r#"data: {"id":"c1","model":"gpt-5-2026-04-01","choices":[{"index":0,"delta":{"content":"lo."},"finish_reason":null}]}"#,
        "\n\n",
        r#"data: {"id":"c1","model":"gpt-5-2026-04-01","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        "\n\n",
        r#"data: {"id":"c1","model":"gpt-5-2026-04-01","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":38,"prompt_tokens_details":{"cached_tokens":64}}}"#,
        "\n\n",
        "data: [DONE]\n\n",
    );

    /// The text of a reply, assembled the way the pane assembles it.
    fn transcript(events: &[PilotEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                PilotEvent::Text { delta, .. } => Some(delta.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn both_vendors_produce_the_same_reply_from_two_different_streams() {
        // The whole point of one vocabulary: nothing above the adapters can tell
        // which of these answered.
        let (anthropic, _) = replay(Provider::Anthropic, ANTHROPIC);
        let (openai, _) = replay(Provider::Openai, OPENAI);
        assert_eq!(transcript(&anthropic), "Hello.");
        assert_eq!(transcript(&openai), "Hello.");
    }

    #[test]
    fn both_start_exactly_once_and_name_the_model_that_answered() {
        for (provider, stream) in [(Provider::Anthropic, ANTHROPIC), (Provider::Openai, OPENAI)] {
            let (events, _) = replay(provider, stream);
            let started: Vec<_> = events
                .iter()
                .filter(|e| matches!(e, PilotEvent::Started { .. }))
                .collect();
            assert_eq!(started.len(), 1, "{provider:?} started {} times", started.len());
            match started[0] {
                PilotEvent::Started { model, .. } => {
                    assert!(model.is_some(), "{provider:?} named no model")
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn both_end_exactly_once_with_the_vendors_own_stop_word() {
        // Trailing events - Anthropic's `message_stop`, OpenAI's `[DONE]` - come
        // after the ending. Reading past it is how a turn ends twice, the second
        // time with no reason attached.
        let (_, anthropic) = replay(Provider::Anthropic, ANTHROPIC);
        assert_eq!(
            anthropic,
            Some(PilotEvent::Ended {
                turn: 1,
                stop: Some("end_turn".into())
            })
        );
        let (_, openai) = replay(Provider::Openai, OPENAI);
        assert_eq!(
            openai,
            Some(PilotEvent::Ended {
                turn: 1,
                stop: Some("stop".into())
            })
        );
    }

    /// Every `Spent` a stream produced, in order.
    fn spends(events: &[PilotEvent]) -> Vec<&Usage> {
        events
            .iter()
            .filter_map(|e| match e {
                PilotEvent::Spent { usage, .. } => Some(usage),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_last_spend_of_a_turn_is_that_turns_whole_reported_cost() {
        // The vendors report differently - Anthropic in two events, OpenAI in
        // one - and the *difference* is preserved while the arithmetic is not
        // left to the webview. Every `Spent` is a running total, so the pane
        // draws the latest and adds nothing up.
        let (anthropic, _) = replay(Provider::Anthropic, ANTHROPIC);
        let anthropic = spends(&anthropic);
        assert_eq!(anthropic.len(), 2, "Anthropic reports usage twice");
        assert_eq!(
            anthropic[1],
            &Usage {
                input: Some(120),
                output: Some(38),
                cache_read: Some(4000),
                cache_write: Some(0),
            },
            "and the second carries the first's numbers forward"
        );

        let (openai, _) = replay(Provider::Openai, OPENAI);
        let openai = spends(&openai);
        assert_eq!(openai.len(), 1, "OpenAI reports usage once, at the end");
        assert_eq!(
            openai[0],
            &Usage {
                input: Some(120),
                output: Some(38),
                cache_read: Some(64),
                // The asymmetry, surviving all the way to the top. This vendor
                // has no cache-write charge to report and none is invented.
                cache_write: None,
            }
        );
    }

    #[test]
    fn a_usage_report_that_arrives_after_the_ending_is_not_lost() {
        // **The bug this test exists for**, and it was real: OpenAI sends its
        // `finish_reason` on one chunk and its usage on the *next*, so stopping
        // at the first terminal event lost the cost of every OpenAI turn.
        // Anthropic is the other way round, so a client written against either
        // one alone gets this wrong for the other.
        let (events, terminal) = replay(Provider::Openai, OPENAI);
        assert_eq!(spends(&events).len(), 1, "the trailing usage still arrived");
        assert!(terminal.is_some());
    }

    #[test]
    fn there_is_exactly_one_terminal_event_and_it_is_always_last() {
        // The contract the pane is built on: it stops its spinner on the first
        // terminal event, so a second one - or one followed by a spend - would
        // either hang it or have it draw a cost after it stopped listening.
        for (provider, stream) in [(Provider::Anthropic, ANTHROPIC), (Provider::Openai, OPENAI)] {
            let (events, _) = replay(provider, stream);
            let finals: Vec<usize> = events
                .iter()
                .enumerate()
                .filter(|(_, e)| e.is_final())
                .map(|(i, _)| i)
                .collect();
            assert_eq!(finals.len(), 1, "{provider:?} produced {finals:?}");
            assert_eq!(finals[0], events.len() - 1, "{provider:?} ended early");
        }
    }

    #[test]
    fn a_stream_that_stops_without_ending_produces_no_terminal_event() {
        // Reported as a failure by `drive`, not as an ending: the reply on
        // screen is truncated, and showing it as complete is the worse of the
        // two wrong answers.
        let cut = ANTHROPIC
            .split("event: message_delta")
            .next()
            .expect("a prefix");
        let (events, terminal) = replay(Provider::Anthropic, cut);
        assert_eq!(transcript(&events), "Hello.");
        assert_eq!(terminal, None);
    }

    #[test]
    fn cancelling_stops_the_stream_where_it_is() {
        let cancel = AtomicBool::new(false);
        let mut seen = Vec::new();
        let terminal = pump(ANTHROPIC.as_bytes(), Provider::Anthropic, 1, &cancel, |e| {
            // Cancel as soon as any text has arrived, which is what a user
            // hitting stop mid-reply does.
            if matches!(e, PilotEvent::Text { .. }) {
                cancel.store(true, Ordering::Relaxed);
            }
            seen.push(e);
        })
        .expect("reads");
        assert_eq!(transcript(&seen), "Hel", "stopped at the first delta");
        assert_eq!(terminal, None, "a cancellation is not an ending");
    }

    #[test]
    fn a_mid_stream_error_after_a_200_is_terminal() {
        // The case that makes checking the status code insufficient for either
        // vendor: the stream opened fine and then said no.
        let stream = concat!(
            "event: message_start\n",
            r#"data: {"message":{"model":"m","usage":{"input_tokens":1}}}"#,
            "\n\n",
            "event: error\n",
            r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
            "\n\n",
        );
        let (_, terminal) = replay(Provider::Anthropic, stream);
        assert_eq!(
            terminal,
            Some(PilotEvent::Failed {
                turn: 1,
                message: "overloaded_error: Overloaded".into()
            })
        );
    }

    #[test]
    fn the_two_vendors_get_two_different_requests_for_the_same_turn() {
        // `wire` is a match rather than a trait, and this is why: the same
        // conversation produces two genuinely different bodies at two different
        // URLs with two differently-named credential headers.
        let mut t = turn(Provider::Anthropic);
        t.system = Some("be brief".into());
        let a = wire(&t, "KEY");
        assert_eq!(a.url, anthropic::URL);
        assert_eq!(a.body["system"], serde_json::json!("be brief"));
        assert_eq!(a.body["messages"].as_array().expect("messages").len(), 1);
        assert!(a.headers.iter().any(|(n, v)| *n == "x-api-key" && v == "KEY"));

        let mut t = turn(Provider::Openai);
        t.system = Some("be brief".into());
        let o = wire(&t, "KEY");
        assert_eq!(o.url, openai::URL);
        assert!(o.body.get("system").is_none());
        assert_eq!(o.body["messages"].as_array().expect("messages").len(), 2);
        assert!(o
            .headers
            .iter()
            .any(|(n, v)| *n == "authorization" && v == "Bearer KEY"));
    }

    #[test]
    fn a_failure_body_is_reported_in_the_vendors_words_and_never_paraphrased() {
        assert_eq!(
            explain(
                Provider::Anthropic,
                r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#
            ),
            "authentication_error: invalid x-api-key"
        );
        assert_eq!(
            explain(
                Provider::Openai,
                r#"{"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}"#
            ),
            "invalid_api_key: Incorrect API key provided"
        );
    }

    #[test]
    fn a_failure_body_that_is_not_json_is_shown_as_what_arrived() {
        // A gateway's HTML, usually. Truncated because a megabyte of it helps
        // nobody, and reported as itself because "the request failed" is tidy
        // and says nothing.
        let html = explain(Provider::Openai, "<html><body>502 Bad Gateway</body></html>");
        assert!(html.contains("502"), "{html}");
        assert_eq!(explain(Provider::Anthropic, "   "), "no body");
        assert!(explain(Provider::Openai, &"x".repeat(9_000)).len() <= 500);
    }

    #[test]
    fn a_vendor_that_quotes_the_key_back_does_not_get_it_to_the_screen() {
        // Recorded from a real OpenAI 401, which quotes the key it was sent in
        // full. Found by the live test below; this is what keeps it fixed
        // without a network.
        let echoed = "invalid_api_key: Incorrect API key provided: sk-proj-abc123. You can find \
                      your API key at https://platform.openai.com/account/api-keys.";
        let safe = redact(echoed, "sk-proj-abc123");
        assert!(!safe.contains("sk-proj-abc123"));
        assert!(safe.contains("<redacted>"));
        // And the rest of the sentence survives, because it is the part that
        // tells somebody what to do about it.
        assert!(safe.contains("Incorrect API key provided"));
    }

    #[test]
    fn redaction_removes_every_occurrence_and_leaves_everything_else() {
        assert_eq!(redact("a KEY b KEY c", "KEY"), "a <redacted> b <redacted> c");
        assert_eq!(redact("nothing here", "KEY"), "nothing here");
        // An empty key never reaches this - `keys::set` refuses one - but
        // replacing every empty string in a sentence would be a spectacular way
        // to find that out.
        assert_eq!(redact("untouched", ""), "untouched");
    }

    #[test]
    fn a_cancel_for_a_turn_that_is_not_running_is_refused() {
        // Said rather than swallowed: a window cancelling a finished turn should
        // find that out instead of watching a button do nothing.
        let pilot = Pilot::default();
        assert!(pilot.cancel(7).is_err());
        let (id, flag) = pilot.begin().expect("begins");
        assert!(pilot.cancel(id).is_ok());
        assert!(flag.load(Ordering::Relaxed));
        pilot.finish(id);
        assert!(pilot.cancel(id).is_err(), "and a finished turn is not running");
    }

    /// The half no recorded stream can prove: that this reaches the vendors at
    /// all.
    ///
    /// **`#[ignore]`d, for the reason the keychain round trip is**: the repo's
    /// rule is no network in tests, and a gate that made two real requests on
    /// every `npm run app:test` would be one. Run it deliberately:
    ///
    /// ```text
    /// cargo test --manifest-path src-tauri/Cargo.toml -- --ignored
    /// ```
    ///
    /// **It needs no credential and cannot spend anything.** The key it sends is
    /// a literal, so both vendors reject it before a model is loaded - which is
    /// precisely the point. What it establishes is everything between here and
    /// the API: DNS, TLS through `webpki-roots`, the URL, the header names, a
    /// body both accept as well-formed enough to authenticate, and `explain`
    /// rendering the vendor's own sentence rather than a phrase invented for it.
    #[test]
    #[ignore = "makes two real requests; run with --ignored"]
    fn both_vendors_are_reachable_and_refuse_a_key_that_is_not_one() {
        for provider in Provider::ALL {
            let wire = wire(&turn(provider), "not-a-key");
            let mut request = agent().post(wire.url);
            for (name, value) in &wire.headers {
                request = request.header(*name, value.as_str());
            }
            let mut response = request
                .send_json(&wire.body)
                .unwrap_or_else(|e| panic!("{:?} unreachable: {e}", provider));

            let status = response.status().as_u16();
            let body = response.body_mut().read_to_string().unwrap_or_default();
            let why = explain(provider, &body);
            println!("{provider:?} -> {status}: {why}");

            assert_eq!(status, 401, "{provider:?} said {status}: {why}");
            // The vendor's own words reached us, rather than an empty body or a
            // gateway page - which is what proves `explain` is reading the shape
            // it was written for.
            assert!(!why.is_empty() && why != "no body", "{provider:?}: {why:?}");
            // **This is the assertion that found the leak.** OpenAI quotes the
            // key it was sent straight back in its 401, so what a user sees has
            // to be the redacted form and nothing else.
            assert!(
                !redact(&why, "not-a-key").contains("not-a-key"),
                "{provider:?} echoed the key and redaction did not remove it: {why}"
            );
        }
    }

    #[test]
    fn turn_ids_do_not_restart() {
        // Two turns with the same id would have the pane append one reply into
        // the other's bubble.
        let pilot = Pilot::default();
        let (first, _) = pilot.begin().expect("begins");
        let (second, _) = pilot.begin().expect("begins");
        assert_ne!(first, second);
        pilot.finish(first);
        let (third, _) = pilot.begin().expect("begins");
        assert_ne!(third, first, "an id is never reused after its turn ends");
    }
}
