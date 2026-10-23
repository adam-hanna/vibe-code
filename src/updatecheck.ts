import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from '@src/cli.js';
import { globalConfigPath, loadConfig } from '@src/config.js';

/**
 * Tell a terminal user when a newer `vibe` is on npm (#323).
 *
 * **The one network request in `src/`, and the only place one may live.** The
 * core used to make every external call as a child process, and this reverses
 * that for exactly one thing, by the owner's decision on #323 (2026-10-20): an
 * HTTP GET with Node's built-in `fetch`, rather than `npm view` as a child.
 * Shelling out to npm would have kept the old sentence true, but it depends on
 * `npm` being on PATH - which a `vibe` installed by another package manager, or
 * run under a node from a version manager, need not have - and `npm view` is a
 * whole second Node process starting: measured on the owner's dev machine
 * (2026-10-22) at 0.59 to 0.95s over three tries, where the GET alone took 0.24
 * to 0.34s over five.
 *
 * How narrow the exception is, which is the whole of what makes it acceptable:
 * - **One unauthenticated GET of public metadata,** `REGISTRY_URL`. No query,
 *   no identifier, no cookie, no credential, no body. What leaves the machine
 *   is what any `npm view` of a public package sends.
 * - **No dependency.** `fetch` is Node's own; `keys.test.ts` pins
 *   `dependencies` to `{}` and that stays true.
 * - **Bounded.** `TIMEOUT_MS`, through an `AbortSignal`, and at most one request
 *   a day (`CHECK_EVERY_MS`), cached next to the global config.
 * - **Terminal only, after the command.** `src/main.ts` is the one caller and
 *   it asks only once `main()` has returned and its exit code is set, so the
 *   check can neither run before a run's first output nor change how it ends.
 *   The host (`src/hostmain.ts` → `serve.ts`) never imports this module, so no
 *   frame can carry the line.
 * - **Off** under `CI`, when stdout is not a terminal, with
 *   `VIBE_NO_UPDATE_CHECK=1` and with `updates.check: false`.
 *
 * `update-check-guard.test.ts` greps `src/` for any other `fetch(` or network
 * module import, so the exception cannot quietly spread.
 */

export const REGISTRY_URL = 'https://registry.npmjs.org/@adam-hanna/vibe-code/latest';

/**
 * 2 seconds. The request was measured from the owner's dev machine at 0.24 to
 * 0.34s over five tries (2026-10-22, a 1,930-byte response), so this is about
 * six times the slowest. It is also the most the end of a command can be held
 * up, and that at most once a day, because a check that failed is cached like
 * one that succeeded.
 */
export const TIMEOUT_MS = 2_000;

/** A day: the issue's *"at most one check a day"*, not a measurement. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** The commands whose end may carry the line. `resume`, `list` and the rest never do. */
export const NOTICE_COMMANDS: readonly string[] = ['run', 'plan', 'doctor'];

/** The line itself. One sentence, and the command that acts on it. */
export function updateNotice(latest: string, current: string): string {
  return `vibe ${latest} is available (you have ${current}): npm install -g @adam-hanna/vibe-code`;
}

// ---- Versions -----------------------------------------------------------------

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

// Semver 2.0.0's own grammar, which is what `package.json`'s `version` follows:
// no leading zeros on a numeric part, a pre-release after `-`, build metadata
// after `+` (which takes no part in precedence).
const NUM = '0|[1-9]\\d*';
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER_RE = new RegExp(
  `^v?(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

function parseSemVer(v: string): SemVer | null {
  const m = SEMVER_RE.exec(v.trim());
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] === undefined ? [] : m[4].split('.'),
  };
}

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  // A numeric identifier always has lower precedence than an alphanumeric one.
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semver precedence: -1 when `a` is older than `b`, 0 when equal, 1 when newer,
 * and **null when either is not a version** - fail closed, so a registry that
 * answers with something unexpected produces no line rather than a wrong one.
 *
 * A pre-release sorts below its release (`1.8.0-rc.1` < `1.8.0`) and above the
 * release before it (`1.8.0-rc.1` > `1.7.1`); build metadata is ignored.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseSemVer(a);
  const y = parseSemVer(b);
  if (x === null || y === null) return null;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] > y[key] ? 1 : -1;
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;
  const n = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const c = compareIdentifiers(p, q);
    if (c !== 0) return c > 0 ? 1 : -1;
  }
  return 0;
}

/** True only when `latest` is strictly newer; anything unparsable is false. */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) === 1;
}

// ---- The switches ---------------------------------------------------------------

function envOn(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== '' && t !== '0' && t !== 'false';
}

/**
 * Why the check is off, or null when it may run. Every reason is a sentence so
 * a test can say which one fired. `configCheck` is `updates.check`, or null when
 * the config could not be read - which is off too, since a guard that cannot
 * read its input does not assume the permissive answer.
 */
export function updateCheckDisabled(opts: {
  env: NodeJS.ProcessEnv;
  stdoutIsTTY: boolean;
  configCheck: boolean | null;
}): string | null {
  if (envOn(opts.env['VIBE_NO_UPDATE_CHECK'])) return 'VIBE_NO_UPDATE_CHECK is set';
  if (envOn(opts.env['CI'])) return 'CI is set';
  if (!opts.stdoutIsTTY) return 'stdout is not a terminal';
  if (opts.configCheck === null) return 'the config could not be read';
  if (!opts.configCheck) return 'updates.check is false';
  return null;
}

// ---- The cache ------------------------------------------------------------------

/**
 * When the registry was last asked, and what it said - `latest: null` for a
 * request that failed, which is cached too, so a machine with no network pays
 * the timeout once a day rather than at the end of every command.
 */
export interface UpdateCache {
  checkedAt: number;
  latest: string | null;
}

/**
 * Next to the global config, in the directory `globalConfigPath` names, or null
 * when the global layer is switched off (`VIBE_GLOBAL_CONFIG` empty). Null means
 * no check at all: with nowhere to record one, "once a day" could not be kept.
 */
export function updateCachePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const config = globalConfigPath(env);
  return config === null ? null : path.join(path.dirname(config), 'update-check.json');
}

/**
 * The cache, or null for none. A file that is missing, is not JSON, has the
 * wrong shape, or is dated in the future (a clock that moved back) all count as
 * no cache: the worst that does is one extra request.
 */
export function readUpdateCache(file: string, now: number): UpdateCache | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const checkedAt = rec['checkedAt'];
  const latest = rec['latest'];
  if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt) || checkedAt > now) return null;
  if (latest !== null && typeof latest !== 'string') return null;
  return { checkedAt, latest };
}

function writeUpdateCache(file: string, cache: UpdateCache): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cache)}\n`);
    renameSync(tmp, file);
  } catch {
    // A cache that cannot be written costs one more request next time, never a failure.
  }
}

// ---- The request ----------------------------------------------------------------

export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

/**
 * The registry's `latest`, or null for any failure: a refused connection, a
 * non-2xx, a timeout, a body that is not JSON or carries no valid `version`.
 */
export async function fetchLatest(fetchFn: FetchLike, timeoutMs: number = TIMEOUT_MS): Promise<string | null> {
  try {
    // Nothing is sent but the URL and an Accept header: no credentials, no
    // cookies (Node's fetch keeps no cookie jar), no identifier of any kind.
    const res = await fetchFn(REGISTRY_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (typeof body !== 'object' || body === null) return null;
    const version = (body as Record<string, unknown>)['version'];
    return typeof version === 'string' && parseSemVer(version) !== null ? version : null;
  } catch {
    return null;
  }
}

/**
 * The newest version known, asking the registry only when the cache is older
 * than a day. Null when nothing is known.
 */
export async function latestVersion(deps: {
  cachePath: string;
  now: number;
  fetchFn: FetchLike;
  timeoutMs?: number;
}): Promise<string | null> {
  const cached = readUpdateCache(deps.cachePath, deps.now);
  if (cached !== null && deps.now - cached.checkedAt < CHECK_EVERY_MS) return cached.latest;
  const latest = await fetchLatest(deps.fetchFn, deps.timeoutMs);
  writeUpdateCache(deps.cachePath, { checkedAt: deps.now, latest });
  return latest;
}

/** This build's own version, from the `package.json` two levels above `dist/src`; null if unreadable. */
export function installedVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as unknown;
    if (typeof pkg !== 'object' || pkg === null) return null;
    const v = (pkg as Record<string, unknown>)['version'];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

// ---- The whole decision -----------------------------------------------------------

export interface NoticeDeps {
  env: NodeJS.ProcessEnv;
  stdoutIsTTY: boolean;
  cwd: string;
  now: () => number;
  fetchFn: FetchLike;
  current: () => string | null;
  /** `updates.check` for the command's directory; null when it cannot be read. */
  configCheck: (targetDir: string) => boolean | null;
  cachePath: string | null;
  timeoutMs?: number;
}

/** `updates.check` as the run would see it: defaults, the global file, the project's. */
export function configuredCheck(targetDir: string): boolean | null {
  try {
    return loadConfig(targetDir).updates.check;
  } catch {
    return null;
  }
}

export function defaultNoticeDeps(): NoticeDeps {
  return {
    env: process.env,
    stdoutIsTTY: process.stdout.isTTY === true,
    cwd: process.cwd(),
    now: () => Date.now(),
    fetchFn: (url, init) => fetch(url, init),
    current: installedVersion,
    configCheck: configuredCheck,
    cachePath: updateCachePath(),
  };
}

/**
 * The line to print after `argv` has run, or null. Never throws: every road
 * that is not "a newer version is known and every switch is on" is null.
 */
export async function noticeFor(argv: readonly string[], deps: NoticeDeps): Promise<string | null> {
  try {
    const cmd = argv[0];
    if (cmd === undefined || !NOTICE_COMMANDS.includes(cmd)) return null;
    // The command's own flags, read the way it read them, for `-C` and `--help`.
    // A bad argv throws here and is caught below: the command has already said so.
    const { flags } = parseArgs(argv.slice(1));
    if (flags.help === true) return null;
    const targetDir = path.resolve(deps.cwd, flags.cwd ?? '.');
    const off = updateCheckDisabled({
      env: deps.env,
      stdoutIsTTY: deps.stdoutIsTTY,
      configCheck: deps.configCheck(targetDir),
    });
    if (off !== null || deps.cachePath === null) return null;
    const current = deps.current();
    if (current === null) return null;
    const latest = await latestVersion({
      cachePath: deps.cachePath,
      now: deps.now(),
      fetchFn: deps.fetchFn,
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    });
    return latest !== null && isNewer(latest, current) ? updateNotice(latest, current) : null;
  } catch {
    return null;
  }
}

/**
 * Run the command, then - and only then - ask for the notice and print it.
 *
 * The exit code is `run`'s, whatever the notice does: it is handed to
 * `setExitCode` before the check starts, and a notice that throws or rejects is
 * swallowed. This is the shape `src/main.ts` calls, separated so a test can
 * prove the order without a terminal.
 */
export async function runWithNotice(
  run: () => Promise<number>,
  notice: () => Promise<string | null>,
  io: { setExitCode: (code: number) => void; write: (line: string) => void },
): Promise<void> {
  const code = await run();
  io.setExitCode(code);
  let line: string | null = null;
  try {
    line = await notice();
  } catch {
    line = null;
  }
  if (line !== null) {
    try {
      io.write(line);
    } catch {
      // A closed stdout is not a reason to fail a command that has finished.
    }
  }
}
