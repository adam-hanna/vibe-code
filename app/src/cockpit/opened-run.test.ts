import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import column from './RecordColumn.tsx?raw';
import settings from './Settings.tsx?raw';
import pilot from '../pilot/PilotPane.tsx?raw';
import { chatKey, chatMove } from '../pilot/saved';
import { recorded } from './format';

/**
 * Opening a run, and what follows it (#223).
 *
 * Two reports in one line: *"when I click on an existing run, I don't see the
 * right nav update, nor do I see the pilot chat update."* They are separate
 * defects with one shape — the window is pointed at a run and something on
 * screen is still about a different one.
 */

describe('the column follows the run the window is pointed at', () => {
  test('a past run gets a record, and the live run is still narrated', () => {
    // Not the live column with its clocks stopped. `reduce` builds a `Run` out
    // of narration and a finished run's narration went to a process that has
    // exited, so there is no live card to draw and none is invented — what
    // replaces it is the run's own record, read by the core off `state.json`.
    expect(cockpit).toMatch(/past && viewing !== null \? \(\s*<RecordColumn/);
    expect(cockpit).toMatch(/<LoopColumn run=\{run\}/);
  });

  test('the record is asked for only when the window is NOT narrating that run', () => {
    // For the live run the window already has something strictly better than a
    // record — the narration itself — so asking would be a read whose answer is
    // already on screen and one tick staler.
    expect(cockpit).toMatch(/useRecord\(\s*past && viewing !== null \? viewing\.dir : ''/);
  });

  test('nothing in the record column pulses, and every time on it is absolute', () => {
    // *Exactly one element on screen pulses*, and on a run that ended on Tuesday
    // the honest count is zero. `6s ago` is a claim that has to keep being true,
    // which is how a held gate came to read `5h39m ago` about a turn that took a
    // minute (hi-fi 17).
    expect(column).not.toMatch(/LivenessDot|ThinkingWave|elapsed\(/);
    expect(column).toMatch(/recorded\(record\.createdAt\)/);
    expect(column).toMatch(/recorded\(record\.lastActivityAt\)/);
  });

  test('an absolute stamp carries the day, not just the time', () => {
    // `clock` renders a moment inside the run you are watching, where the date
    // is today by construction. A record may be a week old, and `15:33` with no
    // day attached reads as this afternoon every time.
    const stamp = recorded('2026-01-05T15:33:00.000Z');
    expect(stamp).not.toBe('not recorded');
    expect(stamp).toMatch(/\d/);
    // Two fields, so it cannot be a bare time.
    expect(stamp.length).toBeGreaterThan('15:33'.length);
  });

  test('a timestamp another process wrote badly is said to be unrecorded', () => {
    // `Invalid Date` where a measurement goes reads as something somebody took.
    for (const bad of [null, '', 'the other day', '2026-13-45']) {
      expect(recorded(bad)).toBe('not recorded');
    }
  });

  test('the record column starts no run, because 1b is the only place that does', () => {
    // A control here would be a second way to spend, which is the same mistake
    // as two places able to force a lock.
    expect(column).not.toMatch(/invoke|launchArgv|host\.send/);
    expect(column).toMatch(/onClick=\{onResume\}/);
  });

  test('a refusal is shown in the core’s own words', () => {
    // A run whose id will not join onto a path, a directory vibe refuses to
    // follow (#53) and a `state.json` the validators reject are three findings
    // needing three responses, and *"could not read the run"* answers none.
    expect(column).toMatch(/\{failure\}/);
  });

  test('a run that charged nothing says so rather than showing zero', () => {
    expect(column).toMatch(/spend\.tokens === 0 \? \(\s*'nothing charged'/);
  });
});

describe('a conversation belongs to the run it is about', () => {
  const dir = 'C:/repo';
  const A = chatKey(dir, 'run-a');
  const B = chatKey(dir, 'run-b');
  const bucket = chatKey(dir, null);

  test('a brief typed while a past run was open is adopted by the run it proposes', () => {
    // **The defect.** Adoption used to be allowed only out of the project
    // bucket, which is right about where a pre-run conversation lives and wrong
    // about where one can be typed: open run A, type the brief for a new run,
    // press the proposal — the exchange stayed under A's key and the run it
    // proposed started life with nothing. Opening that run then showed an empty
    // pane, which is the report one step removed from its cause.
    expect(chatMove({ from: A, to: B, intoRun: true, stored: false, holding: true })).toBe('adopt');
  });

  test('the project bucket is still adopted, which is the case that already worked', () => {
    expect(chatMove({ from: bucket, to: B, intoRun: true, stored: false, holding: true })).toBe(
      'adopt',
    );
  });

  test('a RESUME restores rather than adopting over a real conversation', () => {
    // The guard the widening needs. That run has its own exchange and it is the
    // one worth keeping — adopting over it would destroy a real conversation to
    // save a stray one, which is strictly worse than the bug this fixes.
    expect(chatMove({ from: A, to: B, intoRun: true, stored: true, holding: true })).toBe('restore');
  });

  test('an empty screen adopts nothing, so a run does not inherit a blank', () => {
    expect(chatMove({ from: A, to: B, intoRun: true, stored: false, holding: false })).toBe(
      'restore',
    );
  });

  test('going back to the project bucket restores it, never adopts into it', () => {
    // `intoRun` is false, and it has to be: the bucket is where a conversation
    // waits for a run, not a run of its own.
    expect(chatMove({ from: A, to: bucket, intoRun: false, stored: true, holding: true })).toBe(
      'restore',
    );
  });

  test('the first load of the window restores and cannot adopt', () => {
    // `from` is null because this window has shown nothing yet, so there is no
    // exchange that could have proposed anything.
    expect(chatMove({ from: null, to: B, intoRun: true, stored: false, holding: true })).toBe(
      'restore',
    );
  });

  test('a key that has not moved does nothing at all', () => {
    // The loader must not run mid-conversation: a restore at that moment is a
    // conversation replaced by itself-from-disk, losing the turn in flight.
    expect(chatMove({ from: B, to: B, intoRun: true, stored: true, holding: true })).toBe('stay');
  });

  test('only the project bucket is cleared after an adoption', () => {
    // Taking a *run's* key away would delete a real conversation to tidy up
    // after a move.
    expect(pilot).toMatch(/if \(before === bucket\) localStorage\.removeItem\(bucket\)/);
  });

  test('the decision is pure, so it is this file that checks it', () => {
    // The app has no jsdom, so a rule living inside an effect is a rule nothing
    // tests — which is how the narrow adoption survived being written down.
    expect(pilot).toMatch(/const move = chatMove\(\{/);
  });

  test('a run with no stored conversation says so, rather than "nothing yet"', () => {
    // Two different emptinesses drawn as one. Beside a run, *"nothing yet"*
    // reads as the pane having failed to load something — which is exactly how
    // it was reported.
    expect(pilot).toMatch(/No conversation was kept for this run/);
    expect(pilot).toMatch(/runId === null \? \(/);
  });
});

describe('a model is picked from a list this build ships, and typed past it', () => {
  test('the cell is a select, fed by the core rather than by the window', () => {
    // The list lives beside `DEFAULTS` in the core, for the reason
    // `pilot.MODELS` gives about Rust: a list compiled into the surface that
    // displays it goes stale on somebody else's schedule instead of ours.
    expect(settings).toMatch(/<ModelField/);
    expect(settings).toMatch(/known=\{frame\.models\[current\.provider \?\? ''\] \?\? \[\]\}/);
  });

  test('a configured model this build does not know is still offered', () => {
    // A select that could not represent its own value would rewrite a role's
    // model by rendering — the worst kind of data loss, because nobody pressed
    // anything. It may be a model that shipped after this build.
    expect(settings).toMatch(/!known\.includes\(current\)/);
  });

  test('there is always a way to type one, and it is not the empty option', () => {
    // Empty already means *take the agent's default*; `other…` means *let me
    // type one*. Collapsing them would make clearing the box look like asking
    // to type, and the two are opposite intentions.
    expect(settings).toMatch(/const OTHER = ' other'/);
    expect(settings).toMatch(/<option value=\{OTHER\}>other/);
    expect(settings).toMatch(/<option value="">— \{agent\} default —<\/option>/);
  });

  test('the list is per agent and never borrowed from the other one', () => {
    // A Claude model handed to Codex is a turn that fails after it has been
    // spawned.
    expect(settings).toMatch(/agent=\{current\.provider \?\? 'agent'\}/);
  });
});
