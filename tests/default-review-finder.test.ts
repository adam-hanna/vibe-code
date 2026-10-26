import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execute, parseArgs, reportRoles, resumeConfig } from '@src/cli.js';
import {
  DEFAULT_FINDER_FOCUS,
  DEFAULTS,
  defaultReviewFinders,
  loadConfig,
  storedConfig,
  writeConfigPatch,
} from '@src/config.js';
import { createRun, loadRun, saveState } from '@src/run.js';
import { createSession } from '@src/serve.js';
import type { Outbound } from '@src/protocol.js';
import type { RoleProviders } from '@src/roles.js';
import type { Config } from '@src/types.js';
import { reviewingRun } from './helpers/loop-harness.js';

/**
 * One review finder by default, on the vendor the reviewer is not on (#447).
 *
 * The owner's decision of 2026-10-26, on a bench of 45 review loops. These
 * cases pin the rule and every road it is resolved on or deliberately not:
 * a fresh load resolves it unless a layer named the list; a resume and a fork
 * never do, because a run's finders are fixed when it starts; the settings
 * screen's global view resolves it by the same function; and where the list
 * came from is said, by `(default)`, without ever being stored.
 *
 * Each case that reads a global file points `VIBE_GLOBAL_CONFIG` at one of its
 * own and puts it back, as `global-config.test.ts` does.
 */

const CLAUDE_SEAT = { provider: 'claude', effort: 'high', focus: DEFAULT_FINDER_FOCUS };
const CODEX_SEAT = { provider: 'codex', focus: DEFAULT_FINDER_FOCUS };

function project(contents?: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-default-finder-'));
  if (contents !== undefined) writeFileSync(path.join(dir, 'vibe.config.json'), `${JSON.stringify(contents, null, 2)}\n`);
  return dir;
}

function globalFile(contents?: unknown): string {
  const at = path.join(mkdtempSync(path.join(os.tmpdir(), 'vibe-default-finder-global-')), 'config.json');
  if (contents !== undefined) writeFileSync(at, `${JSON.stringify(contents, null, 2)}\n`);
  return at;
}

function withGlobal<T>(at: string, body: () => T): T {
  const before = process.env['VIBE_GLOBAL_CONFIG'];
  process.env['VIBE_GLOBAL_CONFIG'] = at;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env['VIBE_GLOBAL_CONFIG'];
    else process.env['VIBE_GLOBAL_CONFIG'] = before;
  }
}

const ALL_CLAUDE = { planner: 'claude', implementer: 'claude', critic: 'claude', answerer: 'claude', reviewer: 'claude' } as const;
const ALL_CODEX = { planner: 'codex', implementer: 'codex', critic: 'codex', answerer: 'codex', reviewer: 'codex' } as const;

// ---- the rule ---------------------------------------------------------------

test('the seat is on the vendor the reviewer is not on, with the measured effort and focus, and no model', () => {
  // The default table: the reviewer on Codex, so the finder is Claude at high.
  assert.deepEqual(defaultReviewFinders(DEFAULTS.roles), [CLAUDE_SEAT]);
  // The reviewer on Claude: a Codex seat with no effort, so it takes codex.effort.
  const claudeReviewer = { ...DEFAULTS.roles, reviewer: { provider: 'claude' } } as RoleProviders;
  assert.deepEqual(defaultReviewFinders(claudeReviewer), [CODEX_SEAT]);
  assert.equal(Object.hasOwn(defaultReviewFinders(claudeReviewer)[0] ?? {}, 'effort'), false);
  // An object reviewer is read through the table, like any other role value.
  const objectReviewer = { ...DEFAULTS.roles, reviewer: { provider: 'codex', model: 'gpt-x' } } as RoleProviders;
  assert.deepEqual(defaultReviewFinders(objectReviewer), [CLAUDE_SEAT]);
  for (const roles of [DEFAULTS.roles, claudeReviewer, objectReviewer]) {
    for (const seat of defaultReviewFinders(roles)) assert.equal(Object.hasOwn(seat, 'model'), false, 'no model is ever named');
  }
});

test('a table all on one provider gets no default finder', () => {
  assert.deepEqual(defaultReviewFinders(ALL_CLAUDE), []);
  assert.deepEqual(defaultReviewFinders(ALL_CODEX), []);
});

// ---- a fresh load -----------------------------------------------------------

test('with no review section anywhere, a fresh load has the default finder and says so', () => {
  const cfg = loadConfig(project());
  assert.deepEqual(cfg.review.finders, [CLAUDE_SEAT]);
  assert.equal(cfg.findersDefaulted, true);
  // DEFAULTS is not where it lives.
  assert.deepEqual(DEFAULTS.review.finders, []);
});

test('a review section that does not name finders still gets the default', () => {
  const cfg = loadConfig(project({ review: { maxParallel: 2 } }));
  assert.deepEqual(cfg.review.finders, [CLAUDE_SEAT]);
  assert.equal(cfg.review.maxParallel, 2);
  assert.equal(cfg.findersDefaulted, true);
});

test('an empty list in the project file or the global file is the opt-out', () => {
  const fromProject = loadConfig(project({ review: { finders: [] } }));
  assert.deepEqual(fromProject.review.finders, []);
  assert.equal(fromProject.findersDefaulted, false);
  withGlobal(globalFile({ review: { finders: [] } }), () => {
    const fromGlobal = loadConfig(project());
    assert.deepEqual(fromGlobal.review.finders, []);
    assert.equal(fromGlobal.findersDefaulted, false);
  });
});

test('a configured list wins unchanged, even one that matches the default', () => {
  const written = [{ provider: 'codex', model: 'gpt-fixture', focus: 'security' }, 'claude'];
  const cfg = loadConfig(project({ review: { finders: written } }));
  assert.deepEqual(cfg.review.finders, written);
  assert.equal(cfg.findersDefaulted, false);
  const same = loadConfig(project({ review: { finders: [CLAUDE_SEAT] } }));
  assert.deepEqual(same.review.finders, [CLAUDE_SEAT]);
  assert.equal(same.findersDefaulted, false, 'a hand-written seat is never marked as the default');
});

test('--role moving the reviewer moves the default finder with it', () => {
  const cfg = loadConfig(project(), {}, { reviewer: { provider: 'claude' } });
  assert.deepEqual(cfg.review.finders, [CODEX_SEAT]);
  // So does a file's roles, and a table on one provider gets none.
  assert.deepEqual(loadConfig(project({ roles: { reviewer: 'claude' } })).review.finders, [CODEX_SEAT]);
  const single = loadConfig(project({ roles: ALL_CLAUDE }));
  assert.deepEqual(single.review.finders, []);
  assert.equal(single.findersDefaulted, false);
});

test('the opt-out option leaves the layers as they are', () => {
  const cfg = loadConfig(project(), {}, {}, { defaultFinders: false });
  assert.deepEqual(cfg.review.finders, []);
  assert.equal(cfg.findersDefaulted, false);
});

test('a stored config carries no trace of where the finders came from', () => {
  const dir = project();
  const loaded = loadConfig(dir);
  const stored = storedConfig(loaded);
  assert.equal(Object.hasOwn(stored, 'findersDefaulted'), false);
  assert.equal(stored.configPath, loaded.configPath);
  assert.deepEqual(stored.review.finders, [CLAUDE_SEAT]);
});

// ---- resume and fork: fixed when the run starts -----------------------------

function runWith(dir: string, config: Config | undefined): string {
  const state = createRun(dir, 'default finder resume', false);
  if (config === undefined) delete state.config;
  else state.config = config;
  saveState(state);
  return state.id;
}

function resumed(dir: string, id: string): Config {
  return resumeConfig(dir, loadRun(dir, id), parseArgs([]).flags);
}

test('a run stored with no finders resumes with none', () => {
  const dir = project();
  const id = runWith(dir, structuredClone(DEFAULTS) as Config);
  assert.deepEqual(resumed(dir, id).review.finders, []);
  assert.deepEqual(loadRun(dir, id).config?.review.finders, []);
});

test('a run stored with the default finder keeps it on resume', () => {
  const dir = project({ roles: ALL_CLAUDE });
  // Even under a file whose table would now resolve none: only a file naming
  // review.finders moves a stored list.
  const id = runWith(dir, structuredClone(storedConfig(loadConfig(project()))) as Config);
  assert.deepEqual(resumed(dir, id).review.finders, [CLAUDE_SEAT]);
});

test('a file naming finders still wins on resume, the project and the global alike', () => {
  const dir = project({ review: { finders: ['codex'] } });
  const id = runWith(dir, structuredClone(DEFAULTS) as Config);
  assert.deepEqual(resumed(dir, id).review.finders, ['codex']);

  const plain = project();
  const other = runWith(plain, structuredClone(storedConfig(loadConfig(project()))) as Config);
  withGlobal(globalFile({ review: { finders: [] } }), () => {
    assert.deepEqual(resumed(plain, other).review.finders, []);
  });
});

test('a run with no stored config resumes with no default finder, and stores no provenance', () => {
  const dir = project();
  const id = runWith(dir, undefined);
  assert.deepEqual(resumed(dir, id).review.finders, []);
  const stored = loadRun(dir, id).config;
  assert.deepEqual(stored?.review.finders, []);
  assert.equal(Object.hasOwn(stored ?? {}, 'findersDefaulted'), false);
});

// ---- the write that clears the key ------------------------------------------

test('a patch naming finders null deletes the key, keeping the rest of review', () => {
  const dir = project({ review: { finders: ['codex'], quorum: null, maxParallel: 2 }, loop: { maxPlanRounds: 4 } });
  writeConfigPatch(dir, { review: { finders: null } });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'vibe.config.json'), 'utf8')), {
    review: { quorum: null, maxParallel: 2 },
    loop: { maxPlanRounds: 4 },
  });
  // And the file now follows the default again.
  assert.equal(loadConfig(dir).findersDefaulted, true);
});

test('a review emptied by the clear is dropped, in either file', () => {
  const dir = project({ review: { finders: [] }, loop: { maxPlanRounds: 4 } });
  writeConfigPatch(dir, { review: { finders: null } });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'vibe.config.json'), 'utf8')), { loop: { maxPlanRounds: 4 } });

  const at = globalFile({ review: { finders: [] } });
  withGlobal(at, () => {
    writeConfigPatch(null, { review: { finders: null } }, 'global');
    assert.deepEqual(JSON.parse(readFileSync(at, 'utf8')), {});
  });
});

test('a finders null somebody wrote by hand is left alone by an unrelated save', () => {
  const dir = project({ review: { finders: null } });
  // Not a legal list, and refused as it always was: `null` means nothing new at load time.
  assert.throws(() => loadConfig(dir));
  const file = path.join(dir, 'vibe.config.json');
  writeFileSync(file, JSON.stringify({ review: { finders: null }, verify: { enabled: false } }));
  assert.throws(() => writeConfigPatch(dir, { verify: { enabled: true } }));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { review: { finders: null }, verify: { enabled: false } });
});

// ---- the settings screen's global view --------------------------------------

function globalEffective(): Record<string, unknown> {
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0) });
  session.receive(JSON.stringify({ type: 'config', id: 1, scope: 'global' }));
  const reply = sent[0];
  assert.equal(reply?.type, 'config', JSON.stringify(sent));
  return (reply as { globalEffective: Record<string, unknown> }).globalEffective;
}

test('the global view carries the default finder unless the global file names the list', () => {
  withGlobal(globalFile({ loop: { maxPlanRounds: 4 } }), () => {
    assert.deepEqual((globalEffective()['review'] as Config['review']).finders, [CLAUDE_SEAT]);
  });
  withGlobal(globalFile({ review: { finders: [] } }), () => {
    assert.deepEqual((globalEffective()['review'] as Config['review']).finders, []);
  });
  withGlobal(globalFile({ roles: { reviewer: 'claude' } }), () => {
    assert.deepEqual((globalEffective()['review'] as Config['review']).finders, [CODEX_SEAT]);
  });
});

// ---- the line before the first turn -----------------------------------------

function captured(work: () => unknown): string[] {
  const out: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => void out.push(parts.map((p) => String(p)).join(' '));
  console.log = collect;
  console.error = collect;
  try {
    work();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return out;
}

const finders = (out: readonly string[]): string[] => out.filter((l) => l.includes('Finders:'));

test('the startup marks the default finder, and only when it is one', () => {
  const cfg = loadConfig(project());
  assert.deepEqual(finders(captured(() => reportRoles(cfg, true))), ['  Finders: claude/high (default)']);
  assert.deepEqual(finders(captured(() => reportRoles(cfg))), ['  Finders: claude/high']);
});

async function startup(cfg: Config): Promise<string[]> {
  const state = reviewingRun({ prefix: 'vibe-default-finder-run-' });
  const out: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => void out.push(parts.map((p) => String(p)).join(' '));
  console.log = collect;
  console.error = collect;
  try {
    await execute(state, cfg, false, true, () => Promise.resolve(null), () => Promise.resolve(0));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return finders(out);
}

test('a fresh run says (default); the same finders from a stored config do not', async () => {
  const loaded = loadConfig(project());
  assert.deepEqual(await startup(loaded), ['  Finders: claude/high (default)']);
  // What a resume hands `execute`: the run's stored config, which has no provenance.
  assert.deepEqual(await startup(storedConfig(loaded)), ['  Finders: claude/high']);
});
