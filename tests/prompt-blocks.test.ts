import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession } from '@src/serve.js';
import { promptBlocks } from '@src/prompts.js';
import type { Outbound } from '@src/protocol.js';

/**
 * The standing instructions a settings screen may show (#223).
 *
 * Asked for in one line — *"The prompts being used for each turn should also go
 * there"* — and the whole design is in what it declines to do. A prompt in this
 * repo is a **function of the run**: `planPrompt` takes the task and the
 * prior-run index, `critiquePrompt` takes the plan it is judging, `fixPrompt`
 * takes the findings and the diff. There is no such thing as "the implement
 * prompt" outside a run, so a screen rendering one from invented inputs would be
 * the fabrication every other rule here is arranged against.
 *
 * What there is instead is the part that does not vary — the blocks every turn
 * of a kind gets unchanged — returned **verbatim from the constants the prompts
 * interpolate**, so a screen drawing them is quoting the product rather than
 * describing it.
 *
 * The claim that needs a test is `usedBy`, and it is the one a reader cannot
 * check: the interpolation sites are in five different template literals, so a
 * list written beside the block could quietly stop being true. This file reads
 * `src/prompts.ts` as source and checks each block is interpolated into a
 * function named for each role it claims — the same shape `artifacts.test.ts`
 * uses to pin the app's copy of the loop's filenames.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', '..', 'src', 'prompts.ts'), 'utf8');

/** Which prompt builder each role's turn is assembled by. */
const BUILDER: Readonly<Record<string, readonly string[]>> = {
  planner: ['planPrompt', 'revisePlanPrompt'],
  critic: ['critiquePrompt'],
  answerer: ['answerPrompt'],
  implementer: ['implementPrompt', 'fixPrompt'],
  reviewer: ['reviewPrompt'],
};

/** The constant a block is, by the name the frame gives it. */
const CONSTANT: Readonly<Record<string, string>> = {
  'respond with JSON': 'RESPOND_WITH_JSON',
  'review breadth': 'REVIEW_BREADTH',
  'fix breadth': 'FIX_BREADTH',
  'a deferred finding': 'DEFERRED_MARK',
};

/** The source of one function, from its signature to the next top-level one. */
function bodyOf(name: string): string {
  const at = source.search(new RegExp(String.raw`^(?:export )?function ${name}\(`, 'm'));
  if (at < 0) return '';
  const next = source.slice(at + 1).search(/^(?:export )?function /m);
  return next < 0 ? source.slice(at) : source.slice(at, at + 1 + next);
}

/**
 * Whether a builder's prompt carries a constant, following one hop.
 *
 * **A block can reach a turn through a helper**, and `DEFERRED_MARK` does:
 * `formatFinding` renders it and the two prompts that are given a findings list
 * call that. A check that only looked inside the builder itself would have
 * failed a claim that is true - so it follows every locally-defined function the
 * builder names, which is one level and is as far as this file goes.
 */
function carries(builder: string, constant: string): boolean {
  const body = bodyOf(builder);
  if (body === '') return false;
  if (body.includes(constant)) return true;
  for (const m of source.matchAll(/^(?:export )?function ([a-zA-Z]+)\(/gm)) {
    const helper = m[1];
    if (helper === undefined || helper === builder) continue;
    if (!new RegExp(String.raw`\b${helper}\b`).test(body)) continue;
    if (bodyOf(helper).includes(constant)) return true;
  }
  return false;
}

test('every block is text, named, and says who gets it', () => {
  const blocks = promptBlocks();
  assert.ok(blocks.length > 0, 'a settings screen with no blocks shows nothing');
  for (const block of blocks) {
    assert.ok(block.name.trim() !== '', 'a block with no name cannot be drawn');
    assert.ok(block.text.trim() !== '', `${block.name} is empty`);
    assert.ok(block.usedBy.length > 0, `${block.name} claims no turn`);
    for (const role of block.usedBy) {
      assert.ok(BUILDER[role] !== undefined, `${block.name} names an unknown role "${role}"`);
    }
  }
});

test('`usedBy` is true of the source, not a list that went stale beside it', () => {
  // The claim a reader cannot check. A block named as reaching the reviewer
  // must actually be interpolated into the function that builds a reviewer's
  // turn - and the day one stops being, this fails in the commit that did it
  // rather than in a settings screen somebody opens a month later.
  for (const block of promptBlocks()) {
    const constant = CONSTANT[block.name];
    assert.ok(constant !== undefined, `no constant is recorded for "${block.name}"`);
    for (const role of block.usedBy) {
      const reaches = (BUILDER[role] ?? []).some((fn) => carries(fn, constant));
      assert.ok(reaches, `${block.name} claims ${role}, but ${constant} is not in its prompt`);
    }
  }
});

test('the text is the constant itself, never a summary of it', () => {
  // The point of showing a prompt is that it is what the model was actually
  // given. A paraphrase would be a screen describing the product.
  const breadth = promptBlocks().find((b) => b.name === 'review breadth');
  assert.ok(breadth !== undefined);
  assert.ok(source.includes(breadth.text), 'the block does not appear in prompts.ts verbatim');
});

test('the frame answers with the blocks and names no run', () => {
  // The only read on this wire that names neither a repository nor a run, and
  // the absence is the point: these are the same in every run, which is what
  // makes them a SETTING rather than a fact about one.
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0) });
  session.receive(JSON.stringify({ type: 'prompts', id: 1 }));

  const frame = sent[0];
  assert.equal(frame?.type, 'prompts');
  assert.deepEqual(frame.type === 'prompts' ? frame.blocks : null, promptBlocks());
});

test('it is answered while a run is going, like every other read', () => {
  // The strongest version of the reason the other reads are exempt from the
  // one-at-a-time rule: this one cannot even observe a run.
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => new Promise<number>(() => undefined),
  });
  session.receive(JSON.stringify({ type: 'invoke', id: 1, argv: ['run', 'something'] }));
  session.receive(JSON.stringify({ type: 'prompts', id: 2 }));

  assert.ok(
    sent.some((f) => f.type === 'prompts'),
    `not answered during a run: ${sent.map((f) => f.type).join(', ')}`,
  );
});
