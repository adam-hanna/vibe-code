import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { MessageSquare, Send, Square } from 'lucide-react';
import { ThinkingWave } from '../design';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { elapsed } from '../cockpit/format';
import { logOf } from './log';
import { RoundCard } from './RoundCard';
import { Welcome } from './Welcome';
import * as host from '../host';
import * as keys from './keys';
import * as pilot from './pilot';
import { agentOf, BACKEND_NAME, BACKEND_NOTE, backendFor, needsKey, sourceOf } from './backend';
import { CLI_DEFAULT, firstOf, loadApiModels, loadCliModels, optionsFor, useModels, whyNot } from '../cockpit/models';
import type { Backend } from './backend';
import { systemPrompt } from './brief';
import { readEmitted, unique, visible } from './emit';
import { useFollow } from './follow';
import { autoRun, NO_ACCESS } from './access';
import { declare, settleCall } from './tools';
import { chatKey, chatMove, isDraftKey, readChat, replyKey, worthSaving, writable } from './saved';
import { getChat, putChat, useChats } from './chatstore';
import {
  costOf,
  describeDay,
  formatUsd,
  limitVerdict,
  readLedger,
  record,
  today,
  writeLedger,
} from './ledger';
import type { Ledger, PilotLimits } from './ledger';
import {
  adoptSession,
  answerOf,
  ask,
  autoRan,
  clearContext,
  compact,
  COMPACT_PROMPT,
  contextNow,
  describeContext,
  decide,
  emptyConversation,
  follow,
  heldSession,
  measure,
  needsFollow,
  reduce,
  refuse,
  retext,
  settle,
  spendParts,
  trailingResults,
  unanswered,
  unrecognised,
  wake,
  withCarry,
} from './transcript';
import type { Context } from './transcript';
import type { ReactNode } from 'react';
import type { KeyStatus } from './keys';
import type { PilotAccess } from './access';
import type { Effect, Settlement } from './tools';
import type { Call, Conversation, Reply } from './transcript';
import type { Launched } from '../cockpit/argv';
import { line, outcome } from '../cockpit/commands';
import { memory } from '../memory';
import { Markdown } from './Markdown';
import type { Command, Commands } from '../cockpit/commands';
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

/**
 * How long a running command has to stay quiet before it counts as up (#223).
 *
 * **A shape rather than a duration**, the same standing as `MISSED_TICKS` in the
 * core: what is being detected is a process that has finished saying what it
 * says on startup, and every dev server here does that in one burst — Vite
 * prints its banner and stops, `node --watch` prints ready and stops. Two
 * seconds is long enough that a burst arriving in several chunks is one event
 * and short enough that the answer arrives while somebody is still looking.
 *
 * It is not a claim that the server is *working*. It is a claim that it has
 * stopped writing, which is the measurable half, and the wake says exactly that
 * rather than "it started".
 */
const SETTLED_MS = 2_000;

/**
 * What a command has done that is worth waking the pilot for.
 *
 * Two states and not one, because they need opposite readings: a command that
 * **ended** has an exit code and is over, and one that has gone **quiet** is
 * still running and has finished starting up. A dev server only ever reaches the
 * second, and it is the one that answers *"did it start?"*.
 */
type CommandNews = 'ended' | 'quiet';

function commandWake(command: Command, news: CommandNews): string {
  const head =
    news === 'ended'
      ? `[the app woke you — nobody typed this] The command "${line(command)}" (${command.id}) has ended — ${outcome(command) ?? 'no outcome recorded'}.`
      : `[the app woke you — nobody typed this] The command "${line(command)}" (${command.id}) is still running and has written nothing for ${String(SETTLED_MS / 1000)}s, which usually means it has finished starting up.`;
  return [
    head,
    '',
    'Read it with read_command before you say anything about it — this message',
    'carries no output, deliberately, so that what you report is what you read.',
    'Take the "cursor" from the answer and pass it back as "since" next time, so',
    'a later read gives you only what is new.',
    '',
    news === 'quiet'
      ? 'Say whether it came up, and name the port or URL from what it actually printed rather than from a config file. If it did not come up, say what the output shows and what you would try.'
      : 'Say what it did, and whether that is what was wanted. If it failed, quote the part of the output that says why.',
  ].join('\n');
}

/** Where the gate watcher's switch is remembered. See `watching` below. */
const WATCH_KEY = 'vibe.pilot.watchGates';

/*
 * The pane's recurring styles, named once (the UI rework).
 *
 * Utilities rather than a stylesheet, so an element and its look are in one
 * place and `pilot.css` could go. Every colour is a token through `theme.css`,
 * so `audit:contrast` still decides whether a pairing is legible. Only what
 * recurs enough to drift is named.
 */
/** A sentence about the conversation: a reading, a reason, a count. */
const NOTE = 'text-body-sm text-secondary';
/** Why a call or a turn went wrong, in the model's or the vendor's own words. */
const WHY = 'whitespace-pre-wrap text-body-sm text-emphasis [overflow-wrap:anywhere]';
/** A monospace block read whole - an argv, a payload - that scrolls past its cap rather than truncating. */
const BLOCK =
  'm-0 overflow-auto whitespace-pre-wrap rounded-sm border border-rule-inner bg-panel font-mono text-mono-sm [overflow-wrap:anywhere]';
/** A field in the pane's own chrome: the two pickers and a proposal's reply. */
const FIELD =
  'h-7 min-w-0 rounded-sm border border-rule-control bg-card px-2 font-sans text-body-sm text-primary outline-none placeholder:text-tertiary focus-visible:ring-1 focus-visible:ring-accent-border';
/** A tool call as one row of the reply: the name, then what came of it. */
const CALL = 'flex flex-wrap items-baseline gap-2 rounded-sm border border-rule-inner px-2.5 py-1.5';
/** Why send is off, on its own line. Named so `composer.test.ts` can find the one line that draws it. */
const BLOCKED = 'border-t border-rule-card bg-active px-4 py-1.5 text-label text-secondary';
/** A sentence that stops the pane: a spent ceiling, a conversation that is not being saved. */
const ALARM = 'bg-alarm px-4 py-1.5 text-body-sm text-emphasis';

/**
 * Whether the pilot takes a turn when the loop stops at a gate (#211).
 *
 * **Off unless somebody turned it on**, and it is remembered because a setting
 * that reset every launch is one nobody uses. The window's memory for the reason the
 * spend ceiling is there: it is this window's preference, not a project fact,
 * and `vibe.config.json` is a file meant to be committed.
 */
function readWatch(): boolean {
  try {
    return memory.getItem(WATCH_KEY) === 'on';
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
  /** A proposal the person's settings ran without a card (#223). */
  | { type: 'auto'; id: string; why: string }
  | { type: 'unknown' }
  /** The pilot summarising itself, to carry into a fresh context (#223). */
  | { type: 'compact'; turn: number; provider: Backend; openedAt: number }
  /** The session the CLI says the live turn ran in. */
  | { type: 'adopt'; turn: number; sessionId: string }
  /** How full the conversation was when the live turn ended. */
  | { type: 'measure'; turn: number; context: Context | null }
  /** Forget what the pilot holds; the log stays. */
  | { type: 'clear' }
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
    case 'auto':
      return autoRan(state, action.id, action.why);
    case 'unknown':
      return unrecognised(state);
    case 'compact':
      return compact(state, action.turn, action.provider, action.openedAt);
    case 'adopt':
      return adoptSession(state, action.turn, action.sessionId);
    case 'measure':
      return measure(state, action.turn, action.context);
    case 'clear':
      return clearContext(state);
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
      <pre className={cn(BLOCK, 'max-h-64 p-3 text-primary')}>
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
      <pre className={cn(BLOCK, 'max-h-64 p-3 text-primary')}>
        {[effect.program, ...effect.args].join(' ')}
        {'\n'}
        {`in ${effect.dir}`}
      </pre>
    );
  }
  if (effect.kind === 'stop_command') {
    // The id alone, because that is what is being acted on. The summary above
    // the card already carries the command line, and repeating it here as if it
    // were the argv would draw a command about to be *run*.
    return <pre className={cn(BLOCK, 'max-h-64 p-3 text-primary')}>{`stop ${effect.commandId}`}</pre>;
  }
  return (
    <pre className={cn(BLOCK, 'max-h-64 p-3 text-primary')}>{JSON.stringify(effect.decision, null, 2)}</pre>
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
    // Bordered and set apart, because it is not another line of chat: the run
    // does not move until somebody answers it, and it has to read that way at
    // a glance. One primary button - the act the card is for - and a quiet no.
    <div className="flex flex-col gap-3 rounded-md border border-accent-border-dim bg-card p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="accent">proposed</Badge>
        <Badge>{call.name}</Badge>
      </div>
      <div className="text-body text-emphasis">{summary}</div>
      <EffectDetail effect={effect} />
      <div className={NOTE}>
        Nothing has been sent. This is the same request the button makes, and it goes down the same
        wire — so what it does is what you would get from the window yourself.
      </div>
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => onDecide(true, note)}>
          run it
        </Button>
        <input
          className={cn(FIELD, 'flex-1 bg-panel')}
          placeholder="what to tell the pilot (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Button variant="quiet" disabled={busy} onClick={() => onDecide(false, note)}>
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
      <div className={CALL}>
        <Badge>{call.name}</Badge>
        <span className={WHY}>its arguments do not parse: {call.unreadable}</span>
      </div>
    );
  }
  if (settlement === null) {
    return (
      <div className={CALL}>
        <Badge>{call.name}</Badge>
        <span className={NOTE}>waiting to be run</span>
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
    <div className={cn(CALL, 'flex-col items-stretch gap-1')}>
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge>{call.name}</Badge>
        {settlement.kind === 'refused' ? (
          <span className={WHY}>{settlement.content}</span>
        ) : (
          <Answer content={answer} />
        )}
      </div>
      {/* What it was, once it has been answered (#223). A command the safe list
          ran was never drawn as a card, so this is the only place the exact
          program and arguments appear — and "what runs is what was displayed"
          has to hold after the fact when it could not hold before. */}
      {settlement.kind === 'proposes' && <EffectDetail effect={settlement.effect} />}
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
  if (content === null) return <span className={NOTE}>read</span>;
  // Short enough to read in place. A threshold rather than always folding: a
  // one-line refusal or a small object behind a disclosure is a click for
  // nothing, and most of what makes this unreadable is the big two.
  if (content.length <= 160) return <span className={cn(NOTE, '[overflow-wrap:anywhere]')}>{content}</span>;
  return (
    <details className="min-w-0 flex-1">
      <summary className={cn(NOTE, 'cursor-pointer select-none')}>
        answered with {content.length.toLocaleString()} characters — the model has all of it
      </summary>
      <pre className={cn(BLOCK, 'mt-2 max-h-56 select-text px-3 py-2 text-secondary')}>{content}</pre>
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
  // An absent figure carries its reason, in the place the figure would have
  // been. Dimmer than the figure, because it is a statement about the
  // measurement rather than a measurement.
  if (cost.usd === null) {
    return <span className="text-tertiary"> · cost: {cost.why}</span>;
  }
  return (
    <span className="text-secondary">
      {' · '}~{formatUsd(cost.usd)} estimated
      {cost.price !== null && (
        <span className="text-tertiary"> (published prices, read {cost.price.takenOn})</span>
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
  // Monospace and tabular, because it re-renders every second and proportional
  // digits make the row jump sideways on each tick - motion that means nothing,
  // beside the one indicator whose motion is supposed to mean something.
  return (
    <span className="font-mono text-body-sm tabular-nums text-secondary">
      {elapsed(Math.max(0, now - startedAt))}
    </span>
  );
}


/**
 * That a turn is open, pinned to the foot of the log (#223).
 *
 * It sat in the live card's header, so a reply that streamed more than a
 * screen pushed it out of view, and so did scrolling up to re-read: *"the
 * 'Thinking...' needs to always be at the bottom so the user can see it"*. A
 * direct child of the scrolling log with `position: sticky`, so it holds the
 * bottom edge wherever the reader is, and drawn only while a turn is open.
 * It is still the one pulse on screen, and the elapsed still travels with it.
 */
function TurnWorking({
  reply,
  now,
}: {
  reply: Reply;
  /**
   * The clock, passed in rather than read here: one ticking value for the
   * whole pane, so the elapsed does not freeze at the second the last token
   * arrived - which is precisely the moment it starts mattering.
   */
  now: number;
}) {
  const word = reply.text === '' ? 'thinking' : 'streaming';
  // Sticky inside the scrolling log, so it holds the bottom edge wherever the
  // reader is; `mt-auto` puts it at the foot of a short log as well. The panel
  // ground is so text scrolling under it does not show through.
  return (
    <div
      className="sticky bottom-0 mt-auto flex flex-none items-center gap-2 border-t border-rule-structure bg-panel py-2"
      role="status"
    >
      <ThinkingWave label={word} />
      <Badge variant="accent">{word}</Badge>
      <TurnElapsed startedAt={reply.startedAt} now={now} />
    </div>
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
    <div className="flex flex-col gap-2">
      {/* What you said, above the answer to it (#211). The pane drew replies
          and never messages, so this was missing entirely: you pressed send,
          the composer emptied, and the next thing on screen was an answer to a
          question that was not there.

          Read off the reply rather than interleaved from `messages`, so the
          order cannot be got wrong - a message and the turn it opened are one
          thing here. */}
      {/* **Labelled, because the reply beside it is.** The pilot's half carries a
          chip naming the backend and yours carried nothing but a 2px rule, so in
          a long log the two ran together: *"we need to more easily differentiate
          between my message and the pilot's messages. Right now, its too hard for
          me to tell which is which."* The chip is the same vocabulary the answer
          uses rather than a second one, and the ground is what makes the two
          scannable apart without reading either. */}
      {/* **Your half is mirrored, and only your half** (#223). Bounded at 80%
          and pulled right, hugging its text so the right edge is a line and
          the left is ragged - the shape that reads as "the other speaker" at a
          glance. The reply keeps the whole column, because a proposal card
          holding an argv has to stay readable. The text inside stays
          left-aligned: a right-aligned paragraph has a ragged left edge, and
          the left edge is the one the eye returns to on every line. Newlines
          survive, because they are the reason shift+enter exists. */}
      {reply.asked !== null && (
        <div className="flex max-w-[80%] flex-col items-end gap-1.5 self-end rounded-md border border-rule-card bg-active px-3.5 py-2.5">
          <Badge>you</Badge>
          <div className="self-stretch select-text whitespace-pre-wrap text-left text-body text-primary [overflow-wrap:anywhere]">
            {reply.asked}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2 self-stretch border-l-2 border-accent-border-dim py-1 pl-4">
        <div className="flex flex-wrap items-center gap-1.5">
        {/* The pane draws replies and not messages, so without this a woken
            turn is the pilot speaking unprompted with nothing saying why. A
            reader has to be able to tell what they asked for from what the run
            caused (#211). */}
        {reply.woke !== null && <Badge>woke at a gate</Badge>}
        {/* A compaction is a turn nobody typed, so it says what it is (#223). */}
        {reply.compacts === true && <Badge>compacting context</Badge>}
        <Badge>{BACKEND_NAME[reply.provider]}</Badge>
        {/* What ANSWERED, not what was asked for: an alias resolves to a dated
            version, and the resolved one is the fact worth showing. Absent until
            the vendor says so, rather than filled in from the request. A model
            name is an identifier, so it keeps its own case and face. */}
        {reply.model !== null && (
          <Badge className="font-mono font-normal normal-case tracking-normal text-secondary">{reply.model}</Badge>
        )}
        {/* **Three states, not one.** `streaming` was drawn from the instant the
            turn opened, including for the whole wait before a single byte came
            back — when nothing was streaming — and it is a two-word label with
            no motion, which is what was being read as a stall.

            `thinking` is the honest word for *sent, nothing back yet*; once
            text is arriving the text itself is the evidence and the label says
            so. The wave is on both, because both are open turns. */}
        {/* The open turn's indicator is not drawn here any more: it is
            `TurnWorking`, pinned to the foot of the log, because at the top of a
            card it scrolled away as soon as the reply grew. */}
        {/* The vendor's own word — `end_turn`, `stop`, `max_tokens`, `length`.
            Not translated into a shared spelling, because a shared spelling
            would claim a shared meaning nobody has established. */}
        {outcome?.kind === 'ended' && outcome.stop !== null && <Badge>{outcome.stop}</Badge>}
        {outcome?.kind === 'cancelled' && <Badge>stopped</Badge>}
        {outcome?.kind === 'failed' && <Badge variant="alarm">failed</Badge>}
      </div>

      {/* `visible`, not the raw text: a tool call the subscription backend made
          arrives as a fenced block inside the prose, and the card two lines down
          is a better rendering of it than the JSON that produced it. The raw
          text stays in `Reply.text`, which is the record (#211). Drawn as
          Markdown (`Markdown.tsx`), because that is what the pilot writes and
          the prompt now says it is rendered: as preformatted text a table
          arrived as rows of pipes. */}
      {visible(reply.text) !== '' && <Markdown text={visible(reply.text)} />}
      {outcome?.kind === 'failed' && <div className={WHY}>{outcome.message}</div>}
      {reply.compacts === true && outcome?.kind === 'ended' && reply.text !== '' && reply.calls.length === 0 && (
        <div className={NOTE}>
          the pilot carries on from this summary — it no longer holds the conversation above it
        </div>
      )}

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
        <div className={NOTE}>
          {spendParts(reply.usage).join(' · ')}
          <TurnPrice reply={reply} />
        </div>
      )}
      {reply.usage === null && outcome !== null && (
        <div className={NOTE}>
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
  /**
   * The pilot's own daily ceiling, owned by `Cockpit` (#223).
   *
   * **A prop rather than this pane's own state**, because the control that sets
   * it moved to Settings — *"move pilot tokens and pilot $/day out of pilot chat
   * and into the same settings group"*. A ceiling is a setting, and one set
   * beside the conversation it limits was the only setting in the product with
   * no home on the settings screen. Lifting it is what lets a change there reach
   * an open pane, which is the same arrangement the type scale has.
   */
  limits: PilotLimits;
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
   * Whether `runId` is a run the window was **pointed at** rather than one it
   * started (#223).
   *
   * Only `Cockpit` can answer it — `viewing` is where the window is pointed and
   * this pane cannot see it — and `chatMove` needs it to tell *adopting* from
   * *browsing*. Without it, clicking a past run that had no conversation
   * carried the conversation on screen into it, so the chat never changed and
   * the exchange was written into the wrong run's key on the way past.
   */
  opened: boolean;
  /**
   * Commands this window has run, so `read_command` has something to read.
   *
   * A prop rather than this pane's own state, for the reason `statuses` is one:
   * `Cockpit` owns the one sender, and two copies of what has been run would
   * disagree about whether a dev server is still up.
   */
  commands: Commands;
  /**
   * What the pilot may do without asking (#223), as the host resolved it from
   * the settings for all projects. Null until it has been read, which is the
   * narrowest answer: every proposal is a card.
   */
  access: PilotAccess | null;
  /**
   * Rendered above the composer while no run exists (#211).
   *
   * A slot rather than the thing itself, so this pane keeps knowing nothing
   * about runs, repositories or argv - `Cockpit` owns all three, and owns the
   * one `host.send` for the same reason.
   */
  kickoff?: ReactNode;
  /**
   * A brief somebody typed somewhere else, to be said here (#223).
   *
   * **The composer in `1b` is the front door and it was bypassing this pane
   * entirely.** It built an argv and started a run, so a brief typed into it
   * never reached the pilot — reported exactly that way: *"in the pilot chat, my
   * request didn't show up and the pilot isn't doing anything."* The intake
   * doctrine was written and nothing was routed through it.
   *
   * It arrives as a prop rather than a method for the reason `kickoff` is a
   * slot: `Cockpit` owns what a run is and this pane owns what a conversation
   * is, and a handle reaching in would be a second way to put words in one.
   *
   * Sent as something the PERSON said — not a `wake` — because they typed it.
   */
  ask?: string | null | undefined;
  /** Called once it has been said, so the same brief cannot be sent twice. */
  onAsked?: (() => void) | undefined;
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
  opened,
  commands,
  access,
  onEffect,
  onPending,
  limits,
  statuses,
  kickoff,
  ask,
  onAsked,
  onOpen,
}: PilotPaneProps) {
  const [conversation, dispatch] = useReducer(apply, undefined, emptyConversation);
  /** Call ids read back from storage, which never run without a press (#223). */
  const restored = useRef(new Set<string>());
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

  // Load when the window is pointed at a different run, and only then - and
  // not before the stored conversations have been read at all (#223), or the
  // first restore would find nothing and the first save would write that
  // nothing over a conversation that was there.
  const chats = useChats();
  useEffect(() => {
    if (!chats.ready) return;
    const key = chatKey(dir, runId);
    const before = chat.current;
    const stored = getChat(key);
    const move = chatMove({
      from: before,
      to: key,
      intoRun: runId !== null,
      // Pointed at, rather than started here. Adoption is for the run this
      // conversation PROPOSED; opening one from the sidebar is a read, and it
      // used to carry the chat along with it (#223).
      opened,
      stored: stored !== null,
      holding: worthSaving(held.current),
    });
    if (move === 'stay') return;
    chat.current = key;

    // **Adoption.** A run is *proposed* by a conversation, so when one starts,
    // the exchange that decided what to build is the one already on screen —
    // wherever it happened to be typed. That last clause is the fix: it used to
    // adopt only out of the project bucket, so a brief typed while a past run
    // was open went to *that* run's key and the run it proposed started empty.
    //
    // It never adopts over a conversation the target already has, which is what
    // keeps a **resume** safe: that run has its own exchange and it is the one
    // worth keeping.
    if (move === 'adopt') {
      try {
        putChat(key, writable(held.current));
        // Cleared, so the next run in this project starts from nothing rather
        // than inheriting the conversation that launched the previous one. Only
        // the project bucket is cleared: taking a *run's* key away here would
        // delete a real conversation to tidy up after a move.
        const bucket = chatKey(dir, null);
        if (before === bucket) putChat(bucket, null);
        // And a draft's, which is the same case one step later (#223): the run
        // the draft asked for has now started and holds the conversation, so the
        // draft's copy would only come back as a duplicate.
        else if (before !== null && isDraftKey(before)) putChat(before, null);
        // A run's own chat that proposed this one keeps its record but gives
        // up its CLI session (#223): the new run carries it on, and two chats
        // resuming one session would each answer from the other's messages.
        else if (before !== null) {
          putChat(before, writable({ ...held.current, session: null, carry: null }));
        }
      } catch {
        // The conversation is still on screen and still correct. What is lost is
        // its return next time.
      }
      return;
    }

    const back = readChat(stored);
    // Restoring is browsing. Historical usage is already in the books, and a
    // saved tool result must not resume an unattended vendor request.
    for (const reply of back.replies) counted.current.add(replyKey(reply));
    sentAt.current = back.messages.length;
    // Every call that came back from storage is one nobody in this session saw
    // asked for, so none of them may run without a press (#223) — a `git
    // commit` from yesterday's conversation must not fire because the window
    // reopened. They still settle, and a proposal among them is a card.
    for (const reply of back.replies) for (const call of reply.calls) restored.current.add(call.id);
    dispatch({ type: 'restore', conversation: back });
  }, [dir, runId, opened, chats.ready]);

  // Save on every settled change. `live` is dropped by `writable`, so a turn in
  // flight is not stored half-streamed and a window killed mid-turn leaves a
  // conversation that ends at the last complete reply.
  useEffect(() => {
    const key = chat.current;
    if (key === null || !worthSaving(conversation)) return;
    // To the host's files, debounced (#223). A failure is no longer swallowed:
    // `useChats` carries it and the pane says so, because a conversation that
    // is silently not being saved is how three days of them were lost.
    putChat(key, writable(conversation));
  }, [conversation]);
  /**
   * Where turns run (#193). **Subscription by default**, because it is the one
   * that works with nothing configured - the whole point of the issue is that an
   * API key is optional rather than a precondition for the pane doing anything.
   */
  /**
   * Which vendor this conversation talks to (#223). The conversation picks the
   * vendor and Settings picks the road — its CLI on the subscription, or the
   * API — so the backend is derived and never chosen here.
   */
  const [vendor, setVendor] = useState<keys.Provider>('anthropic');
  const provider: Backend = backendFor(vendor, access ?? NO_ACCESS);
  // The model is the one picked, or else the first the road's own listing
  // offers (#223) - which for a CLI is `default`, so the pilot follows the CLI
  // as a run does. Before the listing has answered a CLI still has its default,
  // and an API road has nothing to send until its vendor says what the key may
  // use.
  const listings = useModels();
  const listing = listings[sourceOf(provider)];
  const [picked, setPicked] = useState<string | null>(null);
  const model = picked ?? firstOf(listing) ?? (needsKey(provider) ? '' : CLI_DEFAULT);
  const setModel = setPicked;
  useEffect(() => {
    if (needsKey(provider)) loadApiModels(provider);
    else loadCliModels();
  }, [provider]);
  // The conversation the CLI is keeping is `conversation.session` now, stored
  // with the chat (#223) - see `Session` for the two defects a ref here had. It
  // names its backend, so a session is never resumed on a wire that has never
  // heard of it (#193), and a turn taken on another backend retires it.
  const heldBy = useRef<Backend>(provider);
  useEffect(() => {
    if (heldBy.current === provider) return;
    heldBy.current = provider;
    setModel(null);
  }, [provider]);
  /**
   * The host-backed turn whose frames we are listening for, or -1.
   *
   * Its own ref rather than `sentAt`, which counts messages for the tool loop.
   * These are two different numbers and sharing one would make a turn id look
   * like a message count on the frame after somebody changed either.
   */
  const hostTurn = useRef(-1);
  /**
   * What makes this window's emitted call ids its own (#223).
   *
   * **A turn id is unique within one window session; a conversation is not.**
   * `nextRequestId` restarts at 0 on every launch and `saved.ts` restores the
   * conversation — tool results and all — so `emit:<turn>:<n>` from this session
   * could land on an id a *previous* session had already answered. `settle`
   * correctly refuses to answer a call twice, so the new one was never settled
   * at all and the pane drew **waiting to be run** for ever, with nothing
   * anywhere saying why. That is the defect behind *"I asked the pilot to start
   * the app"* and three dead reads in a row.
   *
   * Random, and deliberately so: the axis the collision is on is *which window
   * session produced this*, and there is no monotonic source that survives a
   * relaunch to count it with. It is generated **here**, at the one place whose
   * lifetime is the window's, and passed into `readEmitted`, which stays pure.
   */
  const origin = useRef(crypto.randomUUID().slice(0, 8));
  /**
   * Everything the model has said this turn, for the tool parse (#223).
   *
   * A ref rather than reducer state because the frame handler is registered once
   * and would otherwise close over a stale conversation - the same reason
   * `hostTurn` is one. Keyed by turn so a new turn starts from nothing rather
   * than inheriting the last one's prose, which would re-raise its calls.
   */
  const whole = useRef<{ turn: number; text: string }>({ turn: -1, text: '' });
  const [entry, setEntry] = useState('');
  /** The composer's field, so a starter can hand it focus without a selector. */
  const entryRef = useRef<HTMLTextAreaElement>(null);
  const [live, setLive] = useState<number | null>(null);
  // The pilot's own books (#145). Read from the window's memory at mount, because a
  // per-day ceiling that reset when the app restarted would not be a ceiling.
  const [ledger, setLedger] = useState<Ledger>(readLedger);
  /** Turns already in the books, so a re-render cannot bill one twice. */
  const counted = useRef<Set<string>>(new Set());
  /** The chain ran out and the pilot is holding for a person. */
  const [stalled, setStalled] = useState(false);
  /**
   * The conversation follows its own bottom until you scroll away from it.
   *
   * Deliberately not driven by anything this component knows - not `live`, not
   * the reply count - because the question it answers is *where is the reader
   * looking*, and only the reader can move that.
   */
  const log = useFollow<HTMLDivElement>(conversation.replies.length > 0 || conversation.live !== null || run.cycles.length > 0);
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
    // The browser preview has no Tauri event bridge to subscribe to.
    if (!host.inShell()) return;
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

  // Every call that has not been run yet, run. `settleCall` is pure and `settle`
  // ignores a call it has already answered, so this is safe to re-enter — which
  // it is, on every heartbeat, since the run it reads changes underneath it.
  //
  // Two outcomes are not settled on the spot (#223). A **read** is asked of the
  // host and settled when it answers, held in `reading` meanwhile so a re-entry
  // does not ask twice. And a **proposal the person's settings allow** is fired
  // and answered as having run without asking — through `onEffect`, the road a
  // pressed one takes, so the safe list changes who presses and never what runs.
  const reading = useRef(new Set<string>());
  const granted = access ?? NO_ACCESS;
  useEffect(() => {
    for (const reply of conversation.replies) {
      for (const call of reply.calls) {
        if (call.settlement !== null || reading.current.has(call.id)) continue;
        const out = settleCall(call, { run, commands, dir, access: granted });
        if (out.kind === 'reads') {
          reading.current.add(call.id);
          const id = call.id;
          void host
            .fs(out.op, dir, out.path)
            .then((frame) =>
              dispatch({ type: 'settle', id, settlement: { kind: 'ran', content: JSON.stringify(frame) } }),
            )
            .catch((err: unknown) =>
              dispatch({
                type: 'settle',
                id,
                settlement: { kind: 'refused', content: err instanceof Error ? err.message : String(err) },
              }),
            )
            .finally(() => reading.current.delete(id));
          continue;
        }
        dispatch({ type: 'settle', id: call.id, settlement: out });
        const why =
          out.kind === 'proposes' && !restored.current.has(call.id)
            ? autoRun(out.effect, dir, granted)
            : null;
        if (out.kind === 'proposes' && why !== null) {
          // The effect first, then the record, for `onDecide`'s reason. The
          // chain is deliberately NOT reset: nobody pressed anything, so this
          // is the unattended half `MAX_CHAIN` exists to bound.
          onEffect(out.effect);
          dispatch({ type: 'auto', id: call.id, why });
        }
      }
    }
    // `commands` in the deps for the reason `run` is: `read_command` is
    // answered from it, and a call settled against a stale copy would report a
    // dev server as having produced nothing (#211).
  }, [conversation.replies, run, commands, dir, granted, onEffect]);

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
      (reply) => reply.outcome !== null && reply.usage !== null && !counted.current.has(replyKey(reply)),
    );
    if (fresh.length === 0) return;
    let next = ledger;
    const at = new Date();
    for (const reply of fresh) {
      counted.current.add(replyKey(reply));
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
    if (!host.inShell()) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      stop = await host.onPilotFrame((frame) => {
        const turn = frame.id;
        if (turn === null || turn !== hostTurn.current) return;
        if (frame.type === 'pilot_delta') {
          // Kept for the parse, not for the display (#223). The pane shows the
          // final message - `retext` below replaces the accumulated text with it
          // on purpose, because the interstitials are the model talking to itself
          // between its own file reads. But a tool call written in one of those
          // is still a tool call, and it used to be dropped.
          if (whole.current.turn !== turn) whole.current = { turn, text: '' };
          whole.current.text += frame.text;
          dispatch({ type: 'event', event: { kind: 'text', turn, delta: frame.text } });
          return;
        }
        if (frame.type === 'error') {
          dispatch({ type: 'event', event: { kind: 'failed', turn, message: frame.message } });
          setLive(null);
          return;
        }
        // Stopped from this pane's own button (#223): drawn as stopped, the
        // vocabulary the API-backed road already uses for the same act.
        if (frame.type === 'pilot_stopped') {
          dispatch({ type: 'event', event: { kind: 'cancelled', turn } });
          setLive(null);
          return;
        }
        // The CLI's id wins over the one we proposed, always.
        dispatch({ type: 'adopt', turn, sessionId: frame.sessionId });
        // Before `ended`, which closes the turn this lands on. A host older
        // than the field sends none, and that is an unmeasured turn.
        dispatch({ type: 'measure', turn, context: frame.context ?? null });
        // The reply the CLI says it made, over the deltas we accumulated. The
        // deltas are every assistant block in the turn, interstitials between
        // its own Read and Glob calls included; this is the final message. Both
        // came off the wire and this is the one that answers "what did it say".
        dispatch({ type: 'retext', turn, text: frame.text });
        /**
         * The tool calls, lifted out of **everything the model said this turn**.
         *
         * Dispatched before the terminal event, because `reduce` drops an event
         * for a turn that is no longer live and `ended` is what closes it.
         *
         * **It used to read `frame.text` alone, and that is the final message
         * rather than the whole reply** (#223). `readDelta` yields every assistant
         * block in the turn - including the interstitials between the model's own
         * `Read` and `Glob` calls - while `result.result` is only the last one. So
         * a model that wrote a `vibe-tool` block, then went on reading files, then
         * summarised, had its call silently thrown away: no card, no refusal,
         * nothing. And the model does not know that, so it says what it did -
         * *"I put up two `gh` cards and you want the second one"* - over a
         * transcript with no cards in it, which is as confusing as this product
         * has been.
         *
         * The old comment's reason for using `frame.text` was real and is kept:
         * a block split across two deltas is one block in the whole. Concatenating
         * the deltas satisfies that too, which is why this is a strict
         * improvement rather than a trade - and `unique` handles the one thing it
         * adds, a model that repeats its own block in the summary.
         */
        const said = whole.current.turn === turn ? whole.current.text : '';
        for (const call of unique(readEmitted(`${said}
${frame.text}`, turn, origin.current))) {
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
      /** This turn is the pilot writing the summary a compaction carries (#223). */
      compacting = false,
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
        const id = heldSession(held.current, provider);
        void host
          .pilotTurn({
            agent: agentOf(provider),
            // A follow-up carries the tool results, because the CLI has no tool
            // role to put them in and is resumed by session id — so everything
            // else said is already there and the results are the only new
            // thing. An empty prompt here used to be sent instead, which asked
            // the model to answer nothing.
            //
            // A new session after a compaction opens with the summary, which is
            // the whole of how the compaction reaches the next conversation.
            prompt: withCarry(id === null ? held.current.carry : null, said ?? trailingResults(messages) ?? ''),
            system: systemPrompt(run, launched, 'emitted', access, agentOf(provider)),
            model,
            dir,
            sessionId: id ?? crypto.randomUUID(),
            resume: id !== null,
          })
          .then((turn) => {
            hostTurn.current = turn;
            setLive(turn);
            if (compacting) dispatch({ type: 'compact', turn, provider, openedAt });
            else if (said === null) dispatch({ type: 'follow', turn, provider, openedAt });
            else if (woke !== null)
              dispatch({ type: 'wake', reason: woke, turn, provider, openedAt });
            else dispatch({ type: 'ask', content: said, turn, provider, openedAt });
          })
          .catch((err: unknown) =>
            dispatch({
              type: 'refuse',
              // A refused compaction is drawn without the prompt as though
              // somebody had typed it.
              content: compacting ? null : said,
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
        .send({ provider, model, messages, tools: declare(), system: systemPrompt(run, launched, 'native', access) })
        .then((turn) => {
          // Rust's turn ids and the host's request ids are two counters, so a
          // stale host turn could share this number and send the stop button
          // down the wrong road (#223).
          hostTurn.current = -1;
          setLive(turn);
          if (compacting) dispatch({ type: 'compact', turn, provider, openedAt });
          else if (said === null) dispatch({ type: 'follow', turn, provider, openedAt });
          else if (woke !== null) dispatch({ type: 'wake', reason: woke, turn, provider, openedAt });
          else dispatch({ type: 'ask', content: said, turn, provider, openedAt });
        })
        .catch((err: unknown) =>
          dispatch({
            type: 'refuse',
            content: compacting ? null : said,
            provider,
            message: err instanceof Error ? err.message : String(err),
            woke,
          }),
        );
    },
    [model, provider, run, launched, dir, access],
  );

  const owed = unanswered(conversation);
  // Every owed call is unsendable, but only a proposal is unsendable *at a
  // person*. The rest are the frame or two between a turn ending and the settle
  // effect running, and saying "waiting on you" about those would be untrue for
  // as long as anybody could read it.
  const proposals = owed.filter((call) => call.settlement?.kind === 'proposes');
  const owesReply = needsFollow(conversation, sentAt.current);

  // A compaction or a clear shrinks the wire (#223). The count this compares
  // against has to shrink with it, or the conversation growing back through the
  // old number would read as already sent and a tool result would go unanswered.
  useEffect(() => {
    if (conversation.messages.length < sentAt.current) sentAt.current = conversation.messages.length;
  }, [conversation.messages.length]);

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
   * Why nothing can be **sent**, or null. Drawn beside the composer, because a
   * disabled control with no reason beside it is the same defect in every
   * product — and this one had it three times over.
   *
   * **It used to answer for two of the five reasons and disable the textarea
   * for all of them**, so a pane holding an undecided proposal, or one that had
   * spent its daily ceiling, was a box that could not be clicked into, under a
   * placeholder cheerfully inviting you to say what you wanted built. Reported
   * as *"my pilot chat won't allow me to click inside of it and enter text"* —
   * which is exactly what it looks like from outside, since a disabled
   * `textarea` cannot even take focus.
   *
   * The **repository** case is the subscription backend's and only its: that
   * turn is a child process that has to run somewhere, and `--restricted` makes
   * where it runs the thing it is allowed to read. Refused rather than defaulted
   * to this window's own directory (#211).
   */
  const blocked: string | null =
    needsKey(provider) && (statuses === null || !keys.usable(statuses).includes(provider))
      ? `no ${keys.PROVIDER_NAME[provider]} key — enter one in Settings, or switch ${keys.PROVIDER_NAME[provider]} to your subscription there`
      : model === ''
        ? whyNot(listing) === null
          ? `waiting for ${keys.PROVIDER_NAME[vendor]} to list the models this key may use`
          : 'no model to send — type one beside the picker'
      : !needsKey(provider) && dir.trim() === ''
        ? 'Add a project in the sidebar to send your first message.'
        : !verdict.allowed
          ? // The ceiling is the pilot's own and is off unless somebody set one,
            // so the sentence names where it is set. `why` is the ledger's own
            // wording rather than a second one written here.
            `${verdict.why ?? "the pilot's daily ceiling is spent"} — raise it under Settings, or wait for tomorrow`
          : proposals.length > 0
            ? // The one that is not a fault. A proposal appends no tool result,
              // so the conversation is unsendable until somebody decides — which
              // is what makes propose-only structural rather than promised
              // (#144). Naming it turns a dead box into an instruction.
              `answer the ${proposals.length === 1 ? 'proposal' : `${String(proposals.length)} proposals`} above first — run it or decline, and the pilot carries on`
            : owed.length > 0
              ? // The frame or two between a turn ending and the settle effect
                // running. It clears itself, so this says so rather than
                // reading as a state somebody has to get out of.
                'running what the pilot asked for…'
              : null;

  const ready = blocked === null;

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

  /**
   * Say a brief that was typed in the composer (#223).
   *
   * **This is what makes the intake doctrine reachable.** Without it the
   * doctrine was advice to a model nobody was talking to: `1b` went straight to
   * an argv, so the only way into the conversation was to type into it a second
   * time.
   *
   * Two things keep it from misbehaving. It is keyed on the **value** rather
   * than on having run, so StrictMode's second pass finds the brief already said
   * instead of saying it twice. And it **defers rather than drops** when the pane
   * cannot send — no repository, a proposal outstanding, a spent ceiling — by
   * leaving `ask` alone until `ready` flips, so the brief is not silently lost
   * at the one moment somebody is watching for it. The composer already says why
   * send is off.
   */
  const asked = useRef<string | null>(null);
  useEffect(() => {
    const want = ask ?? null;
    if (want === null || want === asked.current) return;
    if (!ready || live !== null) return;
    asked.current = want;
    // A person spoke, so the rope is new - the same reset `submit` does, since
    // this is the same act arriving through another door.
    chain.current = 0;
    setStalled(false);
    start([...conversation.messages, { role: 'user' as const, content: want }], want);
    onAsked?.();
  }, [ask, ready, live, conversation.messages, start, onAsked]);

  /**
   * The command watcher (#223).
   *
   * **The pilot could start a process and then had no way to find out what it
   * did.** It proposed `npm run dev`, the person pressed it, and the only thing
   * that could tell the pilot how it went was the pilot asking — so it asked
   * blind, twice, before the server had written anything, and then reported the
   * truth: *"my last read didn't come back."* The verdict was exact and is the
   * whole reason this exists: *"I need it to be able to know when things started
   * up."*
   *
   * Two states wake it, once each per command, and they are different facts. A
   * command that **ended** has an outcome. A command that is still running and
   * has gone quiet for `SETTLED_MS` after writing something has **finished
   * starting up** — which is the only measurable form of "it came up", and the
   * wake says so in those words rather than claiming the server works.
   *
   * ## Why this one is on and the gate watcher is off
   *
   * The gate watcher is off by default because a gate opens when the loop
   * reaches it, possibly hours later with nobody in the room, and AGENTS.md
   * records it as *"the first turn in the product that nobody asked for"*. This
   * is the opposite end of that scale: a command exists because somebody pressed
   * **run it** in this window seconds earlier, on a proposal that usually says
   * in as many words that the pilot will read it back. Waking to finish the
   * sentence it started is not an unattended turn; it is the second half of an
   * attended one.
   *
   * It is bounded the same way everything unattended here is — `ready` covers
   * the ceiling, the key, the repository and any outstanding proposal, and
   * `MAX_CHAIN` and the ledger bound the chain it starts.
   *
   * **It carries no output.** The wake says a command changed state and tells the
   * model to go and read it, so what the pilot reports is something it read
   * rather than something the app told it — which is the same reason
   * `read_output` exists beside the narration the pane already draws.
   */
  const woken = useRef<Map<string, CommandNews>>(new Map());
  useEffect(() => {
    if (!ready || live !== null) return;

    const say = (command: Command, news: CommandNews): void => {
      woken.current.set(command.id, news);
      const reason = commandWake(command, news);
      chain.current = 0;
      setStalled(false);
      start([...conversation.messages, { role: 'user' as const, content: reason }], reason, reason);
    };

    for (const command of commands.all) {
      // One read back from an earlier launch is history, not news: whatever it
      // did, it did to a conversation that is over (#223).
      if (command.restored) continue;
      const seen = woken.current.get(command.id);
      // An end outranks a quiet: a server that came up and then fell over has
      // two things worth saying and the second is the one that matters.
      if (command.endedAt !== null) {
        if (seen !== 'ended') {
          say(command, 'ended');
          return;
        }
        continue;
      }
      // Nothing written yet is a command that has not begun, not one that is
      // quiet. Waking here would report a process nobody could describe.
      if (seen !== undefined || command.bytes === 0) continue;
      // The timer is the measurement. Every new chunk re-renders this effect,
      // whose cleanup clears the pending one — so the window restarts on each
      // write and fires only once the writing has actually stopped.
      const timer = setTimeout(() => {
        // Re-read at the moment it fires: the run may have moved on, and a
        // command that ended in the meantime is handled by the branch above on
        // the render that ending caused.
        say(command, 'quiet');
      }, SETTLED_MS);
      return () => clearTimeout(timer);
    }
    return;
  }, [commands, ready, live, conversation.messages, start]);

  const contextState = contextNow(conversation, provider);
  const contextLine = describeContext(contextState, !needsKey(provider));
  // Both need a context worth emptying, and a turn that is not running.
  // Compacting is a turn, so it also needs everything a send needs.
  const holding = contextState.kind === 'measured' || contextState.kind === 'unmeasured';
  const canCompact = holding && live === null && ready;
  const canClear = (holding || contextState.kind === 'compacted') && live === null;
  const compactNow = useCallback(() => {
    if (live !== null || !ready) return;
    // A person pressed it, so this is an attended turn and the chain starts over.
    chain.current = 0;
    setStalled(false);
    start([...conversation.messages, { role: 'user' as const, content: COMPACT_PROMPT }], COMPACT_PROMPT, null, true);
  }, [conversation.messages, live, ready, start]);

  const submit = useCallback(() => {
    const content = entry.trim();
    // `ready` is checked HERE as well as on the button, because the field is no
    // longer disabled: Enter reaches this with a proposal outstanding, and a
    // send that went anyway would put a message on a conversation both vendors
    // reject for holding an unanswered tool call.
    if (content === '' || live !== null || !ready) return;
    setEntry('');
    // A person spoke, so the pilot's rope is new again. The ceiling exists to
    // stop it spending unattended, and it is not unattended now.
    chain.current = 0;
    setStalled(false);
    // The whole conversation so far plus this message. Assembled here because
    // this is the only place that knows both, and sent in full: neither vendor
    // remembers a previous request.
    start([...conversation.messages, { role: 'user' as const, content }], content);
  }, [conversation.messages, entry, live, ready, start]);

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
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-rule-structure px-4 py-2">
        <select
          className={cn(FIELD, 'max-w-45')}
          aria-label="Pilot provider"
          value={vendor}
          // The session and the model follow in the effect on `provider`.
          onChange={(e) => setVendor(e.target.value === 'openai' ? 'openai' : 'anthropic')}
        >
          {/* The vendor alone (#223): *"you don't need to say 'codex
              (subscription)'… The settings page dictates if the cli or api key
              is used."* Which road is said once, in Settings, not twice. */}
          {keys.PROVIDERS.map((v) => (
            <option key={v} value={v}>
              {keys.PROVIDER_NAME[v]}
            </option>
          ))}
        </select>
        <select
          className={cn(FIELD, 'max-w-45')}
          aria-label="Pilot model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          {optionsFor(listing, model).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        {listing === null && <span className={NOTE}>asking for the models…</span>}
        {whyNot(listing) !== null && <span className={NOTE}>no model list: {whyNot(listing)}</span>}
        {/* With no list there is still a way to name one: a CLI falls back to its
            own default, and an API road has nothing until a name is typed. */}
        {whyNot(listing) !== null && (
          <input
            className={cn(FIELD, 'max-w-45')}
            aria-label="Pilot model name"
            placeholder="model name"
            defaultValue={picked ?? ''}
            onBlur={(e) => setPicked(e.target.value.trim() === '' ? null : e.target.value.trim())}
          />
        )}
        {/* What this backend costs, when that is not obvious from its name.
            Empty for the subscription, which is why this is conditional rather
            than a span that renders a blank. */}
        {BACKEND_NOTE[provider] !== '' && <span className={NOTE}>{BACKEND_NOTE[provider]}</span>}
        {/* Names what is missing rather than "not ready". One provider
            configured is a supported state, and so is a window that has not
            been pointed at a repository yet - two different absences with two
            different fixes. */}
        {/* The one switch that lets the pilot spend without anybody typing.
            It said *"speak up at a gate — one turn each, still proposes only"*,
            which is three clauses in the product's own vocabulary and answers
            none of *what happens, when, and what will it cost me*: `gate` is a
            word from `src/gates.ts`, and *proposes only* is true of every tool
            the pilot has. The label is now the behaviour and the tooltip is the
            cost, which is the split the rest of this bar uses. */}
        <label
          className="ml-auto flex items-center gap-1.5 text-body-sm text-secondary"
          title="One turn each time, and it can only propose — you still press the button."
        >
          <input
            type="checkbox"
            className="accent-accent"
            checked={watching}
            onChange={(e) => {
              setWatching(e.target.checked);
              try {
                memory.setItem(WATCH_KEY, e.target.checked ? 'on' : 'off');
              } catch {
                // The switch still works for this session. A preference that
                // could not be saved is not worth an error in the pane.
              }
            }}
          />
          <span>Help at run checkpoints</span>
        </label>
        {proposals.length > 0 && (
          <span className={NOTE}>
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
      {/* The books say what the day cost; the CEILING on it moved to Settings
          (#223). *"Move pilot tokens and pilot $/day out of pilot chat and into
          the same settings group"* - a ceiling is a setting, and setting one
          beside the conversation it limits made it the only setting in the
          product with no home on the settings screen. What stays here is the
          reading, because that is about this conversation and nothing else. */}
      <div className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-rule-structure px-4 py-1.5">
        <span className={NOTE}>{describeDay(day)}</span>
        {/* How full the pilot's context is, and the two ways to empty it (#223).
            Beside the books rather than on a card, because it is about the
            conversation as a whole and the next turn, not about one reply.
            Emphasis rather than a ground past 80%: a ground would make one
            sentence look like a halt banner. */}
        <span className="flex flex-wrap items-center gap-2">
          <span className={cn(NOTE, contextLine.alarm && 'text-emphasis')}>{contextLine.text}</span>
          {/* `secondary`, not `quiet`: a bordered button on the card ground.
              Drawn quiet, the two read as labels beside the figure and were
              reported as not looking clickable. */}
          <Button
            variant="secondary"
            size="sm"
            disabled={!canCompact}
            title="The pilot writes a summary of this conversation, and carries on from the summary in a fresh context. The log above stays."
            onClick={compactNow}
          >
            compact
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!canClear}
            title="The pilot forgets this conversation and starts its next turn with nothing. The log above stays."
            onClick={() => dispatch({ type: 'clear' })}
          >
            clear
          </Button>
        </span>
      </div>
      {!verdict.allowed && verdict.why !== null && (
        <div className={ALARM}>The pilot has stopped: {verdict.why}</div>
      )}

      {/* `select-text`, because `base.css` turns selection off on `body` — a
          drag across the cockpit chrome should not paint half the app blue, and
          the rule restores it on "anything a user reads or copies". A
          conversation is the most copied thing in the product and was missed:
          the first bug report about it arrived as a screenshot of text nobody
          could select. */}
      {/* Follows the bottom while you leave it there, and stops the instant you
          scroll up — see `follow.ts` for why that state belongs to the reader
          and not to the pane. */}
      <div
        className="flex min-h-0 flex-1 select-text flex-col gap-4 overflow-y-auto px-6 py-5"
        ref={log.ref}
        onScroll={log.onScroll}
      >
        {entries.length === 0 && conversation.live === null && (
          /* **Two different emptinesses, and they were drawn as one.** With no
             run, this is the conversation that has not started — the front door.
             Beside a *run*, it means that run has no conversation stored, which
             is a fact about this window's memory and not about the run: a run
             started from the CLI never had one here, and one from a build before
             `saved.ts` did not either. Saying *"nothing yet"* over an opened run
             reads as the pane having failed to load something, which is exactly
             how it was reported — *"nor do I see the pilot chat update"*. */
          <div className="flex min-h-min flex-1 flex-col justify-center">
            {runId === null ? (
              <>
                {/* **The front door describes the flow, not the permissions
                    table** (#223). It used to open with what the pilot cannot
                    do, which is the wrong first sentence for the first thing
                    anybody reads — and one clause of it was false: the
                    subscription pilot reads `.vibe/runs` like any other
                    directory, which is a correction the system prompt already
                    made and this copy had not. What a person needs here is what
                    happens when they type, because it is no longer obvious: the
                    reply is questions rather than a run. */}
                <Welcome
                  onPrompt={(prompt) => {
                    setEntry(prompt);
                    // A starter prepares a message. Sending is still the person's action.
                    entryRef.current?.focus();
                  }}
                />
              </>
            ) : (
              <div className="m-auto flex max-w-105 flex-col items-center gap-2 text-center text-secondary">
                <MessageSquare size={28} className="text-accent-muted" aria-hidden="true" />
                <h2 className="m-0 text-section text-display">A fresh conversation about this run</h2>
                <p className="m-0 text-body">
                  There is no saved chat here. Explore its plans and reports above, or ask the pilot
                  about the work. New messages will be saved with this run.
                </p>
              </div>
            )}
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
          ) : entry.reply.cleared === true ? (
            // Where the pilot's memory starts again: a rule across the log with
            // the reason on it, because a cleared context is a fact about every
            // reply after it.
            <div
              key={`reply-${String(entry.reply.turn)}`}
              className="flex items-center gap-3 text-body-sm text-tertiary before:h-px before:flex-1 before:bg-rule-structure after:h-px after:flex-1 after:bg-rule-structure"
              role="separator"
            >
              context cleared — the pilot remembers nothing above this line
            </div>
          ) : (
            <ReplyCard
              key={`reply-${String(entry.reply.turn)}`}
              reply={entry.reply}
              conversation={conversation}
              busy={live !== null}
              onDecide={onDecide}
            />
          ),
        )}
        {conversation.live !== null && (
          <ReplyCard
            reply={conversation.live}
            conversation={conversation}
            busy
            onDecide={onDecide}
          />
        )}
        {conversation.live !== null && conversation.live.outcome === null && (
          <TurnWorking reply={conversation.live} now={now} />
        )}
      </div>

      {/* A conversation that is not being saved says so (#223). Swallowing this
          is how three days of chats were lost without a word on screen. */}
      {chats.failure !== null && <div className={ALARM}>{chats.failure}</div>}
      {!chats.ready && chats.failure === null && host.inShell() && (
        <div className={cn(NOTE, 'px-4 py-1.5')}>reading saved conversations…</div>
      )}

      {conversation.unknown > 0 && (
        <div className={cn(NOTE, 'px-4 py-1.5')}>
          {conversation.unknown} unrecognised event(s) — this window is older than the app
        </div>
      )}

      {stalled && (
        <div className={cn(NOTE, 'px-4 py-1.5')}>
          It has taken {MAX_CHAIN} turns on its own since you last said anything. Send something to
          let it carry on — the ceiling is here so it cannot keep spending unattended.
        </div>
      )}

      {/* `4h`: the repository and the launch bar sit between the conversation
          and the composer while no run exists. Above the composer rather than
          below it, because the composer is the front door and must stay the
          thing your eye lands on last before typing. */}
      {kickoff}

      {/* **Why send is off, said out loud.** A control that cannot be used and
          does not say why is the same defect everywhere, and here it was worse
          than usual: the textarea was disabled too, so the answer to "why can I
          not type" was not reachable by clicking on anything. */}
      {blocked !== null && <div className={BLOCKED}>{blocked}</div>}

      {/* The composer is one bordered box: the field has no border of its own
          and the box takes the accent while anything inside it has focus. */}
      <div className="mx-4 mt-2 flex flex-none items-end gap-2 rounded-lg border border-rule-control bg-card p-2.5 focus-within:border-accent-border">
        <textarea
          ref={entryRef}
          className="min-h-14 min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-0.5 font-sans text-body text-primary outline-none placeholder:text-tertiary"
          aria-label="Message your pilot"
          rows={2}
          placeholder="What would you like to build, improve, or figure out?"
          value={entry}
          // **Never disabled.** Composing and sending are two acts, and only the
          // second of them can be blocked: a proposal waiting to be answered, a
          // spent ceiling and a missing key are all reasons the message cannot
          // GO, not reasons it cannot be written. Disabling the field threw away
          // whatever was half-typed the moment a proposal arrived, and left a
          // box that could not take focus with no explanation in reach (#223).
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
          <Button
            variant="primary"
            size="icon"
            aria-label="Send message"
            disabled={!ready || entry.trim() === ''}
            onClick={submit}
          >
            <Send size={16} aria-hidden="true" />
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => {
              // A refusal here means the turn ended between the render and the
              // click. Not worth a message: the terminal event is about to
              // redraw this button anyway.
              //
              // **Two roads, and the button has to take the right one** (#223).
              // A subscription turn is a `claude` child of the HOST; an API turn
              // is a stream in Rust. Asking Rust to cancel the first was refused
              // and swallowed, so the button did nothing on the default backend.
              if (live === hostTurn.current) void host.stopPilot(live).catch(() => {});
              else void pilot.cancel(live).catch(() => {});
            }}
          >
            <Square size={12} aria-hidden="true" /> stop
          </Button>
        )}
      </div>
      <p className="mx-4 my-2 text-label text-tertiary">
        Enter to send <span className="px-1">·</span> Shift + Enter for a new line
      </p>
    </div>
  );
}
