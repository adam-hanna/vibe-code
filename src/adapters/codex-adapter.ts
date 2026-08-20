import { detectPathStyle, toAgentPath } from '@src/pathstyle.js';
import type { ProbeString } from '@src/codex.js';
import type {
  AccessPolicy,
  AgentAdapter,
  AgentRuntime,
  AgentShell,
  Platform,
  PreparedEnvironment,
  ProbeContext,
  ToolchainContract,
} from '@src/runtime.js';
import { envFromRecord, parseKeyValueRecord, toolsFromRecord } from '@src/runtime.js';
import { hostExecutableFor } from '@src/hosttools.js';
import type { Sandbox } from '@src/types.js';

/**
 * Runs one throwaway `codex exec` turn and returns its stdout.
 *
 * Unlike Claude's, this executor's *return value* is the probe: Codex exposes
 * no hook system, so the only channel into its shell is a model turn.
 */
export type CodexProbeExecutor = (input: {
  prompt: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}) => Promise<string>;

/** Delimiters that let vibe find the record inside the model's prose. */
export const BEGIN = 'VIBE-PROBE-BEGIN';
export const END = 'VIBE-PROBE-END';

/** Attempts before giving up on the model emitting a parseable block. */
const PROBE_ATTEMPTS = 2;

/**
 * Codex adapter.
 *
 * Verified behaviour this encodes:
 * - Codex executes commands in **PowerShell** on Windows, not Bash, so its path
 *   style is `win32` while Claude's on the same host is `msys`.
 * - `shell_environment_policy.set.FOO` delivers arbitrary variables but, like
 *   Claude's `--settings` env, silently ignores `PATH`.
 * - Codex inherits the *parent process* environment, `PATH` included, which is
 *   the mechanism that does work. MSYS converts POSIX PATH entries to Windows
 *   form on exec, so vibe sets PATH host-natively and it arrives correct.
 * - The failure that looked like a PATH problem was a **sandbox** problem:
 *   `$env:PATH` contained the Node directory, `PATHEXT` was intact, and
 *   `Test-Path` on the binary returned `Access is denied`. Sandbox policy and
 *   spawn PATH are both required; neither alone is sufficient.
 * - Failures are silent here too - exit code 0 with the error only inside the
 *   transcript text.
 */
export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex' as const;
  /** No hooks. The model is transport only: fixed script in, verbatim out. */
  readonly probeChannel = 'model-turn' as const;

  constructor(
    private readonly execute: CodexProbeExecutor,
    private readonly sandbox: Sandbox,
  ) {}

  /**
   * Probe, with a bounded retry.
   *
   * The retry is not defensive padding: this channel is a language model, and
   * the same probe against the same host has both produced a well-formed block
   * and omitted it entirely. Claude's hook probe needs no such allowance, which
   * is the practical argument for preferring a deterministic channel wherever
   * a provider offers one.
   */
  async probeRuntime(ctx: ProbeContext): Promise<AgentRuntime> {
    let lastOutput = '';
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
      lastOutput = await this.execute({
        prompt: renderProbePrompt(ctx.contract, attempt > 1),
        args: ['-s', this.sandbox, '--skip-git-repo-check'],
        cwd: ctx.cwd,
        timeoutMs: ctx.timeoutMs,
      });

      const record = extractRecord(lastOutput);
      if (record !== null) return parseProbeRecord(record, ctx.cwd, this.sandbox);
    }

    throw new Error(
      `The Codex probe returned no ${BEGIN} block in ${PROBE_ATTEMPTS} attempts. ` +
        'Codex reports environment failures with exit code 0, so the block is the ' +
        `only reliable signal. Last output:\n${lastOutput.slice(-600)}`,
    );
  }

  async prepareEnvironment(
    runtime: AgentRuntime,
    contract: ToolchainContract,
  ): Promise<PreparedEnvironment> {
    await Promise.resolve();

    // A tool vibe can find on disk but the agent cannot run, under anything
    // short of full access, is a sandbox problem regardless of how the shell
    // phrased it. PowerShell reports a sandbox-blocked binary as "not
    // recognized" rather than "access denied" - only `Test-Path` surfaced the
    // real `UnauthorizedAccessException` - so matching on denial text alone
    // misses the case that actually occurs and proposes a PATH fix that
    // cannot work.
    const blocked = Object.keys(contract).filter((tool) => {
      const resolution = runtime.tools[tool];
      if (resolution === undefined || resolution.available) return false;
      if (isDenial(resolution.failure)) return true;
      return this.sandbox !== 'danger-full-access' && hostExecutableFor(tool) !== null;
    });
    const unreachable = blocked.length > 0;

    const inherited = process.env['PATH'] ?? '';

    return {
      // PATH rides in on process inheritance because the documented env policy
      // drops it. Set host-natively: MSYS rewrites it on exec.
      spawnEnv: { PATH: inherited },
      extraArgs: ['-s', this.sandbox],
      artifacts: [],
      promptHint: unreachable
        ? `These tools exist on this machine but the ${this.sandbox} sandbox blocks ` +
          `them: ${blocked.join(', ')}. Do not attempt to work around this; report it instead.`
        : null,
      // Both rungs, in order. A denial needs the sandbox widened; PATH alone
      // was verified insufficient.
      mechanisms: unreachable ? ['sandbox-policy', 'spawn-env'] : ['spawn-env'],
    };
  }

  /** Extra `-c` overrides for variables the policy *will* carry. */
  static envPolicyArgs(vars: Readonly<Record<string, string>>): string[] {
    return Object.entries(vars).flatMap(([key, value]) => [
      '-c',
      `shell_environment_policy.set.${key}=${value}`,
    ]);
  }
}

/**
 * The probe prompt.
 *
 * Constrained deliberately: the model runs fixed commands and echoes raw output
 * between sentinels. It is not asked to interpret anything, because an
 * interpreting probe is a probe that can be wrong.
 */
export function renderProbePrompt(contract: ToolchainContract, insist = false): string {
  const checks = Object.entries(contract)
    .map(([tool, requirement]) => `${tool}\t${requirement.probe}`)
    .join('\n');

  return [
    'Environment diagnostic. Do not modify any files.',
    '',
    'Run each command below in your shell and report the results verbatim.',
    `Print one line per field between ${BEGIN} and ${END}, in key=value form,`,
    'with no commentary, no code fences and no interpretation:',
    '',
    '  shell=<the shell you execute commands in>',
    '  uname=<uname -s, or "Windows">',
    '  path=<the full PATH>',
    '  pathext=<PATHEXT if set, else empty>',
    '  cwd=<current directory>',
    '',
    'Then for each tool below, run its command and report three lines:',
    '  tool.<name>.exit=<exit code>',
    '  tool.<name>.out=<first line of output, verbatim, including any error>',
    '  tool.<name>.which=<resolved path, or empty>',
    '',
    checks,
    ...(insist
      ? [
          '',
          `IMPORTANT: the previous attempt omitted the ${BEGIN} block. The block is`,
          'the entire point of this task. Emit it even if every command failed -',
          'a failure recorded in the block is useful, a missing block is not.',
        ]
      : []),
  ].join('\n');
}

/**
 * The LAST whole sentinel pair in `text`, sentinels included, or null.
 *
 * Last rather than first, everywhere: the instructions that ask for the block
 * name both sentinels, and a truncated or superseded attempt precedes the one
 * that worked - so in any text holding more than one pair, the earlier pair is
 * the one that is not the answer. Scanning back over `BEGIN`s that never got an
 * `END` also means a reply that trails off after the record cannot hide it.
 */
function lastBlock(text: string): string | null {
  let start = text.lastIndexOf(BEGIN);
  while (start >= 0) {
    const end = text.indexOf(END, start + BEGIN.length);
    if (end > start) return text.slice(start, end + END.length);
    if (start === 0) return null;
    start = text.lastIndexOf(BEGIN, start - 1);
  }
  return null;
}

/**
 * The block spanning the shortest contiguous run of `fragments` that holds one.
 *
 * Contiguous, and only the run: joining every fragment would sweep the
 * assistant's own prose and any reasoning text in between into the record, and
 * `parseKeyValueRecord` is last-write-wins, so a stray `key=value` line from
 * outside the block would overwrite a probed one. The search starts from the
 * last fragment that opens a block, for the same reason the scan above ends at
 * the last pair.
 */
function contiguousBlock(fragments: readonly string[], joiner: string): string | null {
  for (let start = fragments.length - 1; start >= 0; start -= 1) {
    if (!(fragments[start] ?? '').includes(BEGIN)) continue;
    for (let end = start; end < fragments.length; end += 1) {
      const block = lastBlock(fragments.slice(start, end + 1).join(joiner));
      if (block !== null) return block;
    }
  }
  return null;
}

/** How many `key=value` lines a reassembly's block yields - how whole it is. */
function recordLines(text: string): number {
  const block = extractRecord(text) ?? '';
  return block.split(/\r?\n/).filter((line) => line.includes('=')).length;
}

/** The last whole block among `strings`, taken from the last string holding one. */
function lastWithBlock(strings: readonly ProbeString[]): string | null {
  for (let i = strings.length - 1; i >= 0; i -= 1) {
    const block = lastBlock(strings[i]?.value ?? '');
    if (block !== null) return block;
  }
  return null;
}

/**
 * The string the probe record should be read out of, from a `--json` stream.
 *
 * Not a concatenation of everything, and never a whole candidate: what comes
 * back is the block itself, cut to its last sentinel pair. `renderProbePrompt`
 * names both sentinels in its own instructions, so an echoed prompt, a
 * `command` string mentioning them, or a truncated earlier attempt would
 * otherwise be parsed as the runtime record - and returning a whole candidate
 * only moved that hazard inside the string, where the first-pair scan would
 * find the wrong one just the same.
 */
export function selectProbeTranscript(
  strings: readonly ProbeString[],
  plain: string,
  promptEcho: string,
): string {
  // What vibe sent, removed outright wherever it is echoed back: an echo is
  // never the answer, and it is the one candidate guaranteed to carry a whole
  // sentinel pair.
  const echo = promptEcho.trim();
  const candidates =
    echo === '' ? strings : strings.filter((probe) => !probe.value.includes(echo));
  const settled = candidates.filter((probe) => !probe.partial && !probe.meta);

  const answer = lastWithBlock(settled);
  if (answer !== null) return answer;

  // A whole block anywhere else: a schema that marks the final message as an
  // update, or output arriving under an input-looking key.
  const anywhere = lastWithBlock(candidates);
  if (anywhere !== null) return anywhere;

  // No single string holds one, so the stream split the answer across fragments.
  // Reassembled rather than dropped - a stream that sends its reply in deltas
  // answered the probe, it did not fail it.
  //
  // Two ways to put the pieces back, because two kinds of fragment occur: a
  // delta is a slice of one text and carries its own newlines, while a
  // line-wise event has had them stripped. Joining the wrong way still yields
  // both sentinels, so "has a block" cannot choose between them - the record
  // with more `key=value` lines in it is the one that came back whole.
  const fragments = candidates.filter((probe) => !probe.meta).map((probe) => probe.value);
  let best: { text: string; lines: number } | null = null;
  for (const joiner of ['', '\n']) {
    const run = contiguousBlock(fragments, joiner);
    if (run === null) continue;
    const lines = recordLines(run);
    if (best === null || lines > best.lines) best = { text: run, lines };
  }
  if (best !== null) return best.text;

  // Nothing usable. Hand back what there is: `probeRuntime` retries and then
  // reports a probe error, exactly as it does today for an unusable turn.
  const rest = settled.map((probe) => probe.value).join('\n');
  return rest === '' ? plain : rest;
}

/**
 * Pull the sentinel-delimited block out of the transcript.
 *
 * The LAST whole pair, not the first. The prompt names both sentinels, and a
 * model that quotes its instructions, retries after a truncated attempt, or
 * prints the record twice puts more than one pair in front of this - and in
 * every one of those cases the earlier pair is the one that is not the answer.
 * Taking the first parsed an echoed template as a probed runtime.
 */
export function extractRecord(stdout: string): string | null {
  const block = lastBlock(stdout);
  return block === null ? null : block.slice(BEGIN.length, block.length - END.length).trim();
}

export function parseProbeRecord(raw: string, hostCwd: string, sandbox: Sandbox): AgentRuntime {
  const record = parseKeyValueRecord(raw);
  const shellRaw = record.get('shell') ?? '';
  const lower = shellRaw.toLowerCase();
  const shell: AgentShell = lower.includes('powershell') || lower.includes('pwsh')
    ? 'powershell'
    : lower.includes('cmd')
      ? 'cmd'
      : lower.includes('bash')
        ? 'bash'
        : lower.includes('zsh')
          ? 'zsh'
          : 'unknown';

  const uname = record.get('uname') ?? '';
  const platform: Platform =
    shell === 'powershell' || shell === 'cmd' || /windows|mingw|msys/i.test(uname)
      ? 'windows'
      : uname === 'Darwin'
        ? 'darwin'
        : 'linux';

  return {
    provider: 'codex',
    platform,
    shell,
    pathStyle: detectPathStyle({ platform, shell: shellRaw, pathSample: record.get('path') }),
    cwd: hostCwd,
    access: accessFor(sandbox, hostCwd),
    tools: toolsFromRecord(record),
    env: envFromRecord(record),
    probedAt: new Date().toISOString(),
    sessionId: null,
  };
}

/**
 * Sandbox mode translated into the access dimension.
 *
 * `read-only` is the mode that produced `UnauthorizedAccessException` on a
 * binary that was present and on PATH, so its read scope is workspace, not full.
 */
function accessFor(sandbox: Sandbox, cwd: string): AccessPolicy {
  switch (sandbox) {
    case 'danger-full-access':
      return { read: 'full', write: 'full', execRoots: ['/'], networkAllowed: true };
    case 'workspace-write':
      return {
        read: 'workspace',
        write: 'workspace',
        execRoots: [toAgentPath(cwd, 'win32')],
        networkAllowed: false,
      };
    case 'read-only':
      return { read: 'workspace', write: 'none', execRoots: [], networkAllowed: false };
  }
}

function isDenial(failure: string | null): boolean {
  return /access is denied|unauthorized|permission denied|eacces|eperm/i.test(failure ?? '');
}
