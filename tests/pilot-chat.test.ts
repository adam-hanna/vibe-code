import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pilotChat, pilotChatArgs, readDelta } from '@src/pilotchat.js';
import { RateLimitError } from '@src/claude.js';
import { endingOf } from '@src/proc.js';
import type { PilotChatOptions } from '@src/pilotchat.js';
import type { RunFn, RunResult } from '@src/proc.js';

/**
 * The pilot's CLI-backed turn (#193).
 *
 * Nothing is spawned. The bin override exists only so `resolveBin` succeeds on a
 * machine with no `claude` installed; spawning the real one needs a logged-in
 * account and costs a turn's quota per case.
 *
 * The cases worth having here are the ones about the *boundary*: what goes out in
 * the argv, what a reply looks like as it arrives, and the two things that must
 * never happen - a pilot turn narrating into a run, and a dollar figure being
 * invented for a subscription.
 */
process.env['VIBE_CLAUDE_BIN'] = process.execPath;

const options = (over: Partial<PilotChatOptions> = {}): PilotChatOptions => ({
  prompt: 'what am I running?',
  system: 'You are the pilot.',
  sessionId: '11111111-2222-3333-4444-555555555555',
  resume: false,
  model: 'claude-opus-5',
  cwd: process.cwd(),
  timeoutMs: 60_000,
  ...over,
});

/** A child that emitted `lines` and exited with `code`. */
function fakeExec(code: number | null, lines: readonly string[]): RunFn {
  return async (_bin, _args, opts): Promise<RunResult> => {
    for (const line of lines) opts?.onLine?.(line);
    return { code, signal: null, stdout: lines.join('\n'), stderr: '' };
  };
}

const delta = (text: string): string =>
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  });

const done = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'the whole reply',
    session_id: 'from-the-cli',
    total_cost_usd: 0.42,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 1,
    },
    ...over,
  });

// ---- what goes out ---------------------------------------------------------

test('a chat turn is denied the tools that act, at the permission layer and by name', () => {
  const args = pilotChatArgs(options());
  // Plan mode is the guarantee: it is the CLI's own enforcement and it is not a
  // list this repo has to keep current.
  assert.ok(args.includes('--permission-mode'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  // The deny-list is the second layer, and it has to be last because it is
  // variadic - a flag after it would be swallowed as a tool name.
  const denied = args.indexOf('--disallowed-tools');
  assert.ok(denied !== -1);
  for (const tool of ['Bash', 'Edit', 'Write']) assert.ok(args.slice(denied).includes(tool));
  assert.ok(!args.slice(denied + 1).some((a) => a.startsWith('--')), 'a flag after a variadic one');
});

test('the system prompt replaces Claude Code’s rather than appending to it', () => {
  // A pilot is not a coding agent with a repository and a task. Appending would
  // leave the model reconciling two jobs, and the one it would pick is the one
  // whose tools it has been denied.
  const args = pilotChatArgs(options({ system: 'be a pilot' }));
  assert.ok(args.includes('--system-prompt'));
  assert.ok(!args.includes('--append-system-prompt'));
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'be a pilot');
});

test('the first turn names the session and every turn after it resumes one', () => {
  const first = pilotChatArgs(options());
  assert.ok(first.includes('--session-id'));
  assert.ok(!first.includes('--resume'));

  const next = pilotChatArgs(options({ resume: true }));
  assert.ok(next.includes('--resume'));
  assert.ok(!next.includes('--session-id'));
  // Continuity is the whole reason a chat can be a chat: neither vendor's API
  // remembers a previous request and this CLI does.
  assert.equal(next[next.indexOf('--resume') + 1], options().sessionId);
});

test('the prompt goes over stdin and never into the argv', async () => {
  // A settled decision in this repo, and the reason is right here: `--tools` and
  // `--disallowed-tools` are variadic and would swallow a positional.
  let sawInput: string | undefined;
  let sawArgs: readonly string[] = [];
  const exec: RunFn = async (_bin, args, opts) => {
    sawInput = opts?.input;
    sawArgs = args;
    return { code: 0, signal: null, stdout: done(), stderr: '' };
  };
  await pilotChat(options({ prompt: 'a question with --disallowed-tools in it' }), exec);
  assert.equal(sawInput, 'a question with --disallowed-tools in it');
  assert.ok(!sawArgs.includes('a question with --disallowed-tools in it'));
});

// ---- what comes back -------------------------------------------------------

test('a reply arrives in fragments, in order, and is not delivered twice', async () => {
  // `--include-partial-messages` is what makes the pane feel like a chat rather
  // than a wait. The `assistant` event carries the same text again, whole, and
  // emitting both would double every reply.
  const seen: string[] = [];
  const stream = [
    delta('the '),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'the run' }] } }),
    delta('run'),
    done(),
  ];
  const result = await pilotChat(
    options({ onDelta: (t) => seen.push(t) }),
    fakeExec(0, stream),
  );
  assert.deepEqual(seen, ['the ', 'run']);
  // And the whole text still comes from the envelope, not from the fragments
  // stitched back together - one of the two has to be authoritative.
  assert.equal(result.text, 'the whole reply');
});

test('a throwing delta hook does not cost the turn', async () => {
  // A progress signal, on the same terms `RunOptions.onLine` states: the turn has
  // already been paid for by the time a fragment arrives.
  const result = await pilotChat(
    options({
      onDelta: () => {
        throw new Error('the pane blew up');
      },
    }),
    fakeExec(0, [delta('x'), done()]),
  );
  assert.equal(result.text, 'the whole reply');
});

test('the CLI’s session id wins over the one we asked for', async () => {
  const result = await pilotChat(options(), fakeExec(0, [done()]));
  assert.equal(result.sessionId, 'from-the-cli');
});

test('what the turn moved is reported and what it cost is not', async () => {
  // The #145 line, on this side of it. A subscription turn bills nothing at all,
  // so a dollar figure has no quantity to be an estimate *of* - which is exactly
  // why Codex cost is not reported either. The envelope carries
  // `total_cost_usd: 0.42` and this deliberately does not read it.
  const result = await pilotChat(options(), fakeExec(0, [done()]));
  assert.deepEqual(result.tokens, {
    input: 10,
    output: 20,
    cacheRead: 5,
    cacheCreation: 1,
    total: 36,
  });
  assert.ok(!('costUsd' in result), 'a money field appeared on a subscription turn');
  assert.deepEqual(Object.keys(result).sort(), ['sessionId', 'text', 'tokens']);
});

// ---- how it fails ----------------------------------------------------------

test('a rate limit is surfaced as itself, because it is the contention case', async () => {
  // The serious cost of putting the pilot on the subscription: these tokens come
  // out of the same window the run draws on. A caller can only act on that if the
  // failure arrives as something other than a generic error.
  await assert.rejects(
    () =>
      pilotChat(
        options(),
        fakeExec(0, [done({ is_error: true, subtype: 'error', result: 'usage limit reached' })]),
      ),
    (err: unknown) => err instanceof RateLimitError,
  );
});

test('a stream with no result event is a failure that names how the child ended', async () => {
  // Both the empty-stdout and the no-result case are one finding from a caller's
  // side, and the ending is what separates "killed" from "ran and said nothing".
  const exec: RunFn = async () => ({ code: null, signal: 'SIGTERM', stdout: '', stderr: 'boom' });
  await assert.rejects(
    () => pilotChat(options(), exec),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /no result/);
      assert.deepEqual(endingOf(err), { code: null, signal: 'SIGTERM' });
      return true;
    },
  );
});

test('a complete successful result is accepted even when the child exited non-zero', async () => {
  // `claude.ts`'s rule, and the reason travels: teardown failing after the work
  // was done should not throw away a turn that has already been paid for. Unlike
  // a run turn there is nothing to warn into here, which is the point of the next
  // case.
  const result = await pilotChat(options(), fakeExec(7, [done()]));
  assert.equal(result.text, 'the whole reply');
});

// ---- the wall --------------------------------------------------------------

test('a pilot turn cannot narrate into a run, or charge one', () => {
  // The half that would fail silently. In the host, `log.ts`'s sink IS the run's
  // narration stream, so a `detail()` here would put the pilot's prose in the
  // output pane and, through `recordAndSay`, in `state.json`. And `applyCharge`
  // is the seam every token in the product is charged through; the pilot's are
  // not the product's.
  //
  // Asserted over the source because neither would throw - the run would simply
  // acquire lines nobody wrote, or end early one day for a reason nobody could
  // reconstruct.
  const source = readFileSync(path.join(process.cwd(), 'src', 'pilotchat.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const forbidden of ['log.js', 'charge.js', 'applyCharge', 'attachSpend', 'orchestrator']) {
    assert.ok(!code.includes(forbidden), `pilotchat.ts reaches ${forbidden}`);
  }
});

// ---- the parser on its own -------------------------------------------------

test('readDelta takes only a text fragment, and refuses rather than guesses', () => {
  assert.equal(readDelta(delta('hello')), 'hello');
  for (const line of [
    '',
    '   ',
    'not json at all',
    JSON.stringify({ type: 'assistant', message: { content: 'hello' } }),
    JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }),
    // A delta that is not text: a tool call's arguments stream this way too, and
    // putting one in the chat pane would show the user JSON they did not ask for.
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } },
    }),
    // An empty fragment is not a fragment. Emitting it would tick a pane for
    // nothing.
    delta(''),
  ]) {
    assert.equal(readDelta(line), null, line.slice(0, 60));
  }
});
