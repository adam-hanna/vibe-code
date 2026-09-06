import type { Provider } from './keys';
import type { Usage } from './pilot';

/**
 * What the pilot has spent, and what that is worth in money (#145).
 *
 * **A second accounting path, parallel to `src/charge.ts` and never through
 * it.** The run's ceiling counts tokens nobody pays for; the pilot spends money.
 * They are not the same tokens, they are not paid for the same way, and one
 * number must never absorb the other.
 *
 * Two rules, and both are structural rather than a promise:
 *
 * - **Nothing here reaches `budget.maxTokens`.** A user sets that number to
 *   bound *a run*. A pilot conversation counting toward it would stop the thing
 *   being built because of a discussion about what to build - reported as
 *   `EXIT.BUDGET`, which means something specific and would now mean two things.
 *   Worse, the same conversation would be free before the run started and
 *   charged to it afterwards, so the number would depend on when you talked.
 * - **`state.json` gains no pilot field.** The run archive records what the loop
 *   did; a conversation *about* the loop is not part of it, and `state.events`
 *   is already explicitly protected from becoming a transcript (#133).
 *
 * ## Why a price table is allowed here and refused for Codex
 *
 * It looks like a contradiction with the settled decision - *"Codex cost is not
 * reported and will not be estimated"* - and it is not. The rule was never
 * "don't report cost". It was **never invent a number**, and the two cases
 * differ in what the number would be *about*:
 *
 * - A Codex turn runs on a subscription. **Nothing is billed at all**, so any
 *   dollar figure is fictional in kind - there is no quantity for it to be an
 *   estimate *of*. `budget.maxCostUsd` says so in its own docblock: on a
 *   subscription it is *"NOT money"*, a proxy for work volume.
 * - A pilot turn runs on an API key. Money moves, the vendor publishes the
 *   usage on every response, and the price per model is published too. The
 *   figure is an **estimate of a real quantity**, and the vendor's own dashboard
 *   is what confirms it.
 *
 * So the pilot is the first place in this product where a dollar is a dollar -
 * and the run remains the place it cannot be reported. That asymmetry is the
 * point rather than an embarrassment, exactly as hi-fi 11 made Claude's
 * `214k tokens` beside Codex's `unknown` the point.
 *
 * What is still refused: calling it *billed*. It is `~$0.04 (estimated from
 * published prices, read 2026-08-15)`, and a model with no entry in the table
 * reports **no figure at all** rather than a plausible one.
 *
 * ## What is deliberately not here
 *
 * **The pilot's own rate-limit state.** The issue asks the question and the
 * answer is not in this file, because it is not an accounting question: a
 * vendor API returns rate limits in *response headers*, where `ratelimits.ts`
 * reads them from a Codex app-server endpoint, and neither adapter captures a
 * header today. Doing it means touching both adapters' response handling, which
 * is #143's ground, and the one thing it must not do when it happens is arrive
 * shaped like `CodexRateLimits` - a shared shape would claim the two mechanisms
 * are one, which is the same mistake `sse.rs` avoids by sharing only a wire
 * format and never a meaning.
 */

/**
 * A published price, with the two things that make it checkable.
 *
 * **A price is a fact with a date.** Every entry says where it was read and
 * when, the UI shows the date beside the figure, and a stale table is therefore
 * visible rather than silently wrong. That is the whole mitigation for the one
 * real hazard of shipping prices in source: they change on the vendor's
 * schedule, not on this repo's.
 *
 * All figures are **US dollars per million tokens**, which is the unit both
 * vendors publish in - converting to per-token here would introduce a rounding
 * decision nobody asked for.
 */
export interface Price {
  provider: Provider;
  /**
   * The vendor's model id, matched as a **prefix** of what the vendor says it
   * answered with.
   *
   * A prefix because an alias resolves to a dated version: asking for
   * `claude-opus-5` can be answered by `claude-opus-5-20260114`, and an exact
   * match would report "no price recorded" for the model whose price is right
   * there. A prefix cannot promote a cheaper model into an expensive one's
   * price: `gpt-5-mini` does not start with `gpt-5-` unless `gpt-5` is listed
   * without the dash, which is why the longest matching prefix wins.
   */
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  /**
   * Null where the vendor has no cache-write charge at all.
   *
   * Not zero. OpenAI does not bill for cache writes and does not report them -
   * `Usage.cache_write` is null on every OpenAI turn - so "there is no such
   * charge" and "the charge is nothing" are recorded as the different facts
   * they are, and neither is used to fill the other in.
   */
  cacheWrite: number | null;
  /** Where this was read. */
  source: string;
  /** When it was read, ISO date. Shown to the user beside the figure. */
  takenOn: string;
}

/**
 * The prices this build knows, newest reading wins.
 *
 * **Deliberately not exhaustive.** A model that is not here reports no dollar
 * figure, which is the honest answer and is a great deal better than the
 * neighbouring model's price wearing this one's name.
 *
 * **Adding an entry means opening the vendor's page and reading it.** Not
 * recalling it, not copying the row above and adjusting: the first draft of this
 * table was written from memory and stamped with the day's date, and when the
 * two pages were actually fetched *every Anthropic figure was wrong* - Opus 5
 * carried $15/$75 against a published $5/$25, which would have overstated every
 * Opus turn by a factor of three. `source` and `takenOn` are what made that
 * checkable, and they are worth nothing if either is written from the same place
 * the numbers were.
 */
export const PRICES: readonly Price[] = [
  {
    provider: 'anthropic',
    model: 'claude-opus-5',
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    source: 'https://claude.com/pricing',
    takenOn: '2026-09-06',
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    source: 'https://claude.com/pricing',
    takenOn: '2026-09-06',
  },
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    source: 'https://claude.com/pricing',
    takenOn: '2026-09-06',
  },
  {
    provider: 'openai',
    model: 'gpt-5-mini',
    input: 0.25,
    output: 2,
    cacheRead: 0.025,
    // Not zero: OpenAI has no cache-write charge to have.
    cacheWrite: null,
    source: 'https://developers.openai.com/api/docs/pricing',
    takenOn: '2026-09-06',
  },
  {
    provider: 'openai',
    model: 'gpt-5',
    input: 1.25,
    output: 10,
    cacheRead: 0.125,
    cacheWrite: null,
    source: 'https://developers.openai.com/api/docs/pricing',
    takenOn: '2026-09-06',
  },
];

/**
 * The price for a model, or null.
 *
 * **Longest prefix wins**, so `gpt-5-mini` cannot be answered by `gpt-5`'s
 * price. Without that rule the table's order would decide what a turn cost,
 * which is the kind of dependency nobody notices until the cheap model is being
 * charged at five times its rate.
 */
export function priceFor(provider: Provider, model: string | null): Price | null {
  if (model === null) return null;
  let best: Price | null = null;
  for (const price of PRICES) {
    if (price.provider !== provider) continue;
    if (!model.startsWith(price.model)) continue;
    if (best === null || price.model.length > best.model.length) best = price;
  }
  return best;
}

/** What a turn cost, and - where it could not be said - why not. */
export interface TurnCost {
  /** Every token the vendor reported, summed. Null when it reported none. */
  tokens: number | null;
  /** US dollars, estimated from published prices. Null when none applies. */
  usd: number | null;
  /** The price used, so the reading can be shown with its date. */
  price: Price | null;
  /**
   * Why there is no dollar figure. Null when there is one.
   *
   * A sentence rather than a code, because it is shown to a person in the place
   * the figure would have been - which is the whole discipline: an absence is
   * drawn as absent *with its reason*, never as a blank and never as a zero.
   */
  why: string | null;
}

const PER_MILLION = 1_000_000;

/**
 * What one turn's reported usage is worth.
 *
 * **Every priced field must have been reported, or there is no figure.** A turn
 * still streaming has an input count and no output count, and pricing the half
 * that arrived would produce a number that rises as the turn goes and is wrong
 * the whole way. The exception is `cache_write` against a vendor that has no
 * such charge, where the absence is not missing information.
 */
export function costOf(provider: Provider, model: string | null, usage: Usage): TurnCost {
  const counted = [usage.input, usage.output, usage.cache_read, usage.cache_write].filter(
    (n): n is number => n !== null,
  );
  const tokens = counted.length === 0 ? null : counted.reduce((a, b) => a + b, 0);
  const price = priceFor(provider, model);

  if (price === null) {
    return {
      tokens,
      usd: null,
      price: null,
      why:
        model === null
          ? 'the vendor has not yet said which model answered'
          : `no published price for ${model} is recorded in this build`,
    };
  }
  if (usage.input === null || usage.output === null || usage.cache_read === null) {
    return {
      tokens,
      usd: null,
      price,
      why: 'the vendor has not reported every count this turn yet',
    };
  }
  // The one absence that is not missing information: a vendor with no
  // cache-write charge reports no cache-write count, and the two agree.
  if (usage.cache_write === null && price.cacheWrite !== null) {
    return {
      tokens,
      usd: null,
      price,
      why: 'this model is charged for cache writes and none were reported',
    };
  }
  const write = usage.cache_write ?? 0;
  const writeRate = price.cacheWrite ?? 0;
  const usd =
    (usage.input * price.input +
      usage.output * price.output +
      usage.cache_read * price.cacheRead +
      write * writeRate) /
    PER_MILLION;
  return { tokens, usd, price, why: null };
}

/**
 * What the pilot has spent, per calendar day.
 *
 * **Per day, not per session and not cumulative.** A run has a natural end and
 * `maxTokens`' shape follows from it; a conversation has neither, so that shape
 * does not transfer. A day is the window both vendors' own dashboards use,
 * which is what makes the figure something a user can reconcile rather than
 * only read.
 *
 * The day is the **local** one, because the person reading it lives in a
 * timezone and a ceiling that rolls over at an unrelated hour is a ceiling
 * nobody can predict. It differs from the vendor's UTC day, and the UI says so
 * rather than pretending the two agree.
 */
export interface DayTotal {
  /** Local date, `YYYY-MM-DD`. */
  day: string;
  tokens: number;
  /**
   * Dollars from the turns that had a price, and how many did not.
   *
   * Two numbers rather than one, for the same reason `Scorecard` carries its
   * denominators: `$1.20` over ten turns means something different when three
   * of them could not be priced, and a total that quietly omitted them would
   * read as the whole bill.
   */
  usd: number;
  unpriced: number;
  turns: number;
}

export interface Ledger {
  /** Every day this build has seen, newest first. */
  days: readonly DayTotal[];
}

export function emptyLedger(): Ledger {
  return { days: [] };
}

/** The local calendar day of an instant, as `YYYY-MM-DD`. */
export function localDay(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * Add one settled turn.
 *
 * Called once per turn, when it ends - not per `spent` event. Each `spent`
 * carries the turn's **running total**, so adding them as they arrive would
 * count the same tokens once per event, which is the undercount's expensive
 * twin and exactly the mistake `parseClaudeLine` documents on the core side.
 *
 * **The caller records only turns the vendor reported usage for**, and that is a
 * rule about what this ledger is: a record of spend. A turn that failed before
 * the vendor said anything spent nothing anyone can attribute, and entering it
 * would put a zero in `tokens` - meaning "measured nothing" - and a tick in
 * `unpriced`, which means "measured, and no price applies". Two different
 * absences, and neither is what happened.
 */
export function record(ledger: Ledger, cost: TurnCost, at: Date): Ledger {
  const day = localDay(at);
  const existing = ledger.days.find((d) => d.day === day);
  const base: DayTotal = existing ?? { day, tokens: 0, usd: 0, unpriced: 0, turns: 0 };
  const updated: DayTotal = {
    day,
    tokens: base.tokens + (cost.tokens ?? 0),
    usd: base.usd + (cost.usd ?? 0),
    unpriced: base.unpriced + (cost.usd === null ? 1 : 0),
    turns: base.turns + 1,
  };
  const others = ledger.days.filter((d) => d.day !== day);
  return { days: [updated, ...others].sort((a, b) => (a.day < b.day ? 1 : -1)) };
}

/**
 * The pilot's own ceiling. Optional, and **off by default**.
 *
 * It is the first real spend in the product and a runaway loop in a chat is as
 * possible as one anywhere else - but a hard default cap on a conversation is
 * the kind of thing that stops you mid-sentence for no good reason, so nothing
 * is enforced until somebody asks for it.
 *
 * Deliberately **not** named `maxTokens` or `maxCostUsd`. Those two are the
 * run's and mean something else; reusing either spelling is how one number
 * absorbs the other three refactors from now.
 */
export interface PilotLimits {
  /** Tokens in one local day, or null for no ceiling. */
  dailyTokens: number | null;
  /** Estimated dollars in one local day, or null for no ceiling. */
  dailyUsd: number | null;
}

export const NO_LIMITS: PilotLimits = { dailyTokens: null, dailyUsd: null };

export interface LimitVerdict {
  /** Whether another turn may be started. */
  allowed: boolean;
  /** Why not, in the words shown to the user. Null when allowed. */
  why: string | null;
}

/**
 * Whether the pilot may send another turn.
 *
 * Checked **before** a turn rather than during one: a ceiling that stopped a
 * reply half-written would spend the tokens and lose the answer, which is worse
 * than either outcome it is choosing between.
 *
 * **The dollar ceiling is checked against a figure that may be an undercount.**
 * A day with unpriced turns has a total that is missing them, so the check says
 * so in the refusal rather than presenting the figure as complete - the reader
 * needs to know the real spend is at least this much, not exactly this much.
 */
export function limitVerdict(ledger: Ledger, limits: PilotLimits, at: Date): LimitVerdict {
  const day = ledger.days.find((d) => d.day === localDay(at));
  if (day === undefined) return { allowed: true, why: null };

  if (limits.dailyTokens !== null && day.tokens >= limits.dailyTokens) {
    return {
      allowed: false,
      why: `the pilot has used ${day.tokens.toLocaleString()} tokens today, at or over its ceiling of ${limits.dailyTokens.toLocaleString()}. This is the pilot's own limit and has nothing to do with the run's budget.`,
    };
  }
  if (limits.dailyUsd !== null && day.usd >= limits.dailyUsd) {
    const caveat =
      day.unpriced === 0
        ? ''
        : ` (and ${day.unpriced} turn${day.unpriced === 1 ? '' : 's'} today could not be priced, so the real figure is higher)`;
    return {
      allowed: false,
      why: `the pilot has spent about $${day.usd.toFixed(2)} today${caveat}, at or over its ceiling of $${limits.dailyUsd.toFixed(2)}. This is the pilot's own limit and has nothing to do with the run's budget.`,
    };
  }
  return { allowed: true, why: null };
}

/** `$0.0412` for small figures, `$1.23` once there is a cent to speak of. */
export function formatUsd(usd: number): string {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/**
 * The day's spend as a sentence.
 *
 * **Never summed with the run's figure and never in the same column.** The word
 * *cost* now means two different things on one screen - a proxy for work volume
 * beside a run, and money beside the pilot - and the discipline that keeps them
 * apart is the same one hi-fi 11 used for Claude's `214k tokens` beside Codex's
 * `unknown`: make the asymmetry the point rather than apologising for it. This
 * string says *pilot* and says *estimated*, in that order, so it cannot be read
 * as the run's.
 */
export function describeDay(day: DayTotal | null): string {
  if (day === null || day.turns === 0) return 'Pilot: nothing spent today.';
  const parts = [`${day.tokens.toLocaleString()} tokens`];
  if (day.unpriced < day.turns) parts.push(`~${formatUsd(day.usd)} estimated`);
  if (day.unpriced > 0) {
    // The denominator, for the reason `DayTotal.unpriced` exists: a figure
    // missing some of its turns must not read as the whole bill.
    parts.push(
      `${day.unpriced} of ${day.turns} turn${day.turns === 1 ? '' : 's'} could not be priced`,
    );
  }
  return `Pilot today: ${parts.join(' · ')}`;
}

/** The day being spent into right now, or null when none has been. */
export function today(ledger: Ledger, at: Date): DayTotal | null {
  return ledger.days.find((d) => d.day === localDay(at)) ?? null;
}

/**
 * Where the ledger and the limits live between sessions.
 *
 * `localStorage`, and deliberately none of the three other candidates. Not
 * `state.json`, which is the run archive and must gain no pilot field. Not the
 * OS keychain, which holds one kind of secret and should not become a settings
 * store. Not `vibe.config.json`, which is a project file meant to be committed -
 * a per-day spend total is a fact about this machine and this person, and
 * committing one to a shared repository is a small privacy leak nobody asked
 * for.
 *
 * **A day ceiling that reset when the app restarted would not be a ceiling**,
 * which is the whole reason any of this is persisted rather than held in a
 * reducer.
 *
 * Every read is total: a missing, unreadable or malformed store returns the
 * empty ledger, because the alternative is a pane that will not open. The cost
 * of failing open here is that a day's accumulated total is lost and the
 * ceiling is briefly generous - against a default of *no ceiling at all*, which
 * is what almost every user is running.
 */
const LEDGER_KEY = 'vibe.pilot.ledger';
const LIMITS_KEY = 'vibe.pilot.limits';

function store(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    // A webview with storage disabled, or a test environment without one.
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One stored day, or null. Every field must be stated and be a number. */
function readDay(raw: unknown): DayTotal | null {
  if (!isRecord(raw)) return null;
  const { day, tokens, usd, unpriced, turns } = raw;
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  for (const n of [tokens, usd, unpriced, turns]) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  }
  return {
    day,
    tokens: tokens as number,
    usd: usd as number,
    unpriced: unpriced as number,
    turns: turns as number,
  };
}

export function readLedger(): Ledger {
  const held = store()?.getItem(LEDGER_KEY);
  if (held === null || held === undefined) return emptyLedger();
  try {
    const raw: unknown = JSON.parse(held);
    if (!isRecord(raw) || !Array.isArray(raw['days'])) return emptyLedger();
    // Each day validated on its own, and a bad one dropped rather than taking
    // the rest with it: a torn entry should cost that day's total, not the
    // month's.
    const days = raw['days'].map(readDay).filter((d): d is DayTotal => d !== null);
    return { days: days.sort((a, b) => (a.day < b.day ? 1 : -1)) };
  } catch {
    return emptyLedger();
  }
}

export function writeLedger(ledger: Ledger): void {
  try {
    store()?.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    // A full or disabled store costs the running total, never the turn.
  }
}

/** A stored ceiling, or none. Null and absent are the same answer here. */
function readLimit(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

export function readLimits(): PilotLimits {
  const held = store()?.getItem(LIMITS_KEY);
  if (held === null || held === undefined) return NO_LIMITS;
  try {
    const raw: unknown = JSON.parse(held);
    if (!isRecord(raw)) return NO_LIMITS;
    return {
      dailyTokens: readLimit(raw['dailyTokens']),
      dailyUsd: readLimit(raw['dailyUsd']),
    };
  } catch {
    // Fails to NO ceiling rather than to some remembered one: a stored value
    // this build cannot read is not a limit the user set.
    return NO_LIMITS;
  }
}

export function writeLimits(limits: PilotLimits): void {
  try {
    store()?.setItem(LIMITS_KEY, JSON.stringify(limits));
  } catch {
    // See `writeLedger`.
  }
}
