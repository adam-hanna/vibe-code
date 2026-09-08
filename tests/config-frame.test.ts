import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decode } from '@src/protocol.js';
import { createSession } from '@src/serve.js';
import { DEFAULTS, loadConfig, readRawConfig, writeConfigPatch } from '@src/config.js';
import { GATEABLE } from '@src/gates.js';
import type { Outbound } from '@src/protocol.js';

/**
 * Configuration, over the wire and onto disk (#223, `1h`).
 *
 * #140 made the gate matrix configuration, and `DEFAULT_GATES` says in its own
 * comment that every row being `step` *"is very probably not the default anyone
 * wants to keep - but changing it is a decision for whoever has the settings
 * screen in front of them"*. This is the machinery under that screen.
 *
 * The claim that matters most is **refuse, never repair**, and it matters more
 * here than anywhere else this rule is applied: what is being written is a file
 * the user's repository keeps and their next `vibe run` reads. A config that
 * half-applied would be worse than one that did not apply at all, because the
 * run after it would be configured by something nobody chose.
 */

const line = (v: unknown): string => JSON.stringify(v);
const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

function repo(contents?: object): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cfg-'));
  if (contents !== undefined) {
    writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify(contents, null, 2), 'utf8');
  }
  return dir;
}

const read = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(dir, 'vibe.config.json'), 'utf8')) as Record<string, unknown>;

test('a config frame decodes, and a patch that is not an object is refused', () => {
  assert.equal(decode(line({ type: 'config', id: 1, dir: 'C:/repo' })).ok, true);
  assert.equal(decode(line({ type: 'config', id: 1, dir: '' })).ok, false);

  // A `patch: null` treated as "no patch" would answer a save with the
  // unchanged config and look exactly like it had worked.
  for (const bad of [null, 7, 'gates']) {
    const got = decode(line({ type: 'config', id: 1, dir: 'C:/repo', patch: bad }));
    assert.equal(got.ok, false, `patch ${String(bad)} was accepted`);
  }
});

test('the raw file and the effective config are different answers', () => {
  // The reason both travel. A form given only the effective config would bake
  // every current default into the file the moment it saved, so the next
  // release's improved default would never reach this repository.
  const dir = repo({ gates: { 'plan-round': 'auto' } });
  assert.deepEqual(readRawConfig(dir), { gates: { 'plan-round': 'auto' } });

  const effective = loadConfig(dir);
  assert.equal(effective.gates['plan-round'], 'auto');
  // Every other row is a default and the file claims none of them.
  assert.equal(effective.gates['review-round'], DEFAULTS.gates['review-round']);
  assert.equal(Object.keys(effective.gates).length, GATEABLE.length);
});

test('a repository with no file claims nothing, and an unreadable one throws', () => {
  assert.deepEqual(readRawConfig(repo()), {});

  const bad = repo();
  writeFileSync(path.join(bad, 'vibe.config.json'), '{ not json', 'utf8');
  // Not `{}`. A form told an unreadable file was empty would offer to overwrite
  // it, which is the one thing it must never do without being asked.
  assert.throws(() => readRawConfig(bad), /Invalid vibe\.config\.json/);
});

test('a patch merges into its section and leaves the siblings alone', () => {
  // One level deep, per section, matching `mergeSection`. A shallow merge would
  // drop every sibling of the key being changed; a deep one would make it
  // impossible to remove a key.
  const dir = repo({ gates: { 'plan-round': 'auto' }, loop: { maxPlanRounds: 9 } });
  writeConfigPatch(dir, { gates: { 'review-round': 'stop' } });

  assert.deepEqual(read(dir), {
    gates: { 'plan-round': 'auto', 'review-round': 'stop' },
    loop: { maxPlanRounds: 9 },
  });
});

test('a patch that does not validate writes nothing, and says which field', () => {
  // Refuse, never repair. The message is `validate`'s own, which is what lets a
  // settings form say WHICH value it refused rather than that something was
  // wrong.
  const dir = repo({ gates: { 'plan-round': 'auto' } });
  assert.throws(() => writeConfigPatch(dir, { gates: { 'plan-round': 'sometimes' } }));

  // The file is exactly as it was. Nothing half-applied.
  assert.deepEqual(read(dir), { gates: { 'plan-round': 'auto' } });
});

test('the two boundaries that cannot hold are refused by name', () => {
  // `GateableBoundary` makes this unrepresentable in TypeScript; a
  // `vibe.config.json` is not TypeScript, and it is the one with a person behind
  // it. `mergeSection` would have dropped the key in silence, and somebody who
  // believes they armed a gate finds out by watching a run go past it.
  const dir = repo();
  assert.throws(() => writeConfigPatch(dir, { gates: { 'final-fix': 'stop' } }));
  assert.throws(() => writeConfigPatch(dir, { gates: { complete: 'stop' } }));
});

test('a write answers with the config that resulted, not with the patch', () => {
  // What keeps "the form and the raw file are the same file the CLI reads" true
  // rather than hoped for: the screen never assumes its own save took effect.
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.resolve(0),
    writeConfig: () => ({ path: 'C:/repo/vibe.config.json' }),
    config: () => ({ ...DEFAULTS, configPath: 'C:/repo/vibe.config.json' }),
  });
  session.receive(line({ type: 'config', id: 1, dir: 'C:/repo', patch: { gates: { 'plan-round': 'auto' } } }));

  const reply = sent[0];
  assert.equal(reply?.type, 'config');
  if (reply?.type !== 'config') throw new Error('unreachable');
  assert.equal(reply.path, 'C:/repo/vibe.config.json');
  // The vocabulary comes from `src/gates.ts`, so a matrix cannot offer a
  // boundary the loop does not have or a mode it does not honour.
  assert.deepEqual(reply.gateable, GATEABLE);
  assert.ok(reply.modes.includes('stop'));
  // And the two with no row arrive WITH their reasons rather than missing.
  assert.ok(Object.keys(reply.ungateable).includes('final-fix'));
  assert.ok(String(reply.ungateable['complete']).length > 0);
});

test('a read is answered during a run, and a write is refused with a reason', async () => {
  // A run reads `vibe.config.json` once, at the top of `main`, so saving now
  // cannot affect the run in flight - but it would leave the screen and the
  // running loop describing different configurations with nothing saying so.
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => new Promise<number>(() => undefined),
    config: () => ({ ...DEFAULTS, configPath: null }),
    writeConfig: () => {
      throw new Error('a write should not have been attempted');
    },
  });

  session.receive(line({ type: 'invoke', id: 1, argv: ['run', 'x'] }));
  await settle();

  session.receive(line({ type: 'config', id: 2, dir: 'C:/repo' }));
  assert.equal(sent.some((m) => m.type === 'config' && m.id === 2), true, 'a read was refused');

  session.receive(line({ type: 'config', id: 3, dir: 'C:/repo', patch: { gates: {} } }));
  const refusal = sent.find((m) => m.type === 'error' && m.id === 3);
  assert.equal(refusal?.type, 'error');
  assert.match(refusal?.type === 'error' ? refusal.message : '', /still running/);
});

test('a refusal reaches the window as an error, carrying the validator’s sentence', () => {
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.resolve(0),
    config: () => ({ ...DEFAULTS, configPath: null }),
    writeConfig: () => {
      throw new Error('gates["plan-round"] must be one of auto, step, stop');
    },
  });
  session.receive(line({ type: 'config', id: 1, dir: 'C:/repo', patch: { gates: { 'plan-round': 'x' } } }));

  assert.deepEqual(sent, [
    { type: 'error', id: 1, message: 'gates["plan-round"] must be one of auto, step, stop' },
  ]);
});
