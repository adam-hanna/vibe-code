import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '@src/config.js';
import {
  clearPromptOverrides,
  critiquePrompt,
  installPromptOverrides,
  promptBlockNames,
  promptBlocks,
  reviewPrompt,
} from '@src/prompts.js';

/**
 * Replacing a standing instruction, per project (#223).
 *
 * **A reversal, and the reasoning it reverses is worth keeping.** The settings
 * screen said prompts were *"deliberately not configuration: they are the
 * product's behaviour, and a per-project override would mean two runs of the
 * same version could not be compared."* That cost is real. It is now paid on
 * purpose — *"We need to be able to edit the prompts"* — because an owner who
 * wants a reviewer under different standing instructions has no other way to get
 * one, and the product knowing better is not an answer.
 *
 * What keeps the cost visible rather than merely accepted is that an overridden
 * block is **named on the run's own config**: `prompts.<block>` is a setting like
 * any other, so `configDiff` reports it and a run's record says its reviewer was
 * told something different.
 *
 * ## Why it is a module latch and not a parameter
 *
 * Every builder in `prompts.ts` takes a long positional list, and three carry a
 * comment saying an inserted parameter *"would silently reinterpret"* an
 * existing call — so threading a config through seven of them is the change most
 * likely to go wrong quietly. `src/cancel.ts` takes the same shape for the same
 * trade, and it is safe for the same stated reason: one run per process.
 */

/** Restored after every case, so a latch cannot leak into the next one. */
function withOverrides(overrides: Record<string, string>, body: () => void): void {
  installPromptOverrides(overrides);
  try {
    body();
  } finally {
    clearPromptOverrides();
  }
}

const aPlan = 'a plan';

// ---- what an override reaches -----------------------------------------------

test('an overridden block renders in the prompts that carry it', () => {
  withOverrides({ 'review breadth': 'LOOK ONLY AT THE LINE I NAMED.' }, () => {
    // Both turns that `usedBy` names, because the claim is about the block
    // reaching a turn rather than about one call site.
    assert.match(critiquePrompt(aPlan, [], [], 0, false), /LOOK ONLY AT THE LINE I NAMED/);
    assert.match(reviewPrompt('diff', [], aPlan, [], 0, false), /LOOK ONLY AT THE LINE I NAMED/);
  });
});

test('the text it replaces is gone, not appended to', () => {
  // An override that merely added would leave the two instructions contradicting
  // each other, and the model would follow whichever came last.
  withOverrides({ 'review breadth': 'Only the line I named.' }, () => {
    assert.doesNotMatch(reviewPrompt('diff', [], aPlan, [], 0, false), /Do not stop at the first/);
  });
});

test('a block nobody overrode still renders the product’s own', () => {
  withOverrides({ 'review breadth': 'x' }, () => {
    assert.match(critiquePrompt(aPlan, [], [], 0, false), /No prose outside the JSON/);
  });
});

test('with nothing installed, every prompt is byte-identical to before', () => {
  // The property that makes this safe to add at all: a project that overrides
  // nothing gets exactly the prompts it got before the key existed.
  clearPromptOverrides();
  const before = reviewPrompt('diff', [], aPlan, [], 0, false);
  withOverrides({}, () => {
    assert.equal(reviewPrompt('diff', [], aPlan, [], 0, false), before);
  });
});

test('a blank override is ignored rather than sent', () => {
  // Clearing the box means *give me the default back*. An empty standing
  // instruction is not a weaker instruction, it is a missing one — and a
  // reviewer told nothing about breadth is a reviewer that stops at the first
  // instance of every defect.
  for (const blank of ['', '   ', '\n\n']) {
    withOverrides({ 'review breadth': blank }, () => {
      assert.match(reviewPrompt('diff', [], aPlan, [], 0, false), /Do not stop at the first/);
    });
  }
});

test('an override never leaks into the next run in this process', () => {
  // `execute` installs unconditionally and `clearPromptOverrides` is what an
  // empty table does — so there is no path that leaves a previous project's
  // standing instructions in place. One run per process is what makes a latch
  // safe; a latch that survived one would break that premise.
  withOverrides({ 'review breadth': 'LEAKED' }, () => undefined);
  assert.doesNotMatch(reviewPrompt('diff', [], aPlan, [], 0, false), /LEAKED/);
});

// ---- what the settings screen is told ---------------------------------------

test('a block reports what renders, the default, and which it is', () => {
  // `fallback` travels beside `text` so a screen can offer *revert to default*
  // without holding a second copy of the constant — which would be the app
  // owning a fact about the loop and going stale on the release that edits one.
  clearPromptOverrides();
  const before = promptBlocks().find((b) => b.name === 'review breadth');
  assert.ok(before !== undefined);
  assert.equal(before.overridden, false);
  assert.equal(before.text, before.fallback);

  withOverrides({ 'review breadth': 'mine' }, () => {
    const after = promptBlocks().find((b) => b.name === 'review breadth');
    assert.ok(after !== undefined);
    assert.equal(after.overridden, true);
    assert.equal(after.text, 'mine');
    assert.equal(after.fallback, before.fallback, 'the default must not move');
  });
});

// ---- the config that carries it ---------------------------------------------

function repoWith(config: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-prompt-cfg-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify(config), 'utf8');
  return dir;
}

test('a project’s override loads as a setting like any other', () => {
  const dir = repoWith({ prompts: { 'review breadth': 'mine' } });
  assert.equal(loadConfig(dir).prompts['review breadth'], 'mine');
});

test('a block name this build does not have is refused BY NAME', () => {
  // The whole reason the validator exists. An unknown key would otherwise be an
  // override that silently does nothing: `block()` finds no entry, renders the
  // default, and somebody who believes they changed the reviewer's instructions
  // finds out by reading a review that ignored them.
  const dir = repoWith({ prompts: { 'reviw breadth': 'typo' } });
  assert.throws(
    () => loadConfig(dir),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /reviw breadth/);
      // And it names the real ones, because that is what makes it actionable.
      assert.match(err.message, /review breadth/);
      return true;
    },
  );
});

test('every name the validator accepts is one a block actually has', () => {
  // One list, derived rather than written twice: a second copy is one that can
  // disagree, and the disagreement refuses a key that is real or accepts one
  // that is not.
  assert.deepEqual([...promptBlockNames()].sort(), promptBlocks().map((b) => b.name).sort());
  assert.ok(promptBlockNames().length > 0);
});

test('a config with no prompts section is an empty table, not a missing one', () => {
  // What keeps this safe to add to every existing project.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-prompt-none-'));
  assert.deepEqual(loadConfig(dir).prompts, {});
});
