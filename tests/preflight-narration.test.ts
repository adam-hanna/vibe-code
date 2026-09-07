import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPreflight } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import * as log from '@src/log.js';
import { PROBE_ORDER } from '@src/preflight.js';
import { createRun } from '@src/run.js';
import { initGit } from './helpers/loop-harness.js';
import type { Narration } from '@src/log.js';
import type { AgentPreflight, PreflightProbes } from '@src/preflight.js';
import type { Config } from '@src/types.js';

/**
 * What preflight says while it is running (#205).
 *
 * Preflight spawns a probe turn against each agent and, until this, narrated
 * nothing at all between the heading and the report. In the terminal that is a
 * pause; in the desktop app it is a blank window for the seconds after the one
 * action a new user knows how to take, which is what the manual pass reported
 * as *"it appeared like nothing happened for a while"*.
 *
 * These assert on **ids and data, never on English** - the property that lets a
 * sentence be improved without breaking the app, and the reason #133 exists.
 * The order claim is the one worth the most: the announcement has to come
 * before the child process, because the child process is the wait.
 */

const clean = (over: Partial<Config> = {}): Config => ({
  ...DEFAULTS,
  codex: { ...DEFAULTS.codex, readRateLimits: false },
  progress: { ...DEFAULTS.progress, enabled: false },
  ...over,
});

/**
 * A probe that found nothing wrong.
 *
 * `runtime: null` is the shape the accounting fixtures use: the environment
 * report is not what these cases are about, and a null runtime simply skips the
 * two `claude:`/`codex:` lines - neither of which carries an id, so the sequence
 * under test is unaffected either way.
 */
const ok: AgentPreflight = {
  runtime: null,
  violations: [],
  prepared: null,
  probeError: null,
};

/** Probes that record when they were called, relative to the narration. */
function watching(seen: string[]): PreflightProbes {
  return {
    claude: () => {
      seen.push('probe:claude');
      return Promise.resolve(ok);
    },
    codex: () => {
      seen.push('probe:codex');
      return Promise.resolve(ok);
    },
  };
}

/** Run preflight with a sink installed and the console silenced. */
async function narrated(
  seen: string[],
): Promise<Narration[]> {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-preflight-narration-'));
  initGit(dir);
  const state = createRun(dir, 'say what preflight is doing', false);

  const said: Narration[] = [];
  const realLog = console.log;
  const realError = console.error;
  log.setSink((n) => {
    said.push(n);
    if (n.id !== null) seen.push(`say:${n.id}`);
  });
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await runPreflight(state, clean(), watching(seen));
  } finally {
    console.log = realLog;
    console.error = realError;
    log.setSink(null);
  }
  return said;
}

test('preflight narrates its start, each probe and its verdict', async () => {
  const said = await narrated([]);
  const ids = said.map((n) => n.id).filter((id): id is string => id !== null);

  assert.deepEqual(ids, [
    'preflight_started',
    'probe_started',
    'probe_started',
    'preflight_passed',
  ]);
});

test('the start carries the agents it is about to probe, in the order it probes them', async () => {
  // Sent as data rather than left to be read out of two sentences. The list is
  // `PROBE_ORDER`, so an announcement cannot describe a different sequence from
  // the one that runs.
  const said = await narrated([]);
  const start = said.find((n) => n.id === 'preflight_started');
  assert.deepEqual(start?.data?.['agents'], [...PROBE_ORDER]);

  assert.deepEqual(
    said.filter((n) => n.id === 'probe_started').map((n) => n.data?.['agent']),
    [...PROBE_ORDER],
  );
});

test('each probe is announced before it is spawned, because the spawn is the wait', async () => {
  // The whole point. Announcing afterwards would name the agent that has just
  // finished and leave the silence exactly where it was.
  const seen: string[] = [];
  await narrated(seen);

  assert.deepEqual(seen, [
    'say:preflight_started',
    'say:probe_started',
    'probe:claude',
    'say:probe_started',
    'probe:codex',
    'say:preflight_passed',
  ]);
});

test('a skipped probe still narrates nothing at all', async () => {
  // `--skip-probe` printed nothing before #71 and prints nothing now. A window
  // draws no preflight row rather than one that never finishes.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-preflight-skipped-'));
  initGit(dir);
  const state = createRun(dir, 'skip the probe', false);

  const said: Narration[] = [];
  const realLog = console.log;
  log.setSink((n) => void said.push(n));
  console.log = () => undefined;
  try {
    await runPreflight(state, clean(), watching([]), { skipProbe: true });
  } finally {
    console.log = realLog;
    log.setSink(null);
  }

  assert.deepEqual(said, []);
});
