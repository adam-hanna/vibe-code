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
      ['run', 'task', '--dir', '/r'],
      ['plan', '', '-C', '/r'],
      // A flag this build has never heard of. The brief and the directory are
      // still in the first four slots and are still readable - and it is STILL
      // null, because the reader accounting for the whole argv is what keeps the
      // round trip above a real guard rather than a shape check on a prefix.
      ['run', 'task', '-C', '/r', '--branch', 'feat/x'],
      // A known flag with no value after it. Half a pair is not a pair.
      ['run', 'task', '-C', '/r', '--max-tokens'],
    ]) {
      expect(readLaunchArgv(argv)).toBeNull();
    }
  });

  test('the overrides an argv carries do not cost it its brief (#223)', () => {
    // `4a`'s overrides block emits `--gate`, `--role`, `--max-tokens` and
    // `--p1-tolerance`, and the pilot still has to be able to say what run it is
    // sitting beside. The brief and the repository are in the same two slots
    // whatever follows them.
    const argv = launchArgv('do the thing', 'C:/repo', false, {
      gates: { 'plan-round': 'auto' },
      maxTokens: 900_000,
    });
    expect(readLaunchArgv(argv)).toEqual({
      task: 'do the thing',
      dir: 'C:/repo',
      planOnly: false,
    });
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

  test('it names the archive tool, and never also says there is none', () => {
    // Decision 4's "yet" arrived with #114. A prompt holding one sentence that
    // offers `read_archive` and another saying there is no archive tool is a
    // rule half-lifted, and the model would have to pick which to believe.
    const prompt = systemPrompt(emptyRun(), null);
    expect(prompt).toContain('read_archive');
    expect(prompt).not.toMatch(/no tool that reads the run archive|There is no archive tool/);
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
      // What earlier sessions of a resumed run did (#211). Null here, because
      // `runningRun()` is not a resume - but present, because the field is not
      // conditional: a key that appeared only sometimes would have the model
      // reading its absence as "this is not a resume" on a build that simply
      // had nothing to say.
      'before',
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
    // The API road names its channel and the access settings now (#223); what
    // is pinned is still that the one send carries the prompt.
    expect(pilotPane).toContain('system: systemPrompt(run, launched, ');
  });
});

describe('the pilot is told to read the request before it proposes a run (#223)', () => {
  /**
   * **The change that made the pane a front door rather than a form.**
   * Structurally it already was one — the launch bar went in #211 and
   * `start_run` became a proposal — but nothing in the prompt said that reading
   * the request was part of the job, so a brief typed in came straight back as
   * an argv. Reported as *"I don't want the run to start automatically… I want
   * the pilot to do diligence, think critically, uncover potential gotchas, ask
   * the user clarifications."*
   *
   * Diligence is judgement and is instructed rather than enforced, at the
   * owner's decision, so what can be checked here is that the instruction is
   * **present, reaches both backends, and carries its bound**. That last one is
   * the half a test is actually good for: an instruction to be thorough with no
   * stopping rule is how a two-line brief turns into six turns of interrogation,
   * and the stopping rule is the part somebody editing this file for length
   * would cut first.
   */
  // Whitespace-collapsed, because the prompt is prose hard-wrapped for the
  // person reading this file and a line break is not part of any claim. A test
  // that matched the wrapping would fail on a reflow that changed nothing.
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  const intake = (channel: 'native' | 'emitted') =>
    flat(systemPrompt(emptyRun(), null, channel));

  test('it says what not to do with a request, in the place a model reads first', () => {
    const prompt = intake('emitted');
    expect(prompt).toContain('Do not answer it with a start_run call');
    // Before the run block. A doctrine under two hundred lines of JSON is one a
    // model reads last, and this is the job rather than context for it.
    expect(prompt.indexOf('When somebody describes work')).toBeLessThan(
      prompt.indexOf('The run, as this window holds it'),
    );
  });

  test('the standard it is held to is this repository’s own measurement', () => {
    // Not a style preference, and the prompt says so: AGENTS.md's hardest-won
    // lesson comes from a census of runs that converged and runs that stalled.
    // A model told "be thorough" performs thoroughness; one told what separated
    // the two outcomes has something to aim at.
    expect(intake('native')).toContain('do not re-derive them');
  });

  test('it carries a stopping rule, which is the half that bounds it', () => {
    // Diligence that never ends is its own failure: it spends the person's
    // attention, which is the one budget with no ceiling in this product.
    const prompt = intake('native');
    expect(prompt).toContain('not have to guess');
    // And the explicit permission to stop after one exchange, so a clear brief
    // is not made to pay for an unclear one.
    expect(prompt).toContain('do not manufacture doubt');
  });

  test('it says where the pilot’s job ends and the planner’s begins', () => {
    // The structural bound rather than a number. The loop HAS a question round,
    // so the pilot is not resolving everything - only what has to be settled
    // before a plan exists to critique.
    expect(intake('native')).toContain('own question round');
  });

  test('it says the conversation does not travel with the run', () => {
    // The failure this prevents is silent and expensive: a decision settled in
    // the chat, left out of the brief, and made again by the planner - which is
    // indistinguishable from the pilot never having asked.
    expect(intake('native')).toContain('does not get to read this chat');
  });

  test('both backends get it, because both are the front door', () => {
    // `WHAT_YOU_CAN_READ` is the one section the two are told different things
    // in, for a real reason. This is not that: the job is the same whichever
    // wire a call comes back on.
    for (const channel of ['native', 'emitted'] as const) {
      expect(intake(channel)).toContain('When somebody describes work');
    }
  });

  test('a run that is already going still gets it, because the next one is proposed here too', () => {
    // Keyed on nothing: intake is not conditional on `launched` being null. The
    // conversation that proposes run N+1 happens while run N is going, and a
    // doctrine that switched itself off would be absent exactly then.
    const going = reduce(
      emptyRun(),
      { type: 'narration', level: 'info', message: 'x', id: 'phase_started', data: { phase: 'planning' } } as Frame,
      1_000,
    );
    expect(flat(systemPrompt(going, { task: 't', dir: '/r', planOnly: false }))).toContain(
      'When somebody describes work',
    );
  });
});
