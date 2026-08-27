import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeTurn } from '@src/claude.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import { codexTurn, parseOptionTokens, resetCodexForkProbe } from '@src/codex.js';
import type { CodexTurnOptions } from '@src/codex.js';
import type { ActivityObservation, ProgressOptions, RepeatingTimer, TimerApi } from '@src/progress.js';
import type { RunFn, RunResult } from '@src/proc.js';

/**
 * The adapter/heartbeat boundary, driven through the real adapters.
 *
 * Nothing is spawned: `exec` is injected, and the bin overrides only exist so
 * `resolveBin` succeeds on a machine where neither CLI is installed. Spawning
 * `claude` or `codex` needs a logged-in account and costs money per case.
 */
process.env['VIBE_CLAUDE_BIN'] = process.execPath;
process.env['VIBE_CODEX_BIN'] = process.execPath;

/** A timer that never fires: these cases are about the boundary, not cadence. */
const idleTimers: TimerApi = {
  repeat: (): RepeatingTimer => ({ unref: () => {}, cancel: () => {} }),
};

function progressRecorder(): { options: ProgressOptions; sources: string[] } {
  const sources: string[] = [];
  return {
    sources,
    options: {
      label: 'fixture',
      intervalMs: 30_000,
      onActivity: (observation: ActivityObservation) => sources.push(observation.source),
      timers: idleTimers,
    },
  };
}

/**
 * A child that emitted `lines`, optionally did something on the way out, and
 * exited with `code`.
 *
 * The line hook is driven here because `run` is its only production caller.
 * Without it there would be no line for `flush` to persist, and every assertion
 * about flushing would pass vacuously.
 */
function fakeExec(code: number | null, lines: readonly string[], after?: () => void): RunFn {
  return (_bin, _args, options): Promise<RunResult> => {
    for (const line of lines) options?.onLine?.(line);
    after?.();
    return Promise.resolve({ code, stdout: lines.map((line) => `${line}\n`).join(''), stderr: '' });
  };
}

const ASSISTANT = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] },
});
const SUCCESS = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  session_id: 'fixture-session',
  total_cost_usd: 0.02,
  num_turns: 1,
});

function claudeOptions(progress: ProgressOptions): ClaudeTurnOptions {
  return {
    prompt: 'hello',
    sessionId: 'fixture-session',
    resume: false,
    permissionMode: 'plan',
    model: 'fixture-model',
    effort: 'low',
    cwd: process.cwd(),
    timeoutMs: 1_000,
    progress,
  };
}

test('claude: output that fails validation is not flushed as a completed turn', async () => {
  const { options, sources } = progressRecorder();

  await assert.rejects(
    () => claudeTurn(claudeOptions(options), fakeExec(0, [ASSISTANT])),
    /no result event/,
  );

  assert.ok(sources.includes('start'));
  assert.ok(sources.includes('stdout'));
  assert.ok(!sources.includes('final'), 'a rejected turn must not record completion');
});

test('claude: an accepted turn flushes', async () => {
  const { options, sources } = progressRecorder();

  const result = await claudeTurn(claudeOptions(options), fakeExec(0, [ASSISTANT, SUCCESS]));

  assert.equal(result.text, 'done');
  assert.ok(sources.includes('final'));
});

test('claude: a non-zero exit with a complete successful result is accepted', async () => {
  // The payload is the verdict: the result envelope carries the cost and usage
  // the run depends on, so a bad exit after it is teardown, not a failed turn.
  const { options, sources } = progressRecorder();

  const result = await claudeTurn(claudeOptions(options), fakeExec(1, [ASSISTANT, SUCCESS]));

  assert.equal(result.text, 'done');
  assert.ok(sources.includes('final'));
});

test('claude: a non-zero exit with unusable output still fails and does not flush', async () => {
  const { options, sources } = progressRecorder();

  await assert.rejects(
    () => claudeTurn(claudeOptions(options), fakeExec(1, [ASSISTANT])),
    /no result event/,
  );

  assert.ok(!sources.includes('final'));
});

const CODEX_ITEM = JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } });
const TURN_FAILED = JSON.stringify({
  type: 'turn.failed',
  error: { message: 'the model refused the request' },
});

function codexDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-codex-boundary-'));
}

function codexOptions(dir: string, progress: ProgressOptions): CodexTurnOptions {
  return {
    prompt: 'review this',
    schema: { type: 'object' },
    schemaName: 'review-0',
    artifactDir: dir,
    model: 'fixture-model',
    effort: 'low',
    sandbox: 'read-only',
    cwd: process.cwd(),
    timeoutMs: 1_000,
    progress,
  };
}

const outPath = (dir: string): string => path.join(dir, 'review-0.out.json');

test('codex: a turn that wrote no structured output is not flushed', async () => {
  const dir = codexDir();
  const { options, sources } = progressRecorder();

  await assert.rejects(
    () => codexTurn(codexOptions(dir, options), fakeExec(0, [CODEX_ITEM])),
    /wrote no structured output/,
  );

  assert.ok(sources.includes('start'));
  assert.ok(!sources.includes('final'));
});

test('codex: a turn whose output file parses flushes', async () => {
  const dir = codexDir();
  const { options, sources } = progressRecorder();

  const result = await codexTurn(
    codexOptions(dir, options),
    fakeExec(0, [CODEX_ITEM], () => {
      writeFileSync(outPath(dir), '{"findings":[]}', 'utf8');
    }),
  );

  assert.deepEqual(result.structured, { findings: [] });
  assert.ok(sources.includes('final'));
});

test('codex: a non-zero exit whose output file parses is accepted', async () => {
  const dir = codexDir();
  const { options, sources } = progressRecorder();

  const result = await codexTurn(
    codexOptions(dir, options),
    fakeExec(1, [CODEX_ITEM], () => {
      writeFileSync(outPath(dir), '{"findings":[]}', 'utf8');
    }),
  );

  assert.deepEqual(result.structured, { findings: [] });
  assert.ok(sources.includes('final'));
});

test('codex: a non-zero exit with no output file fails and does not flush', async () => {
  const dir = codexDir();
  const { options, sources } = progressRecorder();

  await assert.rejects(
    () => codexTurn(codexOptions(dir, options), fakeExec(1, [CODEX_ITEM])),
    /wrote no structured output/,
  );

  assert.ok(!sources.includes('final'));
});

test('codex: a previous attempt output file is not accepted as this turn result', async () => {
  // Schema names are per-round and withRateLimitRetry reuses them, so an
  // abandoned attempt's file sat exactly where this turn's would be.
  const dir = codexDir();
  writeFileSync(outPath(dir), '{"findings":["from the previous attempt"]}', 'utf8');
  const { options, sources } = progressRecorder();

  await assert.rejects(
    () => codexTurn(codexOptions(dir, options), fakeExec(0, [CODEX_ITEM])),
    /wrote no structured output/,
  );

  assert.equal(existsSync(outPath(dir)), false, 'the stale file is moved before the child runs');
  // Kept, because nothing else persists a rejected turn's raw output: the
  // attempt that went wrong would otherwise be the one with no evidence left.
  assert.equal(
    readFileSync(path.join(dir, 'review-0.superseded.json'), 'utf8'),
    '{"findings":["from the previous attempt"]}',
  );
  assert.ok(!sources.includes('final'));
});

test('codex: an explicit turn.failed is not accepted even with an output file', async () => {
  // Codex's own verdict on the turn. A file beside it is a partial write or an
  // earlier phase of the same turn, and handing it to the loop would present a
  // result the agent said was not one. Exit status cannot catch this: a failed
  // turn can still exit 0.
  const dir = codexDir();
  const { options, sources } = progressRecorder();

  await assert.rejects(
    () =>
      codexTurn(
        codexOptions(dir, options),
        fakeExec(0, [CODEX_ITEM, TURN_FAILED], () => {
          writeFileSync(outPath(dir), '{"findings":[]}', 'utf8');
        }),
      ),
    /reported the turn failed/,
  );

  assert.ok(!sources.includes('final'));
});

test('codex: the schema file is still written for the child to read', async () => {
  const dir = codexDir();
  const { options } = progressRecorder();

  await assert.rejects(() => codexTurn(codexOptions(dir, options), fakeExec(0, [])));

  const schema = JSON.parse(readFileSync(path.join(dir, 'review-0.schema.json'), 'utf8')) as unknown;
  assert.deepEqual(schema, { type: 'object' });
});

// ---- forking a conversation (#78) -------------------------------------------

/** The argv a turn would have spawned, captured rather than run. */
function capture(): { args: string[][]; exec: RunFn } {
  const args: string[][] = [];
  return {
    args,
    exec: (_bin, argv, options): Promise<RunResult> => {
      args.push([...argv]);
      for (const line of [ASSISTANT, SUCCESS]) options?.onLine?.(line);
      return Promise.resolve({
        code: 0,
        stdout: `${ASSISTANT}\n${SUCCESS}\n`,
        stderr: '',
      });
    },
  };
}

test('claude: a fork names the parent to --resume and the child to --session-id', async () => {
  const { options } = progressRecorder();
  const { args, exec } = capture();

  await claudeTurn({ ...claudeOptions(options), forkFrom: 'parent-session' }, exec);

  const argv = args[0] ?? [];
  const at = argv.indexOf('--resume');
  assert.ok(at >= 0, `--resume is sent: ${argv.join(' ')}`);
  assert.equal(argv[at + 1], 'parent-session', 'the parent is what is resumed');
  assert.ok(argv.includes('--fork-session'), 'and forked rather than continued');
  assert.equal(argv[argv.indexOf('--session-id') + 1], 'fixture-session', 'into vibe own id');
});

test('claude: a resume continues one session and mints nothing', async () => {
  const { options } = progressRecorder();
  const { args, exec } = capture();

  await claudeTurn({ ...claudeOptions(options), resume: true }, exec);

  const argv = args[0] ?? [];
  assert.equal(argv[argv.indexOf('--resume') + 1], 'fixture-session');
  // Not `--session-id`, and this is the argv half of #74: that flag CREATES a
  // session and spends the id on attempt, so sending it for a conversation that
  // already exists is what the CLI refuses with "already in use".
  assert.equal(argv.includes('--session-id'), false, `no id is minted: ${argv.join(' ')}`);
  assert.equal(argv.includes('--fork-session'), false, 'and nothing is copied');
});

test('claude: an ordinary turn sends no fork flag at all', async () => {
  const { options } = progressRecorder();
  const { args, exec } = capture();

  await claudeTurn(claudeOptions(options), exec);
  assert.equal((args[0] ?? []).includes('--fork-session'), false);
});

test('claude: forking a conversation it is also resuming is a programming error', async () => {
  const { options } = progressRecorder();
  const { exec } = capture();

  await assert.rejects(
    () => claudeTurn({ ...claudeOptions(options), resume: true, forkFrom: 'parent' }, exec),
    /mutually exclusive/,
  );
});

/**
 * A codex whose `exec fork --help` names `flags`, recording every invocation.
 *
 * The probe is a real child, so a case that does not model it is a case testing
 * the wrong argv. `null` flags means the help could not be read at all - which
 * is not evidence that anything is missing, and must leave the direct vector
 * alone.
 */
function codexWithFork(
  dir: string,
  flags: readonly string[] | null,
  extra: (argv: readonly string[]) => Partial<RunResult> = () => ({}),
): { args: string[][]; exec: RunFn } {
  const args: string[][] = [];
  const exec: RunFn = (_bin, argv): Promise<RunResult> => {
    args.push([...argv]);
    if (argv[2] === '--help') {
      return Promise.resolve(
        flags === null
          ? { code: 1, stdout: '', stderr: '' }
          : { code: 0, stdout: `Usage: codex exec fork\n\n${flags.join('\n')}\n`, stderr: '' },
      );
    }
    writeFileSync(outPath(dir), JSON.stringify({ verdict: 'APPROVE' }), 'utf8');
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...extra(argv) });
  };
  return { args, exec };
}

const ALL_FORK_FLAGS = ['--json', '-m', '-c', '--skip-git-repo-check', '-o', '--output-schema'];

test('codex: a fork is `exec fork <parent> ... -`, with no -s and no -C', async () => {
  resetCodexForkProbe();
  const dir = codexDir();
  const { options } = progressRecorder();
  const { args, exec } = codexWithFork(dir, ALL_FORK_FLAGS);

  await codexTurn({ ...codexOptions(dir, options), forkFrom: 'parent-thread' }, exec);

  assert.deepEqual(args[0]?.slice(0, 3), ['exec', 'fork', '--help'], 'the flags are probed first');
  const argv = args[1] ?? [];
  assert.deepEqual(argv.slice(0, 3), ['exec', 'fork', 'parent-thread']);
  assert.equal(argv.at(-1), '-', 'the prompt still arrives on stdin');
  assert.ok(argv.includes('--json') && argv.includes('--skip-git-repo-check'));
  // `fork` inherits neither, exactly as `resume` does not.
  assert.equal(argv[argv.indexOf('-m') + 1], 'fixture-model');
  assert.ok(argv.some((a) => a.startsWith('model_reasoning_effort=')));
  // Neither flag is accepted by `fork`; the cwd and the sandbox come from the
  // spawned process, as they do for a resumed thread.
  assert.equal(argv.includes('-s'), false);
  assert.equal(argv.includes('-C'), false);
});

test('codex: an ordinary one-shot turn is still `exec`, and a resume still `exec resume`', async () => {
  const dir = codexDir();
  const { options } = progressRecorder();
  const args: string[][] = [];
  const exec: RunFn = (_bin, argv): Promise<RunResult> => {
    args.push([...argv]);
    writeFileSync(outPath(dir), JSON.stringify({ verdict: 'APPROVE' }), 'utf8');
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };

  await codexTurn(codexOptions(dir, options), exec);
  await codexTurn({ ...codexOptions(dir, options), sessionId: 'thread-9' }, exec);

  assert.deepEqual((args[0] ?? []).slice(0, 1), ['exec']);
  assert.deepEqual((args[1] ?? []).slice(0, 3), ['exec', 'resume', 'thread-9']);
});

test('codex: a fork missing a flag falls back to fork-then-resume, in one turn', async () => {
  resetCodexForkProbe();
  const dir = codexDir();
  const { options } = progressRecorder();
  // A codex whose `exec fork` takes no `--output-schema`: the direct vector
  // would be rejected before any model work, so the turn is taken another way.
  const { args, exec } = codexWithFork(dir, ['--json', '-m', '-c', '--skip-git-repo-check', '-o'], (argv) =>
    argv[1] === 'fork'
      ? { stdout: JSON.stringify({ type: 'thread.started', thread_id: 'forked-thread' }) }
      : {},
  );

  const result = await codexTurn({ ...codexOptions(dir, options), forkFrom: 'parent-thread' }, exec);

  assert.deepEqual(args[0]?.slice(0, 3), ['exec', 'fork', '--help']);
  // One: mint the copy, with no prompt and nothing to charge.
  assert.deepEqual(args[1], ['exec', 'fork', 'parent-thread', '--json']);
  // Two: the turn itself, on the thread that copy created.
  assert.deepEqual(args[2]?.slice(0, 3), ['exec', 'resume', 'forked-thread']);
  assert.equal(args[2]?.at(-1), '-');
  assert.ok(args[2]?.includes('--output-schema'), 'the schema is enforced on the turn that answers');
  // The slot must learn which thread it is on, or the next pass re-forks one
  // that already exists.
  assert.equal(result.sessionId, 'forked-thread');
});

test('codex: a fork whose mint names no thread fails rather than running the turn somewhere', async () => {
  resetCodexForkProbe();
  const dir = codexDir();
  const { options } = progressRecorder();
  const { args, exec } = codexWithFork(dir, ['--json', '-m']);

  await assert.rejects(
    () => codexTurn({ ...codexOptions(dir, options), forkFrom: 'parent-thread' }, exec),
    /named no thread/,
  );
  assert.equal(args.length, 2, 'the probe and the mint - and no turn after them');
});

test('codex: help that cannot be read is not evidence a flag is missing', async () => {
  resetCodexForkProbe();
  const dir = codexDir();
  const { options } = progressRecorder();
  const { args, exec } = codexWithFork(dir, null);

  await codexTurn({ ...codexOptions(dir, options), forkFrom: 'parent-thread' }, exec);

  // The direct vector, unchanged: an unreadable help text says nothing about
  // what the binary accepts, and switching paths on no evidence would be the
  // same fabrication this codebase refuses about numbers.
  assert.deepEqual(args[1]?.slice(0, 3), ['exec', 'fork', 'parent-thread']);
});

test('codex: the probe is read once per process, not once per turn', async () => {
  resetCodexForkProbe();
  const dir = codexDir();
  const { options } = progressRecorder();
  const { args, exec } = codexWithFork(dir, ALL_FORK_FLAGS);

  await codexTurn({ ...codexOptions(dir, options), forkFrom: 'a' }, exec);
  await codexTurn({ ...codexOptions(dir, options), forkFrom: 'b' }, exec);

  assert.equal(args.filter((a) => a[2] === '--help').length, 1);
});


test('codex: option tokens are read with boundaries, and short is not long', () => {
  // The defect this replaces: `help.includes('-m')` is satisfied by `--model`,
  // by `--skip-git-repo-check`, and by the word "command" in a sentence.
  const long = parseOptionTokens('  --model <m>   the model\n  --config <k=v>\n  --output <f>\n');
  assert.ok(long.has('--model') && long.has('--config') && long.has('--output'));
  for (const short of ['-m', '-c', '-o']) {
    assert.equal(long.has(short), false, `${short} is not declared by a long-only help`);
  }
  const both = parseOptionTokens('  -m, --model <m>\n  -o <file>\n  --output-schema <f>\n');
  assert.ok(both.has('-m') && both.has('--model') && both.has('-o') && both.has('--output-schema'));
  assert.equal(both.has('--out'), false, 'a prefix of a declared option is not a declared option');
  assert.equal(parseOptionTokens('runs the command in a sandbox').size, 0);
});

test('codex: a long-only help takes the fallback rather than sending short flags', async () => {
  resetCodexForkProbe();
  const dir = codexDir();
  const { options } = progressRecorder();
  // Everything the direct vector needs, but declared only in long form. The
  // substring probe read this as compatible and sent `-m -c -o` to a binary
  // that does not take them.
  const { args, exec } = codexWithFork(
    dir,
    ['--json', '--model', '--config', '--skip-git-repo-check', '--output', '--output-schema'],
    (argv) =>
      argv[1] === 'fork'
        ? { stdout: JSON.stringify({ type: 'thread.started', thread_id: 'long-only-thread' }) }
        : {},
  );

  const result = await codexTurn({ ...codexOptions(dir, options), forkFrom: 'parent-thread' }, exec);

  assert.deepEqual(args[1], ['exec', 'fork', 'parent-thread', '--json']);
  assert.deepEqual(args[2]?.slice(0, 3), ['exec', 'resume', 'long-only-thread']);
  assert.equal(result.sessionId, 'long-only-thread');
});

test('codex: a fallback on a codex with no --json does not send --json', async () => {
  resetCodexForkProbe();
  const dir = codexDir();
  const { options } = progressRecorder();
  // The flag the probe found missing must not be the flag the fallback sends -
  // that would break the fallback on exactly the binaries it exists for. With no
  // `--json` there is no event stream, so the id comes from the banner.
  const { args, exec } = codexWithFork(dir, ['-m', '-c', '--skip-git-repo-check', '-o'], (argv) =>
    argv[1] === 'fork'
      ? { stderr: 'session id: 123e4567-e89b-12d3-a456-426614174000\n' }
      : {},
  );

  const result = await codexTurn({ ...codexOptions(dir, options), forkFrom: 'parent-thread' }, exec);

  assert.deepEqual(args[1], ['exec', 'fork', 'parent-thread'], 'no --json on the mint call');
  assert.deepEqual(args[2]?.slice(0, 3), [
    'exec',
    'resume',
    '123e4567-e89b-12d3-a456-426614174000',
  ]);
  assert.equal(result.sessionId, '123e4567-e89b-12d3-a456-426614174000');
});

test('codex: a banner on stdout is read too', async () => {
  resetCodexForkProbe();
  const dir = codexDir();
  const { options } = progressRecorder();
  const { args, exec } = codexWithFork(dir, ['-m'], (argv) =>
    argv[1] === 'fork'
      ? { stdout: 'session id: 123e4567-e89b-12d3-a456-426614174000\n' }
      : {},
  );

  await codexTurn({ ...codexOptions(dir, options), forkFrom: 'parent-thread' }, exec);
  assert.deepEqual(args[2]?.slice(0, 3), [
    'exec',
    'resume',
    '123e4567-e89b-12d3-a456-426614174000',
  ]);
});

