import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Button, MetaChip, StateKicker } from '../design';
import * as keys from './keys';
import * as pilot from './pilot';
import { declare, execute } from './tools';
import {
  costOf,
  describeDay,
  formatUsd,
  limitVerdict,
  readLedger,
  readLimits,
  record,
  today,
  writeLedger,
  writeLimits,
} from './ledger';
import type { Ledger, PilotLimits } from './ledger';
import {
  answerOf,
  ask,
  decide,
  emptyConversation,
  follow,
  reduce,
  refuse,
  settle,
  spendParts,
  unanswered,
  unrecognised,
} from './transcript';
import type { KeyStatus, Provider } from './keys';
import type { Effect, Settlement } from './tools';
import type { Call, Conversation, Reply } from './transcript';
import type { Run } from '../cockpit/model';

/**
 * The pilot pane: the conversation that drives the session (#143, #144).
 *
 * **All the judgement is in `transcript.ts` and `tools.ts`**, both pure and both
 * tested; what is here is markup and the three effects that connect them to the
 * wire. The reducer owns every fact about the conversation, so there is exactly
 * one answer to what has been said — the same rule `cockpit/model.ts` is written
 * to.
 *
 * ## Propose only, and where that is actually enforced
 *
 * Not here. A settlement of `proposes` appends no tool result, so the call stays
 * in `unanswered()` and `unanswered()` is what the composer refuses to send
 * past. A component that forgot to draw the card could not send around it, which
 * is the property worth having: the rule lives in the data.
 *
 * ## The chain, and why it has a ceiling
 *
 * A tool result has to go back to the model or the turn is unfinished, so a
 * settled call starts the next turn on its own. That is the one place the pilot
 * spends without anybody typing, and it is the one place a model that keeps
 * asking for `read_run` would keep spending. `MAX_CHAIN` stops it. **It is a
 * choice, not a measurement** — nothing has been observed that says eight is the
 * right number — and it is stated in the pane when it is reached, so the user
 * can send the next turn themselves rather than wonder why nothing is happening.
 */

/** Turns the pilot may take on its own before a person has to speak again. */
const MAX_CHAIN = 8;

type Action =
  | { type: 'ask'; content: string; turn: number; provider: Provider }
  | { type: 'follow'; turn: number; provider: Provider }
  | { type: 'refuse'; content: string | null; provider: Provider; message: string }
  | { type: 'event'; event: pilot.PilotEvent }
  | { type: 'settle'; id: string; settlement: Settlement }
  | { type: 'decide'; id: string; accepted: boolean; note: string }
  | { type: 'unknown' };

function apply(state: Conversation, action: Action): Conversation {
  switch (action.type) {
    case 'ask':
      return ask(state, action.content, action.turn, action.provider);
    case 'follow':
      return follow(state, action.turn, action.provider);
    case 'refuse':
      return refuse(state, action.content, action.provider, action.message);
    case 'event':
      return reduce(state, action.event);
    case 'settle':
      return settle(state, action.id, action.settlement);
    case 'decide':
      return decide(state, action.id, action.accepted, action.note);
    case 'unknown':
      return unrecognised(state);
  }
}

/** The exact thing that would be sent, drawn before anybody agrees to it. */
function EffectDetail({ effect }: { effect: Effect }) {
  if (effect.kind === 'invoke') {
    // The argv, entry by entry. Not a rendered sentence about it: the brief IS
    // the argument that decides whether the run converges, and a summary of the
    // brief is precisely the thing nobody can check.
    return (
      <pre className="v-proposal__argv">
        {effect.argv.map((arg, i) => `${i === 0 ? '' : '  '}${arg}`).join('\n')}
      </pre>
    );
  }
  return (
    <pre className="v-proposal__argv">{JSON.stringify(effect.decision, null, 2)}</pre>
  );
}

function Proposal({
  call,
  effect,
  summary,
  onDecide,
  busy,
}: {
  call: Call;
  effect: Effect;
  summary: string;
  onDecide: (accepted: boolean, note: string) => void;
  busy: boolean;
}) {
  const [note, setNote] = useState('');
  return (
    <div className="v-proposal">
      <div className="v-pilot__meta">
        <StateKicker tone="accent">proposed</StateKicker>
        <MetaChip>{call.name}</MetaChip>
      </div>
      <div className="v-proposal__summary">{summary}</div>
      <EffectDetail effect={effect} />
      <div className="v-proposal__note">
        Nothing has been sent. This is the same request the button makes, and it goes down the same
        wire — so what it does is what you would get from the window yourself.
      </div>
      <div className="v-proposal__actions">
        <Button level="primary" disabled={busy} onClick={() => onDecide(true, note)}>
          run it
        </Button>
        <input
          className="v-proposal__reply"
          placeholder="what to tell the pilot (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Button level="secondary" disabled={busy} onClick={() => onDecide(false, note)}>
          no
        </Button>
      </div>
    </div>
  );
}

function CallCard({
  call,
  answer,
  onDecide,
  busy,
}: {
  call: Call;
  /** The result already sent for it, or null while it is still owed one. */
  answer: string | null;
  onDecide: (accepted: boolean, note: string) => void;
  busy: boolean;
}) {
  const settlement = call.settlement;

  if (call.unreadable !== null) {
    // A model emits truncated JSON when a turn hits its ceiling mid-call.
    // Reported as a call that cannot be run, rather than shown as one that could.
    return (
      <div className="v-pilot__call">
        <MetaChip>{call.name}</MetaChip>
        <span className="v-pilot__why">its arguments do not parse: {call.unreadable}</span>
      </div>
    );
  }
  if (settlement === null) {
    return (
      <div className="v-pilot__call">
        <MetaChip>{call.name}</MetaChip>
        <span className="v-pilot__note">waiting to be run</span>
      </div>
    );
  }
  if (settlement.kind === 'proposes' && answer === null) {
    return (
      <Proposal
        call={call}
        effect={settlement.effect}
        summary={settlement.summary}
        onDecide={onDecide}
        busy={busy}
      />
    );
  }
  return (
    <div className="v-pilot__call">
      <MetaChip>{call.name}</MetaChip>
      {settlement.kind === 'refused' ? (
        <span className="v-pilot__why">{settlement.content}</span>
      ) : (
        // What was actually sent back, not a paraphrase. A read's result is JSON
        // and can be long, so the pane shows that it happened and the answer is
        // one line down rather than the whole payload inline.
        <span className="v-pilot__note">{answer ?? 'read'}</span>
      )}
    </div>
  );
}

/**
 * What this one turn is estimated to have cost, or why there is no figure (#145).
 *
 * **This is the first place in the product where a dollar is a dollar.** The
 * run's `costUsd` is documented as *not money* — a proxy for work volume on a
 * subscription — and this one is money, on a card, from an API key. So it says
 * *estimated* and names the date the price was read, and it is never drawn
 * anywhere the run's figure is drawn.
 *
 * A turn with no price reports the reason in the place the figure would have
 * been, rather than a blank or a zero.
 */
function TurnPrice({ reply }: { reply: Reply }) {
  if (reply.usage === null) return null;
  const cost = costOf(reply.provider, reply.model, reply.usage);
  if (cost.usd === null) {
    return <span className="v-pilot__price v-pilot__price--absent"> · cost: {cost.why}</span>;
  }
  return (
    <span className="v-pilot__price">
      {' · '}~{formatUsd(cost.usd)} estimated
      {cost.price !== null && (
        <span className="v-pilot__price-note"> (published prices, read {cost.price.takenOn})</span>
      )}
    </span>
  );
}

/**
 * The pilot's own ceiling, set here and nowhere else (#145).
 *
 * **Two fields, both blank by default, and blank means no ceiling.** A hard
 * default cap on a conversation is the kind of thing that stops you mid-sentence
 * for no good reason - but this is the first real spend in the product, and a
 * runaway loop in a chat is as possible as one anywhere else, so it exists and
 * is off.
 *
 * Per day rather than per session: a conversation has no natural end, so
 * `maxTokens`' shape does not transfer, and a day is the window both vendors'
 * own dashboards use. The labels say *pilot* because the run has two ceilings of
 * its own and a user must never wonder which one they just changed.
 */
function PilotLimitFields({
  limits,
  onChange,
}: {
  limits: PilotLimits;
  onChange: (limits: PilotLimits) => void;
}) {
  // A blank field is no ceiling, and a value that is not a positive number is
  // also no ceiling - refusing to store a ceiling nobody could have meant,
  // rather than storing a zero that would stop everything.
  const read = (raw: string): number | null => {
    const n = Number(raw);
    return raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
  };
  return (
    <span className="v-pilot__limits">
      <label className="v-pilot__limit">
        pilot tokens/day
        <input
          className="v-pilot__limit-input"
          type="number"
          min="1"
          placeholder="no limit"
          value={limits.dailyTokens ?? ''}
          onChange={(e) => onChange({ ...limits, dailyTokens: read(e.target.value) })}
        />
      </label>
      <label className="v-pilot__limit">
        pilot $/day
        <input
          className="v-pilot__limit-input"
          type="number"
          min="0.01"
          step="0.01"
          placeholder="no limit"
          value={limits.dailyUsd ?? ''}
          onChange={(e) => onChange({ ...limits, dailyUsd: read(e.target.value) })}
        />
      </label>
    </span>
  );
}

function ReplyCard({
  reply,
  conversation,
  onDecide,
  busy,
}: {
  reply: Reply;
  conversation: Conversation;
  onDecide: (id: string, accepted: boolean, note: string) => void;
  busy: boolean;
}) {
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

      {reply.calls.map((call) => (
        <CallCard
          key={call.id}
          call={call}
          answer={answerOf(conversation, call.id)}
          busy={busy}
          onDecide={(accepted, note) => onDecide(call.id, accepted, note)}
        />
      ))}

      {/* Only what the vendor reported. OpenAI has no cache-write count, so that
          part is missing from an OpenAI line — and a reader can tell that apart
          from a cache write of zero, which is the entire point. */}
      {reply.usage !== null && (
        <div className="v-pilot__spend">
          {spendParts(reply.usage).join(' · ')}
          <TurnPrice reply={reply} />
        </div>
      )}
      {reply.usage === null && outcome !== null && (
        <div className="v-pilot__spend">
          no usage reported — this turn did not get far enough for the vendor to say
        </div>
      )}
    </div>
  );
}

export interface PilotPaneProps {
  /** The run as the cockpit holds it. What `read_run` and `read_output` see. */
  run: Run;
  /**
   * Fire an accepted proposal.
   *
   * Handed up rather than sent from here, so a pilot-proposed launch goes
   * through the same code path as the Launch form and a pilot-proposed answer
   * through the same one as the footer's buttons — including the request-id
   * allocation and the column reset. Two senders would be two definitions of
   * what starting a run does from this window.
   */
  onEffect: (effect: Effect) => void;
  /** How many proposals are waiting on a person, so a hidden tab can say so. */
  onPending?: (count: number) => void;
}

export function PilotPane({ run, onEffect, onPending }: PilotPaneProps) {
  const [conversation, dispatch] = useReducer(apply, undefined, emptyConversation);
  const [statuses, setStatuses] = useState<readonly KeyStatus[] | null>(null);
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState<string>(pilot.MODELS.anthropic[0] ?? '');
  const [entry, setEntry] = useState('');
  const [live, setLive] = useState<number | null>(null);
  // The pilot's own books (#145). Read from `localStorage` at mount, because a
  // per-day ceiling that reset when the app restarted would not be a ceiling.
  const [ledger, setLedger] = useState<Ledger>(readLedger);
  const [limits, setLimits] = useState<PilotLimits>(readLimits);
  /** Turns already in the books, so a re-render cannot bill one twice. */
  const counted = useRef<Set<number>>(new Set());
  /** The chain ran out and the pilot is holding for a person. */
  const [stalled, setStalled] = useState(false);

  // Two refs rather than state, because neither is drawn and both must survive
  // StrictMode's double-invoked effects without causing a render.
  const chain = useRef(0);
  const sentAt = useRef(-1);

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

  // Every call that has not been run yet, run. `execute` is pure and `settle`
  // ignores a call it has already answered, so this is safe to re-enter — which
  // it is, on every heartbeat, since the run it reads changes underneath it.
  useEffect(() => {
    for (const reply of conversation.replies) {
      for (const call of reply.calls) {
        if (call.settlement === null) {
          dispatch({ type: 'settle', id: call.id, settlement: execute(call, { run }) });
        }
      }
    }
  }, [conversation.replies, run]);

  // Each finished turn into the pilot's books, once (#145).
  //
  // On the terminal event rather than on each `spent`: a `spent` carries the
  // turn's RUNNING TOTAL, so adding them as they arrive would bill the same
  // tokens once per event - the expensive twin of the undercount `parseClaudeLine`
  // documents on the core side.
  //
  // Only turns the vendor reported usage for. A turn that failed before it said
  // anything spent nothing anyone can attribute, and recording it would put a
  // zero where "measured nothing" belongs and a tick in `unpriced`, which means
  // something else entirely.
  useEffect(() => {
    const fresh = conversation.replies.filter(
      (reply) => reply.outcome !== null && reply.usage !== null && !counted.current.has(reply.turn),
    );
    if (fresh.length === 0) return;
    let next = ledger;
    const at = new Date();
    for (const reply of fresh) {
      counted.current.add(reply.turn);
      if (reply.usage === null) continue;
      next = record(next, costOf(reply.provider, reply.model, reply.usage), at);
    }
    setLedger(next);
    writeLedger(next);
  }, [conversation.replies, ledger]);

  const day = today(ledger, new Date());
  // Checked before a turn rather than during one: a ceiling that stopped a reply
  // half-written would spend the tokens and lose the answer, which is worse than
  // either outcome it is choosing between.
  const verdict = limitVerdict(ledger, limits, new Date());

  const start = useCallback(
    (messages: readonly pilot.Message[], said: string | null) => {
      void pilot
        // The table goes out on every request. Declared from here and executed
        // here, which is what makes "no tool without an implementation" a fact
        // about the file rather than a promise about a list.
        .send({ provider, model, messages, tools: declare() })
        .then((turn) => {
          setLive(turn);
          if (said === null) dispatch({ type: 'follow', turn, provider });
          else dispatch({ type: 'ask', content: said, turn, provider });
        })
        .catch((err: unknown) =>
          dispatch({
            type: 'refuse',
            content: said,
            provider,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
    },
    [model, provider],
  );

  const owed = unanswered(conversation);
  // Every owed call is unsendable, but only a proposal is unsendable *at a
  // person*. The rest are the frame or two between a turn ending and the settle
  // effect running, and saying "waiting on you" about those would be untrue for
  // as long as anybody could read it.
  const proposals = owed.filter((call) => call.settlement?.kind === 'proposes');
  const last = conversation.messages[conversation.messages.length - 1];
  const owesReply = conversation.live === null && owed.length === 0 && last?.role === 'tool';

  // The other half of a tool loop. Keyed on the message count so StrictMode's
  // second pass finds the turn already sent rather than sending it twice.
  useEffect(() => {
    if (!owesReply) return;
    // The pilot's ceiling stops the unattended half too, and this is the
    // unattended half: a chain of tool calls answering itself is exactly the
    // runaway a spend limit exists for (#145). The banner below says which
    // limit stopped it, so this does not look like the stall above.
    if (!verdict.allowed) return;
    if (chain.current >= MAX_CHAIN) {
      // State rather than a ref read during render: nothing else re-renders at
      // this point, so a banner conditioned on the ref would never appear and
      // the pane would just look stuck.
      setStalled(true);
      return;
    }
    if (sentAt.current === conversation.messages.length) return;
    sentAt.current = conversation.messages.length;
    chain.current += 1;
    start(conversation.messages, null);
  }, [owesReply, conversation.messages, start, verdict.allowed]);

  const ready =
    statuses !== null &&
    keys.usable(statuses).includes(provider) &&
    owed.length === 0 &&
    // The pilot's own ceiling, which is off unless somebody set one. It gates
    // the tool loop as well as the composer: a chain of tool calls is exactly
    // the runaway this exists to stop, and stopping only the human's messages
    // would guard the half that is already attended.
    verdict.allowed;

  useEffect(() => {
    onPending?.(proposals.length);
  }, [proposals.length, onPending]);

  const submit = useCallback(() => {
    const content = entry.trim();
    if (content === '' || live !== null) return;
    setEntry('');
    // A person spoke, so the pilot's rope is new again. The ceiling exists to
    // stop it spending unattended, and it is not unattended now.
    chain.current = 0;
    setStalled(false);
    // The whole conversation so far plus this message. Assembled here because
    // this is the only place that knows both, and sent in full: neither vendor
    // remembers a previous request.
    start([...conversation.messages, { role: 'user' as const, content }], content);
  }, [conversation.messages, entry, live, start]);

  const onDecide = useCallback(
    (id: string, accepted: boolean, note: string) => {
      const call = conversation.replies.flatMap((r) => r.calls).find((c) => c.id === id);
      const settlement = call?.settlement;
      if (settlement?.kind !== 'proposes') return;
      // The effect first, the record second. A dispatch that landed and a send
      // that then threw would leave the model told the request went when it did
      // not — and `onEffect` reports its own failure into the output pane.
      if (accepted) onEffect(settlement.effect);
      dispatch({ type: 'decide', id, accepted, note });
      // Answering a proposal is a person acting, so the chain starts over: the
      // reply to this result is a turn they asked for.
      chain.current = 0;
      setStalled(false);
    },
    [conversation.replies, onEffect],
  );

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
        {proposals.length > 0 && (
          <span className="v-pilot__note">
            {proposals.length} proposal(s) waiting on you — nothing more can be sent until they are
            answered, and neither vendor will take a conversation that leaves one open
          </span>
        )}
      </div>

      {/* The pilot's own books, in the pilot's own row (#145).
          NEVER beside the run's figure and never summed with it: the word `cost`
          means two things on one screen — a proxy for work volume beside a run,
          which is not money, and this, which is. Hi-fi 11 solved the harder
          version of the same problem by making the asymmetry the point. */}
      <div className="v-pilot__books">
        <span className="v-pilot__note">{describeDay(day)}</span>
        <PilotLimitFields
          limits={limits}
          onChange={(next) => {
            setLimits(next);
            writeLimits(next);
          }}
        />
      </div>
      {!verdict.allowed && verdict.why !== null && (
        <div className="v-pilot__note v-pilot__note--alarm">
          The pilot has stopped: {verdict.why}
        </div>
      )}

      <div className="v-pilot__log">
        {conversation.replies.length === 0 && conversation.live === null && (
          <div className="v-pilot__note">
            Nothing yet. The pilot can read this run and propose a launch or a gate answer — it
            cannot fire either one, edit vibe.config.json, or read the run archive (#114).
          </div>
        )}
        {conversation.replies.map((reply) => (
          <ReplyCard
            key={reply.turn}
            reply={reply}
            conversation={conversation}
            busy={live !== null}
            onDecide={onDecide}
          />
        ))}
        {conversation.live !== null && (
          <ReplyCard
            reply={conversation.live}
            conversation={conversation}
            busy
            onDecide={onDecide}
          />
        )}
      </div>

      {conversation.unknown > 0 && (
        <div className="v-pilot__note">
          {conversation.unknown} unrecognised event(s) — this window is older than the app
        </div>
      )}

      {stalled && (
        <div className="v-pilot__note">
          It has taken {MAX_CHAIN} turns on its own since you last said anything. Send something to
          let it carry on — the ceiling is here so it cannot keep spending unattended.
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
