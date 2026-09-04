import { useCallback, useEffect, useReducer, useState } from 'react';
import { Button, MetaChip, StateKicker } from '../design';
import * as keys from './keys';
import * as pilot from './pilot';
import {
  ask,
  emptyConversation,
  reduce,
  refuse,
  spendParts,
  unanswered,
  unrecognised,
} from './transcript';
import type { KeyStatus, Provider } from './keys';
import type { Conversation, Reply } from './transcript';

/**
 * The pilot pane: what proves the clients work (#143).
 *
 * **This is not hi-fi 5.** The designed pilot chat drives the session — it reads
 * the brief with you, launches the run, answers a gate when you ask it to — and
 * every one of those capabilities is a host request the app already makes, which
 * is #144's subject and not this one's. This is the pane that shows a reply
 * streaming from a real vendor with a real key, which is the acceptance
 * criterion the issue actually states.
 *
 * **All the judgement is in `transcript.ts`**, which is pure and tested; what is
 * here is markup and the two effects that connect it to the wire. The reducer
 * owns every fact about the conversation, so there is exactly one answer to what
 * has been said — the same rule `cockpit/model.ts` is written to.
 */

type Action =
  | { type: 'ask'; content: string; turn: number; provider: Provider }
  | { type: 'refuse'; content: string; provider: Provider; message: string }
  | { type: 'event'; event: pilot.PilotEvent }
  | { type: 'unknown' };

function apply(state: Conversation, action: Action): Conversation {
  switch (action.type) {
    case 'ask':
      return ask(state, action.content, action.turn, action.provider);
    case 'refuse':
      return refuse(state, action.content, action.provider, action.message);
    case 'event':
      return reduce(state, action.event);
    case 'unknown':
      return unrecognised(state);
  }
}

function ReplyCard({ reply }: { reply: Reply }) {
  const outcome = reply.outcome;
  return (
    <div className="v-pilot__reply">
      <div className="v-pilot__meta">
        <MetaChip>{keys.PROVIDER_NAME[reply.provider]}</MetaChip>
        {/* What ANSWERED, not what was asked for: an alias resolves to a dated
            version, and the resolved one is the fact worth showing. Absent until
            the vendor says so, rather than filled in from the request. */}
        {reply.model !== null && <MetaChip kind="checkable">{reply.model}</MetaChip>}
        {outcome === null && <StateKicker tone="accent">streaming</StateKicker>}
        {/* The vendor's own word — `end_turn`, `stop`, `max_tokens`, `length`.
            Not translated into a shared spelling, because a shared spelling
            would claim a shared meaning nobody has established. */}
        {outcome?.kind === 'ended' && outcome.stop !== null && <MetaChip>{outcome.stop}</MetaChip>}
        {outcome?.kind === 'cancelled' && <StateKicker tone="quiet">stopped</StateKicker>}
        {outcome?.kind === 'failed' && <StateKicker tone="alarm">failed</StateKicker>}
      </div>

      {reply.text !== '' && <div className="v-pilot__text">{reply.text}</div>}
      {outcome?.kind === 'failed' && <div className="v-pilot__why">{outcome.message}</div>}

      {/* What it asked for. Nothing runs these yet — the table and its executor
          are the next step (#144) — and a call the transcript did not show
          would be invisible rather than unimplemented. */}
      {reply.calls.map((call) => (
        <div className="v-pilot__call" key={call.id}>
          <MetaChip>{call.name}</MetaChip>
          {call.unreadable === null ? (
            <span className="v-pilot__note">asked for, and nothing runs tools yet</span>
          ) : (
            // A model can emit truncated JSON when a turn hits its ceiling
            // mid-call. Reported as a call that cannot be run, rather than
            // shown as one that could.
            <span className="v-pilot__why">its arguments do not parse: {call.unreadable}</span>
          )}
        </div>
      ))}

      {/* Only what the vendor reported. OpenAI has no cache-write count, so that
          part is missing from an OpenAI line — and a reader can tell that apart
          from a cache write of zero, which is the entire point. */}
      {reply.usage !== null && (
        <div className="v-pilot__spend">{spendParts(reply.usage).join(' · ')}</div>
      )}
      {reply.usage === null && outcome !== null && (
        <div className="v-pilot__spend">
          no usage reported — this turn did not get far enough for the vendor to say
        </div>
      )}
    </div>
  );
}

export function PilotPane() {
  const [conversation, dispatch] = useReducer(apply, undefined, emptyConversation);
  const [statuses, setStatuses] = useState<readonly KeyStatus[] | null>(null);
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState<string>(pilot.MODELS.anthropic[0] ?? '');
  const [entry, setEntry] = useState('');
  const [live, setLive] = useState<number | null>(null);

  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      stop = await pilot.connect(
        (event) => {
          dispatch({ type: 'event', event });
          // Rust guarantees exactly one terminal event per turn and that it is
          // last, so this is safe to act on the first time it is seen.
          if (pilot.isFinal(event)) setLive(null);
        },
        () => dispatch({ type: 'unknown' }),
      );
      if (cancelled) stop();
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const refresh = useCallback(() => {
    void keys
      .status()
      .then(setStatuses)
      // An unreachable keychain leaves the pane saying no key is configured,
      // which is the fail-closed direction: the request would fail anyway, and
      // later, with a worse explanation.
      .catch(() => setStatuses([]));
  }, []);
  useEffect(refresh, [refresh]);

  // A conversation with a call nobody answered cannot be sent: both vendors
  // reject an assistant turn whose tool_use has no matching result. Always empty
  // in this build, because nothing declares a tool — it is here so the executor
  // has a seam rather than a rule to rediscover.
  const owed = unanswered(conversation);
  const ready = statuses !== null && keys.usable(statuses).includes(provider) && owed.length === 0;

  const submit = useCallback(() => {
    const content = entry.trim();
    if (content === '' || live !== null) return;
    setEntry('');
    // The whole conversation so far plus this message. Assembled here because
    // this is the only place that knows both, and sent in full: neither vendor
    // remembers a previous request.
    const messages = [...conversation.messages, { role: 'user' as const, content }];
    void pilot
      .send({ provider, model, messages })
      .then((turn) => dispatch({ type: 'ask', content, turn, provider }))
      .catch((err: unknown) =>
        dispatch({
          type: 'refuse',
          content,
          provider,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
  }, [conversation.messages, entry, live, model, provider]);

  return (
    <div className="v-pilot">
      <div className="v-pilot__controls">
        <select
          className="v-pilot__select"
          value={provider}
          onChange={(e) => {
            const next = e.target.value as Provider;
            setProvider(next);
            setModel(pilot.MODELS[next][0] ?? '');
          }}
        >
          {keys.PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {keys.PROVIDER_NAME[p]}
            </option>
          ))}
        </select>
        <select className="v-pilot__select" value={model} onChange={(e) => setModel(e.target.value)}>
          {pilot.MODELS[provider].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {/* Names the provider rather than "a key". One provider configured is a
            supported state, so this is the message for having picked the other. */}
        {statuses !== null && !keys.usable(statuses).includes(provider) && (
          <span className="v-pilot__note">
            no {keys.PROVIDER_NAME[provider]} key — enter one under Keys
          </span>
        )}
        {owed.length > 0 && (
          <span className="v-pilot__note">
            {owed.length} tool call(s) unanswered — nothing runs them yet (#144), and neither
            vendor will take a conversation that leaves one open
          </span>
        )}
      </div>

      <div className="v-pilot__log">
        {conversation.replies.length === 0 && conversation.live === null && (
          <div className="v-pilot__note">
            Nothing yet. This pane sends a conversation and streams the reply — it cannot drive
            the run, call a tool, or read the loop (#144).
          </div>
        )}
        {conversation.replies.map((reply) => (
          <ReplyCard key={reply.turn} reply={reply} />
        ))}
        {conversation.live !== null && <ReplyCard reply={conversation.live} />}
      </div>

      {conversation.unknown > 0 && (
        <div className="v-pilot__note">
          {conversation.unknown} unrecognised event(s) — this window is older than the app
        </div>
      )}

      <div className="v-pilot__composer">
        <textarea
          className="v-pilot__entry"
          rows={2}
          placeholder={ready ? 'say something to the pilot' : 'enter a key first'}
          value={entry}
          disabled={!ready}
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        {live === null ? (
          <Button level="primary" disabled={!ready || entry.trim() === ''} onClick={submit}>
            send
          </Button>
        ) : (
          <Button
            level="secondary"
            onClick={() => {
              // A refusal here means the turn ended between the render and the
              // click. Not worth a message: the terminal event is about to
              // redraw this button anyway.
              void pilot.cancel(live).catch(() => {});
            }}
          >
            ⏹ stop
          </Button>
        )}
      </div>
    </div>
  );
}
