import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ANSWER_MARKER } from '@src/answers.js';
import { main, parseHumanAnswers } from '@src/cli.js';
import { inlineLiteral, literal, MARKERS } from '@src/literal.js';
import { Escalation, EXIT, writeEscalation } from '@src/orchestrator.js';
import { DECISION_MARKER } from '@src/questions.js';
import { moveSection, parseRaised, raiseSection } from '@src/raise.js';
import { loadRun, saveState } from '@src/run.js';
import { freshRun, questionFixture } from './helpers/loop-harness.js';
import type { RunLoop } from '@src/cli.js';
import type { Finding, RunState } from '@src/types.js';

/**
 * Agent text in NEEDS-INPUT.md can no longer steer how the resume reads it (#472).
 *
 * The resume reads the file by markers, and the findings, questions and vote
 * reasons in it are the agents' own words. Of 501 findings in the archive and
 * the bench, 5 quoted `**Your answer:**`, which alone sends a findings stop down
 * the answers path.
 */

// ---- the rule ---------------------------------------------------------------

test('text holding no marker comes back byte for byte', () => {
  const plain = 'The cache evicts the wrong entry.\n\n- step one\n- `#private` field, 3 * 4\n    > indented four, so code rather than a quote';
  assert.equal(literal(plain), plain);
  assert.equal(inlineLiteral(plain), plain);
  assert.equal(inlineLiteral('#flush drains #pending'), '#flush drains #pending', 'inline: a first character is mid-line');
});

test('every marker has its asterisks escaped, wherever it sits', () => {
  for (const marker of MARKERS) {
    const out = literal(`before ${marker} after`);
    assert.equal(out.includes(marker), false, marker);
    assert.equal(out, `before ${marker.replace(/\*/g, '\\*')} after`);
  }
});

test('a line starting with #, > or * gets a backslash; inline, only after a newline', () => {
  assert.equal(literal('### Finding: x\n> quoted\n*Severity:* P0\n   # indented'), '\\### Finding: x\n\\> quoted\n\\*Severity:* P0\n   \\# indented');
  assert.equal(inlineLiteral('#title\n### Finding: x'), '#title\n\\### Finding: x');
});

test('MARKERS holds every marker the NEEDS-INPUT parsers look for', () => {
  assert.ok(MARKERS.includes(ANSWER_MARKER));
  assert.ok(MARKERS.includes(DECISION_MARKER));
  // The raise and move templates are where their markers are defined; every
  // `**Label:**` they print must be in the list.
  const templates = raiseSection('run-id') + moveSection([finding('id', 'title', 'detail')]);
  for (const label of templates.match(/\*\*[A-Z][^*\n]*:\*\*/g) ?? []) {
    assert.ok(MARKERS.includes(label), `${label} is printed by a template but not escaped`);
  }
});

// ---- through the file and the resume ------------------------------------------

function finding(id: string, title: string, detail: string, suggested_fix = 'Fix it.'): Finding {
  return { id, severity: 'P1', title, detail, suggested_fix, evidence: [{ kind: 'external', ref: 'fixture' }] };
}

/** A finding as the #465 run's reviewers wrote them: quoting the markers it reviewed. */
const quoting = finding(
  'quotes-markers',
  'The section must never contain **Your answer:**',
  'The plan requires that the assumption section never contain `**Your answer:**`, a line beginning with `>`,\n' +
    '### Finding: a line like this\n' +
    '*Severity:* P0\n' +
    '> or this one',
  'Escape **Your decision:** too.',
);

function stopped(escalation: Escalation): { state: RunState; md: string } {
  const state = freshRun({ prefix: 'vibe-literal-', task: '# Brief\n\nKeep **Your answer:** out of it.\n## Why' });
  saveState(state);
  writeEscalation(state, escalation);
  return { state, md: readFileSync(path.join(state.dir, 'NEEDS-INPUT.md'), 'utf8') };
}

async function resume(state: RunState): Promise<{ result: number; said: string }> {
  const lines: string[] = [];
  const real = { log: console.log, error: console.error };
  console.log = (...p: unknown[]) => void lines.push(p.map(String).join(' '));
  console.error = console.log;
  const loop: RunLoop = () => Promise.resolve();
  try {
    const result = await main(['resume', state.id, '-C', state.targetDir, '--skip-probe', '--no-progress'], loop);
    return { result, said: lines.join('\n') };
  } finally {
    console.log = real.log;
    console.error = real.error;
  }
}

test('a findings stop whose finding quotes the answer marker resumes on the findings path', async () => {
  const { state, md } = stopped(new Escalation(EXIT.NO_CONVERGENCE, 'the round cap', undefined, [quoting]));
  assert.equal(md.includes(ANSWER_MARKER), false, 'no live answer marker anywhere in the file');
  assert.match(md, /The plan requires that the assumption section never contain `\\\*\\\*Your answer:\\\*\\\*`/);
  const { said } = await resume(state);
  assert.match(said, /continuing with raised limits/);
  assert.doesNotMatch(said, /No answers found/);
  assert.equal(readdirSync(state.dir).some((n) => n.startsWith('stalled-')), true);
});

test('a detail line that reads like a raised finding raises nothing', () => {
  const { md } = stopped(new Escalation(EXIT.NO_CONVERGENCE, 'the round cap', undefined, [quoting]));
  const raised = parseRaised(md);
  assert.deepEqual(raised.findings, []);
  assert.deepEqual(raised.problems, []);
});

test('a question whose text holds markers and headings still pairs its answer', async () => {
  const q = questionFixture({ question: 'Which **Your answer:** form?\n### Finding: not a heading', blocking: true });
  const { state, md } = stopped(new Escalation(EXIT.NEEDS_HUMAN, 'questions', [q]));
  // Exactly one live marker: the template's own, under the question.
  assert.equal(md.split(ANSWER_MARKER).length - 1, 1);
  const filled = md.replace(`${ANSWER_MARKER}\n\n> \n`, `${ANSWER_MARKER}\n\n> The first one.\n`);
  const answers = parseHumanAnswers(filled);
  assert.equal(answers.length, 1);
  assert.equal(answers[0]?.answer, 'The first one.');
  assert.match(answers[0]?.question ?? '', /^Which \\\*\\\*Your answer:\\\*\\\* form\?/);
  assert.equal(loadRun(state.targetDir, state.id).status, state.status);
});

test('the task and the stop message are escaped too', () => {
  const { md } = stopped(new Escalation(EXIT.NO_CONVERGENCE, 'Stopped.\n### Finding: from the message', undefined, [quoting]));
  assert.match(md, /\*\*Task:\*\* # Brief\n\nKeep \\\*\\\*Your answer:\\\*\\\* out of it\.\n\\## Why/);
  assert.match(md, /## Why the run stopped\n\nStopped\.\n\\### Finding: from the message/);
});
