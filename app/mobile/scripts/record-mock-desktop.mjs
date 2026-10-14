// Record what a real desktop host says, for the phone's mock desktop (#345).
//
//   npm run build                                      # at the repo root, first
//   node app/mobile/scripts/record-mock-desktop.mjs    # writes src-tauri/fixtures/desktop.json
//
// The mock behind `--features mock-desktop` answers the cockpit's reads from
// this file, so the cockpit can be launched on a simulator and seen drawing a
// run with no desktop anywhere. Every answer in it was said by the real host:
// nothing here writes a frame by hand, so the mock cannot drift from the
// protocol without a re-record showing it.
//
// The run it describes is made with the core's own loop harness and fake
// agents - no agent is called and nothing leaves this machine. The host is
// given an empty app-data directory and an empty global config, so nothing of
// the developer's own setup lands in a committed file.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const out = path.resolve(here, '../src-tauri/fixtures/desktop.json');

const { orchestrate } = await import(path.join(root, 'dist/src/orchestrator.js'));
const harness = await import(path.join(root, 'dist/tests/helpers/loop-harness.js'));

const scratch = mkdtempSync(path.join(tmpdir(), 'vibe-mock-desktop-'));
process.env.TMPDIR = scratch;
try {
  // One finished run: plan, critique, implement, verify, review.
  const state = harness.freshRun({
    prefix: 'vibe-mock-',
    task: 'Add a dark mode switch to the settings screen',
    planOnly: false,
    git: true,
    commit: true,
  });
  await orchestrate(
    state,
    harness.config({}, { ...harness.committing(), ...harness.verifying(state) }),
    false,
    harness.agents(
      {
        claude: (label) =>
          label === 'plan' || label.startsWith('revise-')
            ? harness.planFixture()
            : harness.work(state, `${label}.txt`),
        codex: () => harness.report([]),
      },
      [],
    ),
  );
  const repo = state.targetDir;

  const appData = path.join(scratch, 'app-data');
  mkdirSync(appData);
  const globalConfig = path.join(scratch, 'global.json');
  writeFileSync(globalConfig, '{}\n');

  const host = spawn(process.execPath, [path.join(root, 'dist/src/hostmain.js')], {
    cwd: repo,
    env: { ...process.env, VIBE_APP_DATA: appData, VIBE_GLOBAL_CONFIG: globalConfig },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = readline.createInterface({ input: host.stdout });
  const waiting = new Map();
  let ready = null;
  let readyNow;
  const readyAt = new Promise((r) => (readyNow = r));
  lines.on('line', (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame.type === 'ready') {
      ready = frame;
      readyNow();
    } else if (typeof frame.id === 'number' && waiting.has(frame.id)) {
      waiting.get(frame.id)(frame);
      waiting.delete(frame.id);
    }
  });
  let next = 1;
  const ask = (request) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error(`no answer to ${request.type}`)), 30_000);
      waiting.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      host.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  await readyAt;

  // Where the window was pointed: the run, open on its plans, with the
  // sidebar shut because a phone has no room for it beside the run.
  const where = {
    tab: 'plans',
    viewing: { dir: repo, runId: state.id, task: state.task },
    draftId: null,
    bottom: 'commands',
    panels: { sidebar: false, loop: true, bottom: false, sizes: {} },
  };
  const saved = await ask({ type: 'memory_save', key: 'vibe.projects', value: JSON.stringify([repo]) });
  await ask({ type: 'memory_save', key: 'vibe.where', value: JSON.stringify(where) });

  const answers = {
    memory_save: saved,
    chat_save: await ask({ type: 'chat_save', key: 'vibe.chat.mock', value: null }),
    memory: await ask({ type: 'memory' }),
    chats: await ask({ type: 'chats' }),
    commands_past: await ask({ type: 'commands_past' }),
    prompts: await ask({ type: 'prompts' }),
    config: await ask({ type: 'config', dir: repo }),
    archive: await ask({ type: 'archive', dir: repo }),
    stats: await ask({ type: 'stats', dir: repo }),
    replay: await ask({ type: 'replay', dir: repo, runId: state.id }),
    artifacts: await ask({ type: 'artifacts', dir: repo, runId: state.id }),
    fs: await ask({ type: 'fs', op: 'list', dir: repo, path: '.' }),
  };
  const artifact = {};
  // Every listed artifact, and the transcript, which the Output tab reads by
  // name and the listing does not carry.
  const names = [...(answers.artifacts.entries ?? []).map((e) => e.name), 'transcript.log'];
  for (const name of new Set(names)) {
    artifact[name] = await ask({ type: 'artifact', dir: repo, runId: state.id, name });
  }

  host.stdin.end();
  await new Promise((r) => host.once('exit', r));

  // Paths are this machine's, so they are rewritten before anything is
  // written: the scratch repository becomes one stable, made-up project, and
  // the home directory (which the config frame names, through where it found
  // each CLI) becomes nobody's. The mock answers with them as a desktop would
  // with its own, and the phone sends them back unread.
  const text = JSON.stringify({ recordedFrom: 'dist/src/hostmain.js', ready, answers, artifact }, null, 2)
    .split(repo).join('/home/you/code/shop')
    .split(scratch).join('/home/you/code')
    .split(homedir()).join('/home/you');
  writeFileSync(out, `${text}\n`);
  console.log(`wrote ${path.relative(process.cwd(), out)}: ${Object.keys(answers).length} answers, ${Object.keys(artifact).length} artifacts`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
