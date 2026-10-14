/**
 * The phone build in an ordinary browser tab, for working on its layout with
 * the browser's device mode (`npm run dev:mobile:browser`).
 *
 * The phone's webview reaches the desktop through Tauri's `invoke`, and a tab
 * has no Tauri, so this installs Tauri's own IPC mock before the cockpit loads
 * and answers it the way `src-tauri/src/mock.rs` does: from the same recorded
 * session, `src-tauri/fixtures/desktop.json`. Everything above the transport -
 * `transport.mobile.ts`, `host.ts`, the cockpit - is the real phone build.
 *
 * **It is a second copy of `mock.rs`'s `answer`, and only a dev tool.** Never
 * loaded by `build:mobile` or by the desktop build; the vite mode that injects
 * it is `mobile-browser` alone. If the two disagree, `mock.rs` is the one its
 * tests pin, and this follows it.
 */
import { mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import recorded from './src-tauri/fixtures/desktop.json';

type Json = Record<string, unknown>;
const fixture = recorded as unknown as {
  ready: Json;
  answers: Record<string, Json>;
  artifact: Record<string, Json>;
};

/**
 * `?live`: a run the desktop started, as a phone joining it sees it (#347).
 *
 * The bridge replays a live run host's frames to a phone that connects, and the
 * phone's cockpit watches a host it did not launch. This plays the recorded
 * run's narration from planning to the plan critique on a desktop run host and
 * then holds the `plan-approved` gate, so the run screen and the gate sheet can
 * be worked on. `mock.rs` has no equivalent: it is for the layout in a browser.
 */
const LIVE = typeof location !== 'undefined' && new URLSearchParams(location.search).has('live');
const LIVE_HOST = 'run-1099511627777';
const LIVE_INVOKE = 1099511627777;
const LIVE_ASK = 900;
const steps = ((fixture.answers['replay']?.['steps'] ?? []) as { narration: Json }[]).map((s) => s.narration);

function liveFrame(frame: Json): void {
  void emit('host://frame', { host: LIVE_HOST, frame });
}

function playLive(): void {
  // Through the critique's census: planning, the plan, the critique and its counts.
  const through = steps.findIndex((n) => n['id'] === 'findings_reported');
  for (const n of steps.slice(0, through + 1)) liveFrame({ type: 'narration', ...n });
  liveFrame({
    type: 'ask',
    id: LIVE_ASK,
    context: { boundary: 'plan-approved', phase: 'planning', planRound: 0, questionRound: 0, reviewRound: 0, verifyRound: 0 },
  });
}

/** What the desktop's run host does with a line the phone sent it. */
function liveSend(line: string): void {
  const request = JSON.parse(line) as Json;
  if (request['type'] !== 'answer') return;
  const decision = (request['decision'] ?? {}) as Json;
  const stop = decision['kind'] === 'stop';
  liveFrame({
    type: 'narration',
    level: 'info',
    message: stop ? 'Stopped at plan-approved' : 'Continuing past plan-approved',
    id: stop ? 'gate_stopped' : 'gate_released',
    data: { boundary: 'plan-approved', origin: 'phone:browser' },
  });
  if (stop) liveFrame({ type: 'result', id: LIVE_INVOKE, exit: 2 });
}

/** `mock.rs`'s `answer`: the recorded frame under the request's id, or an error naming it. */
function answer(line: string): Json {
  let request: Json;
  try {
    request = JSON.parse(line) as Json;
  } catch (e) {
    return { type: 'error', id: null, message: `the mock desktop could not read the request: ${String(e)}` };
  }
  const id = request['id'] ?? null;
  const kind = typeof request['type'] === 'string' ? request['type'] : '';
  if (kind === 'fs' && request['op'] === 'list') return listed(id, String(request['dir'] ?? ''), String(request['path'] ?? '.'));
  const found =
    kind === 'artifact' && typeof request['name'] === 'string' ? fixture.artifact[request['name']] : fixture.answers[kind];
  if (found === undefined) {
    return { type: 'error', id, message: `the mock desktop has no recorded answer to a ${kind} request` };
  }
  const frame: Json = { ...found, id };
  // A save is answered about the key it saved, not the one recorded.
  if ('key' in request && 'key' in frame) frame['key'] = request['key'];
  return frame;
}

/**
 * A small disk for the folder chooser (#347), since one recorded listing cannot
 * be walked: the host's resolution and its refusal, in its own words, over a
 * home directory with two repositories in it. The recorded listing is `shop`.
 */
const HOME = '/home/you';
const DISK: Record<string, readonly string[]> = {
  [HOME]: ['.config', 'Documents', 'code'],
  [`${HOME}/.config`]: [],
  [`${HOME}/Documents`]: [],
  [`${HOME}/code`]: ['blog', 'notes', 'shop'],
  [`${HOME}/code/blog`]: ['.git', 'public', 'src'],
  [`${HOME}/code/blog/public`]: [],
  [`${HOME}/code/blog/src`]: [],
  [`${HOME}/code/notes`]: [],
  [`${HOME}/code/shop/.git`]: [],
  [`${HOME}/code/shop/.vibe`]: [],
};

function resolved(dir: string, asked: string): string {
  const parts: string[] = [];
  const start = asked.startsWith('/') ? asked : `${dir}/${asked}`;
  for (const part of start.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function listed(id: unknown, dir: string, asked: string): Json {
  const full = resolved(dir, asked);
  const recorded = fixture.answers['fs'];
  if (full === `${HOME}/code/shop` && recorded !== undefined) return { ...recorded, id };
  if (!(full === HOME || full.startsWith(`${HOME}/`))) {
    return {
      type: 'error',
      id,
      message: `${full} is outside the directories the pilot may read: ${HOME}. More can be added in Settings, under what the pilot may do.`,
    };
  }
  const names = DISK[full];
  if (names === undefined) return { type: 'error', id, message: `there is nothing at ${full}.` };
  return {
    type: 'fs',
    id,
    op: 'list',
    path: full,
    entries: [...names.map((name) => ({ name, kind: 'dir', bytes: null })), { name: 'README.md', kind: 'file', bytes: 7 }],
    truncated: false,
  };
}

/** `mock.rs`'s `status`. */
function status(): Json {
  return {
    running: true,
    pid: fixture.ready['pid'] ?? null,
    uptimeSecs: null,
    ready: fixture.ready,
    failure: null,
    uncontained: null,
    build: { version: 'browser', commit: null, at: null },
    runs: LIVE ? [{ handle: LIVE_HOST, pid: 4242, uptimeSecs: 60, uncontained: null, invokeId: LIVE_INVOKE }] : [],
  };
}

function desktop(command: string, args: Json): unknown {
  switch (command) {
    case 'host_status':
      return status();
    // The desktop's remote access, as the bridge answers it: on, with this
    // phone connected through the relay, so the diagnostics' link line can be seen.
    case 'remote_status':
      return {
        endpointId: 'browser-mock-desktop',
        identityUnreadable: null,
        phones: [{ id: 'browser-mock-phone', name: 'Browser phone', pairedAt: 0, lastSeen: null, connected: true }],
        phonesUnreadable: null,
        settings: { enabled: true, startAtLogin: false, keepAwake: false, relay: null },
        settingsUnreadable: null,
        startAtLogin: { enabled: false, error: null },
        awake: { held: false, error: null },
        endpoint: {
          state: 'up',
          relays: [{ url: 'https://relay.example/', connected: true, error: null }],
          links: [{ id: 'browser-mock-phone', path: 'relay' }],
        },
      };
    case 'host_send': {
      if (args['handle'] === LIVE_HOST) {
        liveSend(typeof args['line'] === 'string' ? args['line'] : '{}');
        return null;
      }
      const frame = answer(typeof args['line'] === 'string' ? args['line'] : '');
      // After the call returns, as the relay's frame arrives after `host_send` does.
      setTimeout(() => void emit('host://frame', { host: 'service', frame }), 0);
      return null;
    }
    default:
      throw new Error(`the mock desktop does not answer ${command}`);
  }
}

mockIPC(
  (cmd, payload) => {
    const args = (payload ?? {}) as Json;
    switch (cmd) {
      case 'remote_call':
        return desktop(String(args['command']), (args['args'] ?? {}) as Json);
      case 'phone_identity':
        return { endpointId: 'browser-mock-phone' };
      case 'phone_open_release_page':
        return null;
      default:
        throw new Error(`the browser mock has no ${cmd}`);
    }
  },
  { shouldMockEvents: true },
);


// Once the cockpit is on screen, and so listening, as the bridge's replay
// follows a phone's connect. A status read is no signal: the memory load makes
// one before the cockpit exists, and an event nobody listens for is dropped.
if (LIVE) {
  const wait = setInterval(() => {
    if (document.querySelector('[aria-label=panes]') === null) return;
    clearInterval(wait);
    setTimeout(playLive, 300);
  }, 100);
}
