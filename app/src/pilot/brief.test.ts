import { describe, expect, test } from 'vitest';
import pilotPane from './PilotPane.tsx?raw';
import { launchArgv, readLaunchArgv } from '../cockpit/argv';
import { systemPrompt } from './brief';
import { emptyRun, reduce } from '../cockpit/model';
import type { Frame } from '../host';
import type { Run } from '../cockpit/model';

/**
 * What the pilot is told about the run (#191).
 *
 * Until this landed, `Turn.system` was a field nothing set, so every pilot
 * conversation opened knowing nothing at all - no task, no phase, no round. The
 * cases worth having are the two directions this can be wrong in: a prompt that
 * describes a run nobody started, and a prompt that fails to describe one that is
 * going.
 */

const narrate = (id: string, data: Record<string, unknown>): Frame => ({
  type: 'narration',
  level: 'step',
  message: 'a sentence, which nothing here reads',
  id,
  data,
});

/** A run partway through implementing, built the only way a run can be: frames. */
function runningRun(): Run {
  let run = emptyRun();
  const at = 1_000;
  for (const frame of [
    narrate('phase_started', { phase: 'planning', round: 1 }),
    narrate('turn_started', { role: 'planner', kind: 'plan', round: 1 }),
    narrate('phase_started', { phase: 'implementing', round: 2 }),
    narrate('turn_started', { role: 'implementer', kind: 'implement', round: 2 }),
  ]) {
    run = reduce(run, frame, at);
  }
  return run;
}

describe('the brief reaches the pilot', () => {
  test('a launch is read back out of the argv that was sent', () => {
    // The round trip is the point: `launchArgv` is the one builder and this is
    // the one reader, so a flag added to the first has to be handled by the
    // second or this fails.
    const argv = launchArgv('  do the thing  ', '  C:/repo  ', false);
    expect(readLaunchArgv(argv)).toEqual({ task: 'do the thing', dir: 'C:/repo', planOnly: false });
    expect(readLaunchArgv(launchArgv('x', '/r', true))?.planOnly).toBe(true);
  });

  test('an argv this build does not recognise is absent, not half-read', () => {
    // A pilot proposal, a newer build, a resume: all of them can produce an argv
    // this reader has never seen. Absent is the honest answer and the prompt has
    // wording for it; a partially-understood launch would put a directory in
    // front of the model with no idea whether the brief beside it was the one
    // that ran.
    for (const argv of [
      [],
      ['run'],
      ['resume', '20260101-000000-x'],
      ['run', 'task', '-C', '/r', '--max-tokens', '900000'],
      ['run', 'task', '--dir', '/r'],
      ['plan', '', '-C', '/r'],
    ]) {
      expect(readLaunchArgv(argv)).toBeNull();
    }
  });

  test('the whole brief goes to the model, not a summary of it', () => {
    // AGENTS.md's hardest-won lesson is that the brief is what decides whether a
    // run converges. Truncating it here would leave the pilot reasoning about a
    // different task from the one that is running.
    const task = `line one\n${'x'.repeat(4000)}\nlast line`;
    const prompt = systemPrompt(emptyRun(), { task, dir: '/r', planOnly: false });
    expect(prompt).toContain(task);
  });

  test('a window that launched nothing says so instead of describing a run', () => {
    const prompt = systemPrompt(emptyRun(), null);
    expect(prompt).toContain('Nothing has been launched from this window');
    // And it does not claim there is no run, because a run may have been started
    // elsewhere - the two are different facts and the prompt keeps them apart.
    expect(prompt).toContain('started elsewhere');
  });

  test('plan-only and a full run are not described the same way', () => {
    // The one difference a person is warned about on the form, so the pilot has
    // to have it too: proposing a follow-up is a different act depending on
    // whether the thing beside you commits code.
    const planning = systemPrompt(emptyRun(), { task: 't', dir: '/r', planOnly: true });
    const running = systemPrompt(emptyRun(), { task: 't', dir: '/r', planOnly: false });
    expect(planning).toContain('writes no code');
    expect(running).toContain('writes code and commits');
  });
});

describe('the run in the prompt is the run read_run reports', () => {
  test('the phases and the running turn are in it', () => {
    const prompt = systemPrompt(runningRun(), null);
    expect(prompt).toContain('"phase": "planning"');
    expect(prompt).toContain('"phase": "implementing"');
    expect(prompt).toContain('"role": "implementer"');
  });

  test('a run nothing has narrated is empty rather than absent', () => {
    // A real state, and it has to read as one. `describeRun` is called either
    // way, so the model sees an empty cycles array and the sentence explaining
    // what a null means - not a prompt that quietly omits the section.
    const prompt = systemPrompt(emptyRun(), null);
    expect(prompt).toContain('"cycles": []');
    expect(prompt).toContain('"running": null');
    expect(prompt).toContain('never zero');
  });

  test('it carries what this build cannot see, rather than leaving it to be guessed', () => {
    // `describeRun`'s `unavailable` list. A model asked "has this been tried
    // before" with no archive and no statement that there is no archive will
    // answer from nothing at all.
    expect(systemPrompt(emptyRun(), null)).toContain('#114');
  });

  test('there is exactly one description of a run and the tool owns it', () => {
    // The structural half. `brief.ts` importing `describeRun` is what makes the
    // prompt and `read_run` incapable of disagreeing; a second description
    // written for the prompt would diverge on the first field either one gained.
    // Asserted here rather than by comparing two outputs, because two outputs
    // that agree today is not the property worth pinning.
    const prompt = systemPrompt(runningRun(), null);
    const marker = '## The run, as this window holds it';
    const json: unknown = JSON.parse(
      prompt.slice(prompt.indexOf('{', prompt.indexOf(marker)), prompt.lastIndexOf('}') + 1),
    );
    expect(Object.keys(json as object).sort()).toEqual([
      'completed',
      'cycles',
      'ended',
      'gate',
      'protocol',
      'questions',
      'reason',
      'running',
      'unavailable',
    ]);
  });
});

describe('every turn carries it', () => {
  test('the one place a turn is sent sets a system prompt', () => {
    // Source-level, in `keys.test.ts`'s idiom, because the defect this replaces
    // was an omission: `pilot.send` was called without `system` and nothing
    // anywhere failed. A test of the prompt's contents cannot catch that - the
    // prompt was fine, it was just never sent.
    const sends = [...pilotPane.matchAll(/pilot\s*\n?\s*(?:\/\/[^\n]*\n\s*)*\.send\(/g)];
    expect(sends.length).toBe(1);
    expect(pilotPane).toContain('system: systemPrompt(run, launched)');
  });
});
