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
    runs: [],
  };
}

function desktop(command: string, args: Json): unknown {
  switch (command) {
    case 'host_status':
      return status();
    case 'host_send': {
      const frame = answer(typeof args['line'] === 'string' ? args['line'] : '');
      // After the call returns, as the relay's frame arrives after `host_send` does.
      setTimeout(() => void emit('host://frame', { host: 'service', frame }), 0);
      return null;
    }
    default:
      throw new Error(`the mock desktop does not answer ${command}`);
  }
}

/** The recorded desktop, as `mock.rs`'s `phone_desktops` lists it (#346). */
const DESKTOP_ID = 'browser-mock-desktop';
const ID_RANGE = 2 ** 40;

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
      // The phone's own side (#346), as `mock.rs` answers it: unlocked, one
      // current desktop that opens at once as generation 1.
      case 'phone_settings':
        return { lock: true, notify: true, name: 'Phone', deviceLock: 'unknown', locked: false, problem: null };
      case 'phone_desktops':
        return {
          desktops: [
            {
              id: DESKTOP_ID,
              relay: null,
              desktopName: 'Recorded desktop',
              name: null,
              pairedAt: 0,
              lastSeen: null,
              reach: { state: 'open' },
            },
          ],
          problem: null,
          current: DESKTOP_ID,
          link: { id: DESKTOP_ID, phase: 'up', reason: null, path: 'direct', connectMs: null },
        };
      case 'phone_open':
        return args['id'] === null ? { generation: null } : { generation: 1 };
      case 'phone_session':
        return { generation: 1, idBase: ID_RANGE };
      case 'phone_release':
      case 'phone_probe':
      case 'phone_network_change':
      case 'phone_notify':
        return null;
      case 'phone_confirm':
        return true;
      default:
        throw new Error(`the browser mock has no ${cmd}`);
    }
  },
  { shouldMockEvents: true },
);
