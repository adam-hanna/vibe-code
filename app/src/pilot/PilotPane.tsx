import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Button, MetaChip, StateKicker, ThinkingWave } from '../design';
import { elapsed } from '../cockpit/format';
import { logOf } from './log';
import { RoundCard } from './RoundCard';
import * as host from '../host';
import * as keys from './keys';
import * as pilot from './pilot';
import {
  BACKEND_NAME,
  BACKEND_NOTE,
  BACKENDS,
  modelsFor,
  needsKey,
  SUBSCRIPTION_MODELS,
} from './backend';
import type { Backend } from './backend';
import { systemPrompt } from './brief';
import { readEmitted, visible } from './emit';
import { useFollow } from './follow';
import { declare, execute } from './tools';
import { chatKey, readChat, worthSaving, writable } from './saved';
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
  retext,
  settle,
  spendParts,
  trailingResults,
  unanswered,
  unrecognised,
  wake,
} from './transcript';
import type { ReactNode } from 'react';
import type { KeyStatus } from './keys';
import type { Effect, Settlement } from './tools';
import type { Call, Conversation, Reply } from './transcript';
import type { Launched } from '../cockpit/argv';
import type { Commands } from '../cockpit/commands';
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

/** Where the gate watcher's switch is remembered. See `watching` below. */
const WATCH_KEY = 'vibe.pilot.watchGates';

/**
 * Whether the pilot takes a turn when the loop stops at a gate (#211).
 *
 * **Off unless somebody turned it on**, and it is remembered because a setting
 * that reset every launch is one nobody uses. `localStorage` for the reason the
 * spend ceiling is there: it is this window's preference, not a project fact,
 * and `vibe.config.json` is a file meant to be committed.
 */
function readWatch(): boolean {
  try {
    return localStorage.getItem(WATCH_KEY) === 'on';
  } catch {
    // Storage can be unavailable. Falling back to off is the fail-closed
    // direction: the cost of a wrong default here is unattended spend.
    return false;
  }
}

/**
 * What the pilot is told when the run wakes it, and what the reader is shown.
 *
 * One sentence for both, so the message the model answers and the kicker above
 * its reply cannot disagree about why the turn happened. It says plainly that
 * nobody typed it — a model that believed a person had just asked would answer
 * a question nobody put.
 */
function wakeReason(gate: NonNullable<Run['gate']>): string {
  const round =
    gate.reviewRound ?? gate.planRound ?? gate.verifyRound ?? null;
  return [
    `[the app woke you — nobody typed this] The loop has stopped at the "${gate.boundary}" gate` +
      (round === null ? '' : `, round ${String(round)}`) +
      ' and is waiting for a decision.',
    '',
    'The run block above is current as of this message. Read the narration with',
    'read_output before you say anything about what the loop just did.',
    '',
    'Say what you would do and why. If you want to propose the answer, call',
    'answer_gate — it still has to be pressed by the person, and if the right move',
    'is something other than continue or stop, say that instead of proposing.',
  ].join('\n');
}

type Action =
  // `openedAt` on all three, because all three open a turn and a turn's wait is
  // the same wait however it was started. Carried on the action rather than read
  // in `apply`, so the reducer stays a pure function of what it was handed.
  | { type: 'ask'; content: string; turn: number; provider: Backend; openedAt: number }
  | { type: 'wake'; reason: string; turn: number; provider: Backend; openedAt: number }
  | { type: 'follow'; turn: number; provider: Backend; openedAt: number }
  | {
      type: 'refuse';
      content: string | null;
      provider: Backend;
      message: string;
      woke: string | null;
    }
  | { type: 'event'; event: pilot.PilotEvent }
  | { type: 'retext'; turn: number; text: string }
  | { type: 'settle'; id: string; settlement: Settlement }
  | { type: 'decide'; id: string; accepted: boolean; note: string }
  | { type: 'unknown' }
  /** A conversation read back from storage, replacing whatever is here (#223). */
  | { type: 'restore'; conversation: Conversation };

function apply(state: Conversation, action: Action): Conversation {
  switch (action.type) {
    case 'ask':
      return ask(state, action.content, action.turn, action.provider, action.openedAt);
    case 'wake':
      return wake(state, action.reason, action.turn, action.provider, action.openedAt);
    case 'follow':
      return follow(state, action.turn, action.provider, { startedAt: action.openedAt });
    case 'refuse':
      return refuse(state, action.content, action.provider, action.message, action.woke);
    case 'event':
      return reduce(state, action.event);
    case 'retext':
      return retext(state, action.turn, action.text);
    case 'settle':
      return settle(state, action.id, action.settlement);
    case 'decide':
      return decide(state, action.id, action.accepted, action.note);
    case 'unknown':
      return unrecognised(state);
    // Replaces rather than merges. Two conversations interleaved by arrival
    // would be a transcript of a discussion that never happened.
    case 'restore':
      return action.conversation;
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
  if (effect.kind === 'command') {
    // The command as it will be spawned, and **where**. The directory is on the
    // card because it is half of what the command does: `npm install` is a
    // different act in two repositories, and this is the one thing a person
    // cannot check from the command line alone (#211).
    return (
      <pre className="v-proposal__argv">
        {[effect.program, ...effect.args].join(' ')}
        {'\n'}
        {`in ${effect.dir}`}
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
        <Answer content={answer} />
      )}
    </div>
  );
}

/**
 * What a read sent back: that it happened, and the payload behind a disclosure.
 *
 * **The result is the model's, not the reader's**, and this pane was printing it
 * whole. `read_run` returns the entire `describeRun` object and `read_output`
 * returns up to 500 narration lines, so two ordinary calls put several hundred
 * characters of JSON in the middle of a conversation — reported from a manual
 * pass as simply *"what is all of this text?"*, which is the correct question.
 *
 * It is **not truncated**, because a result that has been cut is a result nobody
 * can check against what the model was actually told, and that is the one thing
 * this card exists to make checkable. It is folded, and the summary says how much
 * is behind the fold so the size itself stays visible.
 */
function Answer({ content }: { content: string | null }) {
  if (content === null) return <span className="v-pilot__note">read</span>;
  // Short enough to read in place. A threshold rather than always folding: a
  // one-line refusal or a small object behind a disclosure is a click for
  // nothing, and most of what makes this unreadable is the big two.
  if (content.length <= 160) return <span className="v-pilot__note">{content}</span>;
  return (
    <details className="v-pilot__answer">
      <summary className="v-pilot__note">
        answered with {content.length.toLocaleString()} characters — the model has all of it
      </summary>
      <pre className="v-pilot__payload v-selectable">{content}</pre>
    </details>
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
 * How long this turn has been open, on a card that has not settled (#211).
 *
 * **The part of the thinking indicator a person can actually judge.** The wave
 * beside it says only that this window is still rendering — it would wave just
 * as busily at a vendor that had silently stopped answering — so on its own it
 * replaces one wrong impression with another. `4s` and `3m20s` are different
 * situations, and the number is what tells them apart.
 *
 * Relative rather than absolute, which is the opposite of hi-fi 17's rule for a
 * *settled* card, and for the reason that rule gives: a relative time is a claim
 * that has to keep being true, and this one is re-rendered every second for
 * exactly as long as it is. When the turn ends the whole element goes, so it
 * never ages into a lie the way `last activity 5h39m ago` did.
 *
 * Absent, never zero, when the reply carries no start.
 */
function TurnElapsed({ startedAt, now }: { startedAt: number | null; now: number }) {
  if (startedAt === null) return null;
  return <span className="v-pilot__elapsed">{elapsed(Math.max(0, now - startedAt))}</span>;
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
  now,
}: {
  reply: Reply;
  conversation: Conversation;
  onDecide: (id: string, accepted: boolean, note: string) => void;
  busy: boolean;
  /**
   * The clock, passed in rather than read here.
   *
   * One ticking value for the whole pane: a card reading `Date.now()` itself
   * would only re-render when something else made it, so the elapsed would
   * freeze at whatever second the last token arrived - which is precisely the
   * moment it starts mattering.
   */
  now: number;
}) {
  const outcome = reply.outcome;
  return (
    <div className="v-pilot__turn">
      {/* What you said, above the answer to it (#211). The pane drew replies
          and never messages, so this was missing entirely: you pressed send,
          the composer emptied, and the next thing on screen was an answer to a
          question that was not there.

          Read off the reply rather than interleaved from `messages`, so the
          order cannot be got wrong - a message and the turn it opened are one
          thing here. */}
      {reply.asked !== null && (
        <div className="v-pilot__asked v-selectable">{reply.asked}</div>
      )}
      <div className="v-pilot__reply">
        <div className="v-pilot__meta">
        {/* The pane draws replies and not messages, so without this a woken
            turn is the pilot speaking unprompted with nothing saying why. A
            reader has to be able to tell what they asked for from what the run
            caused (#211). */}
        {reply.woke !== null && <StateKicker tone="quiet">woke at a gate</StateKicker>}
        <MetaChip>{BACKEND_NAME[reply.provider]}</MetaChip>
        {/* What ANSWERED, not what was asked for: an alias resolves to a dated
            version, and the resolved one is the fact worth showing. Absent until
            the vendor says so, rather than filled in from the request. */}
        {reply.model !== null && <MetaChip kind="checkable">{reply.model}</MetaChip>}
        {/* **Three states, not one.** `streaming` was drawn from the instant the
            turn opened, including for the whole wait before a single byte came
            back — when nothing was streaming — and it is a two-word label with
            no motion, which is what was being read as a stall.

            `thinking` is the honest word for *sent, nothing back yet*; once
            text is arriving the text itself is the evidence and the label says
            so. The wave is on both, because both are open turns. */}
        {outcome === null && (
          <>
            <ThinkingWave label={reply.text === '' ? 'thinking' : 'streaming'} />
            <StateKicker tone="accent">{reply.text === '' ? 'thinking' : 'streaming'}</StateKicker>
            <TurnElapsed startedAt={reply.startedAt} now={now} />
          </>
        )}
        {/* The vendor's own word — `end_turn`, `stop`, `max_tokens`, `length`.
            Not translated into a shared spelling, because a shared spelling
            would claim a shared meaning nobody has established. */}
        {outcome?.kind === 'ended' && outcome.stop !== null && <MetaChip>{outcome.stop}</MetaChip>}
        {outcome?.kind === 'cancelled' && <StateKicker tone="quiet">stopped</StateKicker>}
        {outcome?.kind === 'failed' && <StateKicker tone="alarm">failed</StateKicker>}
      </div>

      {/* `visible`, not the raw text: a tool call the subscription backend made
          arrives as a fenced block inside the prose, and the card two lines down
          is a better rendering of it than the JSON that produced it. The raw
          text stays in `Reply.text`, which is the record (#211). */}
      {visible(reply.text) !== '' && (
        <div className="v-pilot__text v-selectable">{visible(reply.text)}</div>
      )}
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
  /**
   * Which providers have a key, as the window last read it. Null until it has.
   *
   * **A prop rather than this pane's own state, and #188 is why.** This pane is
   * mounted for the whole session and hidden rather than unmounted - a
   * conversation is state nobody can get back - so anything it fetched once on
   * mount it holds until the app restarts. It fetched this, the Keys tab fetched
   * its own copy, and storing a key updated only the copy belonging to the form
   * you typed into. The composer stayed disabled behind a snapshot taken before
   * the key existed.
   *
   * One reader, in `Cockpit`, for the same reason it owns the one `host.send`.
   */
  statuses: readonly KeyStatus[] | null;
  /**
   * The repository this conversation is about (#211).
   *
   * Not decoration and not a display field: the subscription backend spawns
   * `claude -p` **in** this directory under `--restricted`, which confines its
   * Read, Glob and Grep to it. So this is the pilot's permission boundary, and
   * an empty one is refused rather than defaulted — a turn in a directory
   * nobody chose is what produced a pilot searching a home directory and timing
   * out on every glob.
   */
  dir: string;
  /**
   * Which run this conversation is about, or null before one exists (#223).
   *
   * **What lets a conversation come back.** Every other pane repopulates from a
   * file the run wrote; a chat *about* a run is the one thing nothing writes
   * down, so opening a finished run drew an empty pane beside six full ones.
   * Keyed with the project, because a run id is unique only inside one archive.
   *
   * Null is the conversation that has not launched anything yet — the one that
   * will propose the run — and it is adopted by the run when one starts.
   */
  runId: string | null;
  /**
   * Commands this window has run, so `read_command` has something to read.
   *
   * A prop rather than this pane's own state, for the reason `statuses` is one:
   * `Cockpit` owns the one sender, and two copies of what has been run would
   * disagree about whether a dev server is still up.
   */
  commands: Commands;
  /**
   * Rendered above the composer while no run exists (#211).
   *
   * A slot rather than the thing itself, so this pane keeps knowing nothing
   * about runs, repositories or argv - `Cockpit` owns all three, and owns the
   * one `host.send` for the same reason.
   */
  kickoff?: ReactNode;
  /**
   * The launch this window sent, or null if it sent none (#191).
   *
   * The brief is the one thing about a run that no frame carries, so it cannot
   * come out of `run` and it cannot come out of a tool. Null is a real state -
   * a window that has launched nothing, or a run started from the CLI - and the
   * prompt says which rather than describing a task nobody gave it.
   */
  launched: Launched | null;
  /**
   * Take the reader to the tab that has a round's detail (hi-fi 5).
   *
   * The design's cards carry `open verify` and the findings themselves, and the
   * card is a **summary** - the prose lives in the round's artifact and behind
   * the pane built for it. Optional, and a card drawn without it simply omits
   * the link rather than drawing a control that does nothing.
   *
   * The **round** travels with the tab (#223): a card summarises one round, so a
   * link that opened the pane at whichever round was newest would be the wrong
   * one every time but the last.
   */
  onOpen?: (tab: string, round?: number | null) => void;
}

export function PilotPane({
  run,
  launched,
  dir,
  runId,
  commands,
  onEffect,
  onPending,
  statuses,
  kickoff,
  onOpen,
}: PilotPaneProps) {
  const [conversation, dispatch] = useReducer(apply, undefined, emptyConversation);
  /**
   * Which conversation is on screen, so a save cannot land in the wrong one.
   *
   * The key is read back **at save time** rather than closed over by the effect
   * that writes, because the two move independently: a run starting changes the
   * key while the conversation is unchanged, and a reply arriving changes the
   * conversation while the key is not. Holding it in a ref means the writer
   * always uses the key the loader last settled on, so the two cannot cross.
   */
  const chat = useRef<string | null>(null);
  /**
   * What is on screen, for the loader to read without depending on it.
   *
   * The loader must fire on the **key** alone — a conversation in its deps would
   * re-run it on every reply, and a loader that runs mid-conversation is a
   * conversation that gets replaced by itself-from-disk. It still needs to see
   * the current one for the adoption case below, so it reads it through here.
   */
  const held = useRef(conversation);
  held.current = conversation;

  // Load when the window is pointed at a different run, and only then.
  useEffect(() => {
    const key = chatKey(dir, runId);
    const before = chat.current;
    if (before === key) return;
    chat.current = key;

    // **Adoption.** A run is *proposed* by a conversation, so when one starts,
    // the exchange that decided what to build is the one already on screen —
    // under the project's own key, because there was no run id to use. Restoring
    // this run's (empty) conversation here would throw that away at the exact
    // moment it succeeded, which is the worst possible time.
    //
    // Narrow on purpose: only the un-launched bucket is ever adopted, and only
    // into a run. Switching between two runs restores, which is what it should.
    if (runId !== null && before === chatKey(dir, null) && worthSaving(held.current)) {
      try {
        localStorage.setItem(key, writable(held.current));
        // Cleared, so the next run in this project starts from nothing rather
        // than inheriting the conversation that launched the previous one.
        localStorage.removeItem(before);
      } catch {
        // The conversation is still on screen and still correct. What is lost is
        // its return next time.
      }
      return;
    }

    try {
      dispatch({ type: 'restore', conversation: readChat(localStorage.getItem(key)) });
    } catch {
      // Storage can be unavailable. An empty pane is a smaller failure than a
      // window that will not render.
      dispatch({ type: 'restore', conversation: emptyConversation() });
    }
  }, [dir, runId]);

  // Save on every settled change. `live` is dropped by `writable`, so a turn in
  // flight is not stored half-streamed and a window killed mid-turn leaves a
  // conversation that ends at the last complete reply.
  useEffect(() => {
    const key = chat.current;
    if (key === null || !worthSaving(conversation)) return;
    try {
      localStorage.setItem(key, writable(conversation));
    } catch {
      // Quota, or storage switched off. The conversation still works for this
      // session; what is lost is its return next time, which is not worth an
      // error in the middle of one.
    }
  }, [conversation]);
  /**
   * Where turns run (#193). **Subscription by default**, because it is the one
   * that works with nothing configured - the whole point of the issue is that an
   * API key is optional rather than a precondition for the pane doing anything.
   */
  const [provider, setProvider] = useState<Backend>('subscription');
  const [model, setModel] = useState<string>(SUBSCRIPTION_MODELS[0] ?? '');
  /**
   * The conversation the CLI is keeping, once it has said what it is (#193).
   *
   * Allocated here on the first turn and then **replaced by whatever the CLI
   * returns**, which is authoritative over ours. Null means the next turn opens
   * a new conversation; a session id means it resumes one, which is what makes a
   * subscription turn cost nothing in re-sent context.
   */
  const session = useRef<string | null>(null);
  /**
   * The host-backed turn whose frames we are listening for, or -1.
   *
   * Its own ref rather than `sentAt`, which counts messages for the tool loop.
   * These are two different numbers and sharing one would make a turn id look
   * like a message count on the frame after somebody changed either.
   */
  const hostTurn = useRef(-1);
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
  /**
   * The conversation follows its own bottom until you scroll away from it.
   *
   * Deliberately not driven by anything this component knows - not `live`, not
   * the reply count - because the question it answers is *where is the reader
   * looking*, and only the reader can move that.
   */
  const log = useFollow<HTMLDivElement>();
  /**
   * The clock behind the elapsed on an open turn (#211).
   *
   * **It ticks only while one is open.** A conversation sitting idle re-renders
   * for nothing otherwise, and there is nothing on a settled card that a second
   * passing changes — every measurement on one is fixed at the moment it ended.
   * `conversation.live` is the condition for the same reason it is the condition
   * for drawing the wave: they are the same claim.
   */
  const [now, setNow] = useState(() => Date.now());
  const open = conversation.live !== null;
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(tick);
    };
  }, [open]);

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

  // Every call that has not been run yet, run. `execute` is pure and `settle`
  // ignores a call it has already answered, so this is safe to re-enter — which
  // it is, on every heartbeat, since the run it reads changes underneath it.
  useEffect(() => {
    for (const reply of conversation.replies) {
      for (const call of reply.calls) {
        if (call.settlement === null) {
          dispatch({
            type: 'settle',
            id: call.id,
            settlement: execute(call, { run, commands, dir }),
          });
        }
      }
    }
    // `commands` in the deps for the reason `run` is: `read_command` is
    // answered from it, and a call settled against a stale copy would report a
    // dev server as having produced nothing (#211).
  }, [conversation.replies, run, commands, dir]);

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

  // The subscription backend's frames, folded into the same conversation the
  // API-backed one produces (#193). Synthesised into `PilotEvent`s rather than
  // given a second reducer: one model of a conversation, whichever wire fed it.
  //
  // No `started` is synthesised, so `Reply.model` stays null. The CLI is asked
  // for a model and may answer on another one, and claiming the one we asked
  // for would be the window stating something it was not told - the same rule
  // the field's own comment states.
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      stop = await host.onPilotFrame((frame) => {
        const turn = frame.id;
        if (turn === null || turn !== hostTurn.current) return;
        if (frame.type === 'pilot_delta') {
          dispatch({ type: 'event', event: { kind: 'text', turn, delta: frame.text } });
          return;
        }
        if (frame.type === 'error') {
          dispatch({ type: 'event', event: { kind: 'failed', turn, message: frame.message } });
          setLive(null);
          return;
        }
        // The CLI's id wins over the one we proposed, always.
        session.current = frame.sessionId;
        // The reply the CLI says it made, over the deltas we accumulated. The
        // deltas are every assistant block in the turn, interstitials between
        // its own Read and Glob calls included; this is the final message. Both
        // came off the wire and this is the one that answers "what did it say".
        dispatch({ type: 'retext', turn, text: frame.text });
        // The tool calls, lifted out of the reply and dispatched **before** the
        // terminal event: `reduce` drops an event for a turn that is no longer
        // live, and `ended` is what closes it. Read from `frame.text`, which is
        // the whole reply, rather than from the deltas we accumulated - a block
        // split across two deltas is still one block in the whole.
        for (const call of readEmitted(frame.text, turn)) {
          dispatch({
            type: 'event',
            event: { kind: 'tool_call', turn, id: call.id, name: call.name, arguments: call.arguments },
          });
        }
        dispatch({
          type: 'event',
          event: {
            kind: 'spent',
            turn,
            usage: {
              input: frame.tokens.input,
              output: frame.tokens.output,
              cache_read: frame.tokens.cacheRead,
              cache_write: frame.tokens.cacheCreation,
            },
          },
        });
        dispatch({ type: 'event', event: { kind: 'ended', turn, stop: null } });
        setLive(null);
      });
      if (cancelled) stop?.();
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const start = useCallback(
    (
      messages: readonly pilot.Message[],
      said: string | null,
      /**
       * Why this turn is happening with nobody at the keyboard, or null.
       *
       * Threaded rather than inferred from `said`, because the two are
       * independent: a woken turn has text to send (a vendor needs something to
       * answer) and it was still not typed by anybody.
       */
      woke: string | null = null,
    ) => {
      /**
       * When the wait started, taken **here** rather than when the request
       * resolves (#211).
       *
       * The turn does not get an id until `pilotTurn`/`send` comes back, and on
       * the subscription path that is a `claude` child being spawned - seconds
       * that are part of the wait a person is sitting through. Stamping the
       * card at the resolution would restart the count from zero after the
       * slowest bit, which is the opposite of what the number is for.
       */
      const openedAt = Date.now();

      // The subscription path. It does not go through Rust at all: the host
      // spawns `claude -p` with the closed read-only allow-list `pilotchat.ts`
      // builds, so there is no key to have and nothing to bill.
      //
      // It declares no tools **over the wire**, because the CLI takes no
      // schemas from us — so `declare()` goes into the system prompt instead and
      // the calls come back in a fenced block that `emit.ts` reads (#211). Same
      // table, same executors, same proposal card; only the channel differs.
      if (!needsKey(provider)) {
        const id = session.current;
        void host
          .pilotTurn({
            // A follow-up carries the tool results, because the CLI has no tool
            // role to put them in and is resumed by session id — so everything
            // else said is already there and the results are the only new
            // thing. An empty prompt here used to be sent instead, which asked
            // the model to answer nothing.
            prompt: said ?? trailingResults(messages) ?? '',
            system: systemPrompt(run, launched, 'emitted'),
            model,
            dir,
            sessionId: id ?? crypto.randomUUID(),
            resume: id !== null,
          })
          .then((turn) => {
            hostTurn.current = turn;
            setLive(turn);
            if (said === null) dispatch({ type: 'follow', turn, provider, openedAt });
            else if (woke !== null)
              dispatch({ type: 'wake', reason: woke, turn, provider, openedAt });
            else dispatch({ type: 'ask', content: said, turn, provider, openedAt });
          })
          .catch((err: unknown) =>
            dispatch({
              type: 'refuse',
              content: said,
              provider,
              message: err instanceof Error ? err.message : String(err),
              woke,
            }),
          );
        return;
      }

      void pilot
        // The table goes out on every request. Declared from here and executed
        // here, which is what makes "no tool without an implementation" a fact
        // about the file rather than a promise about a list.
        //
        // So does the system prompt, rebuilt from the run as it stands at this
        // moment rather than as it stood when the conversation opened (#191). A
        // model is only ever sent the most recent one, so there is no earlier
        // description for this to contradict - see `brief.ts` for why that
        // settles the staleness question rather than trading it away.
        .send({ provider, model, messages, tools: declare(), system: systemPrompt(run, launched) })
        .then((turn) => {
          setLive(turn);
          if (said === null) dispatch({ type: 'follow', turn, provider, openedAt });
          else if (woke !== null) dispatch({ type: 'wake', reason: woke, turn, provider, openedAt });
          else dispatch({ type: 'ask', content: said, turn, provider, openedAt });
        })
        .catch((err: unknown) =>
          dispatch({
            type: 'refuse',
            content: said,
            provider,
            message: err instanceof Error ? err.message : String(err),
            woke,
          }),
        );
    },
    [model, provider, run, launched, dir],
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

  /**
   * Why nothing can be sent, or null. Drawn in the composer, because a disabled
   * field with no reason beside it is the same defect in every product.
   *
   * The **repository** case is the subscription backend's and only its: that
   * turn is a child process that has to run somewhere, and `--restricted` makes
   * where it runs the thing it is allowed to read. Refused rather than defaulted
   * to this window's own directory (#211).
   */
  const blocked: string | null =
    needsKey(provider) && (statuses === null || !keys.usable(statuses).includes(provider))
      ? `no ${keys.PROVIDER_NAME[provider]} key — enter one under Keys`
      : !needsKey(provider) && dir.trim() === ''
        ? 'choose a repository first — this backend runs in one and can read only that one'
        : null;

  const ready =
    // The subscription backend needs no key, which is the whole of #193: the
    // pane does something useful with nothing configured. What it does need is a
    // directory to run in, which is the line above.
    blocked === null &&
    owed.length === 0 &&
    // The pilot's own ceiling, which is off unless somebody set one. It gates
    // the tool loop as well as the composer: a chain of tool calls is exactly
    // the runaway this exists to stop, and stopping only the human's messages
    // would guard the half that is already attended.
    verdict.allowed;

  useEffect(() => {
    onPending?.(proposals.length);
  }, [proposals.length, onPending]);

  /**
   * The gate watcher (#211).
   *
   * **The pilot has always had the run; what it did not have was a reason to
   * look.** `run` is a prop that updates on every frame and `systemPrompt` is
   * rebuilt from it on every turn, so the pilot's picture is current the moment
   * it speaks — it just only ever spoke when somebody typed or when it owed
   * itself a tool result. Reported from a manual pass as the obvious question:
   * *"why do I have to tell it when a gate is finished?"*
   *
   * Four things about it:
   *
   * - **It fires on the transition, keyed by `askId`.** A gate that is still
   *   open on the next render is not a new gate, and `askId` is the loop's own
   *   identity for it rather than something derived here. Nothing fires when a
   *   gate closes: the interesting moment is the one that is waiting.
   * - **It is off by default**, and this is the first turn in the product that
   *   nobody asked for. `MAX_CHAIN` and the daily ledger exist to bound
   *   unattended spend, and a watcher on by default would spend against them
   *   without anybody choosing to.
   * - **It goes through `ready`**, so a missing key, a missing repository, an
   *   outstanding proposal or a spent ceiling all stop it exactly as they stop
   *   the composer. A wake that fired into a blocked pane would be a failed
   *   reply nobody could explain.
   * - **It proposes and never answers.** The turn it takes can call
   *   `answer_gate`, which is propose-only like everything else — so the run
   *   still holds until a person presses. This is a second opinion arriving on
   *   time, not an autopilot.
   */
  const [watching, setWatching] = useState(readWatch);
  /** The gate this pane has already woken for, so an open gate wakes it once. */
  const seenGate = useRef<number | null>(null);
  useEffect(() => {
    const gate = run.gate;
    if (gate === null) {
      // Cleared on close, so the *next* gate wakes it even if the loop reuses
      // an id. Tracking "the last id seen" rather than "every id ever" also
      // means a conversation started mid-run does not wake for a gate that was
      // already open when the pane mounted — that one is on screen already.
      seenGate.current = null;
      return;
    }
    if (!watching || seenGate.current === gate.askId) return;
    // Recorded before the send, not after: a turn refused on its way out must
    // not leave the watcher armed to try the same gate on the next render.
    seenGate.current = gate.askId;
    if (!ready || live !== null) return;
    const reason = wakeReason(gate);
    chain.current = 0;
    setStalled(false);
    start([...conversation.messages, { role: 'user' as const, content: reason }], reason, reason);
  }, [run.gate, watching, ready, live, conversation.messages, start]);

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

  /**
   * The log: this run's rounds and this conversation, in one scroll (hi-fi 5).
   *
   * Memoised on the two things it reads, because `rounds` walks every phase of
   * every cycle and the pane re-renders once a second while a turn is open —
   * that is a clock ticking, not a run changing.
   */
  const entries = useMemo(
    () => logOf(run, conversation.replies),
    [run, conversation.replies],
  );

  return (
    <div className="v-pilot">
      <div className="v-pilot__controls">
        <select
          className="v-pilot__select"
          value={provider}
          onChange={(e) => {
            const next = e.target.value as Backend;
            setProvider(next);
            setModel(modelsFor(next, pilot.MODELS)[0] ?? '');
            // A conversation belongs to the backend that is holding it. Carrying
            // a CLI session id across to a vendor - or back - would resume a
            // conversation on a wire that has never heard of it (#193).
            session.current = null;
          }}
        >
          {BACKENDS.map((p) => (
            <option key={p} value={p}>
              {BACKEND_NAME[p]}
            </option>
          ))}
        </select>
        <select className="v-pilot__select" value={model} onChange={(e) => setModel(e.target.value)}>
          {modelsFor(provider, pilot.MODELS).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {/* What this backend costs, when that is not obvious from its name.
            Empty for the subscription, which is why this is conditional rather
            than a span that renders a blank. */}
        {BACKEND_NOTE[provider] !== '' && (
          <span className="v-pilot__note">{BACKEND_NOTE[provider]}</span>
        )}
        {/* Names what is missing rather than "not ready". One provider
            configured is a supported state, and so is a window that has not
            been pointed at a repository yet - two different absences with two
            different fixes. */}
        {blocked !== null && <span className="v-pilot__note">{blocked}</span>}
        {/* The one switch that lets the pilot spend without anybody typing.
            It said *"speak up at a gate — one turn each, still proposes only"*,
            which is three clauses in the product's own vocabulary and answers
            none of *what happens, when, and what will it cost me*: `gate` is a
            word from `src/gates.ts`, and *proposes only* is true of every tool
            the pilot has. The label is now the behaviour and the tooltip is the
            cost, which is the split the rest of this bar uses. */}
        <label
          className="v-pilot__limit"
          title="One turn each time, and it can only propose — you still press the button."
        >
          <input
            type="checkbox"
            checked={watching}
            onChange={(e) => {
              setWatching(e.target.checked);
              try {
                localStorage.setItem(WATCH_KEY, e.target.checked ? 'on' : 'off');
              } catch {
                // The switch still works for this session. A preference that
                // could not be saved is not worth an error in the pane.
              }
            }}
          />
          <span>Have the pilot weigh in whenever the run stops for you</span>
        </label>
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

      {/* `v-selectable`, because `base.css` turns selection off on `body` — a
          drag across the cockpit chrome should not paint half the app blue, and
          the rule restores it on "anything a user reads or copies". A
          conversation is the most copied thing in the product and was missed:
          the first bug report about it arrived as a screenshot of text nobody
          could select. */}
      {/* Follows the bottom while you leave it there, and stops the instant you
          scroll up — see `follow.ts` for why that state belongs to the reader
          and not to the pane. */}
      <div className="v-pilot__log v-selectable" ref={log.ref} onScroll={log.onScroll}>
        {entries.length === 0 && conversation.live === null && (
          <div className="v-pilot__note">
            Nothing yet. The pilot can read this run and propose a launch or a gate answer — it
            cannot fire either one, edit vibe.config.json, or read the run archive.
          </div>
        )}
        {/* Hi-fi 5: this is the run's log, not a chat beside one. Rounds and
            conversation share the scroll, and `interleave` is where the order
            is decided — a rule that only lived in a `.map` could not be
            tested, and the one thing it must never do is reorder what somebody
            said. */}
        {entries.map((entry) =>
          entry.kind === 'round' ? (
            <RoundCard key={`round-${entry.card.key}`} card={entry.card} onOpen={onOpen} />
          ) : (
            <ReplyCard
              key={`reply-${String(entry.reply.turn)}`}
              reply={entry.reply}
              conversation={conversation}
              busy={live !== null}
              onDecide={onDecide}
              now={now}
            />
          ),
        )}
        {conversation.live !== null && (
          <ReplyCard
            reply={conversation.live}
            conversation={conversation}
            busy
            onDecide={onDecide}
            now={now}
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

      {/* `4h`: the repository and the launch bar sit between the conversation
          and the composer while no run exists. Above the composer rather than
          below it, because the composer is the front door and must stay the
          thing your eye lands on last before typing. */}
      {kickoff}

      <div className="v-pilot__composer">
        <textarea
          className="v-pilot__entry"
          rows={2}
          placeholder={
            blocked ?? 'say what you want built — enter sends, shift+enter is a new line'
          }
          value={entry}
          disabled={!ready}
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // **Enter sends, Shift+Enter is a newline** — the convention every
            // chat surface uses, and the one people arrive with.
            //
            // `isComposing` is the guard that makes this safe rather than
            // merely conventional: an IME commits its candidate with Enter, so
            // without it every Japanese or Chinese word would send the message
            // half-written. The flag is on the native event, not React's.
            if (e.nativeEvent.isComposing) return;
            // Cmd/Ctrl+Enter kept as well. It was the only way to send until
            // now, so it is muscle memory for anyone who used the old build,
            // and it costs nothing to honour both.
            if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
            e.preventDefault();
            submit();
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
