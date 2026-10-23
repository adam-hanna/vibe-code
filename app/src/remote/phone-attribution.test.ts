import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { configWriteFor } from '../changed';
import { LoopColumn } from '../cockpit/LoopColumn';
import { emptyRun, reduce, startedLine } from '../cockpit/model';
import type { Run } from '../cockpit/model';
import type { Frame } from '../host';
import settings from '../cockpit/Settings.tsx?raw';
import { PHONE_ORIGIN } from './origin';

/**
 * A run a phone started, and a setting a phone saved, say so on the desktop
 * (#365) - the half of #344's attribution that #344 left for a core change.
 *
 * `run_started` now carries the invoke's `origin` when it had one
 * (`tests/run-started-origin.test.ts` pins that end, and `contract.test.ts` the
 * three sites); this file takes the frame from there to the drawn line. Only a
 * phone is named: the window's own invokes carry no origin, and the pilot, the
 * gate matrix and a terminal are not a person on another device.
 */

const T = 1_000_000;
const PHONE = `${PHONE_ORIGIN}Adam's iPhone`;

const started = (extra: Record<string, unknown> = {}): Frame => ({
  type: 'narration',
  level: 'info',
  message: 'Run r',
  id: 'run_started',
  data: { runId: 'r', dir: '/repo/.vibe/runs/r', repo: '/repo', task: 'a task', resumed: false, ...extra },
});

const fold = (frames: readonly Frame[]): Run => frames.reduce((run, f, i) => reduce(run, f, T + i), emptyRun());

/** Both places the column draws a run's identity: the cockpit's rail, and the full column's header. */
const drawn = (run: Run): string[] =>
  [true, false].map((compact) => renderToStaticMarkup(createElement(LoopColumn, { run, now: T + 10, compact })));

describe('a run started from a phone', () => {
  test('the origin is folded onto the identity, by name', () => {
    const run = fold([started({ origin: PHONE })]);
    expect(run.identity?.startedFrom).toBe("Adam's iPhone");
    expect(startedLine(run.identity)).toBe("Started from Adam's iPhone.");
  });

  test('it is drawn where the run is named, in the rail and in the header', () => {
    for (const html of drawn(fold([started({ origin: PHONE })]))) {
      expect(html).toContain('Started from Adam&#x27;s iPhone.');
    }
  });

  test('a resume from a phone says resumed, not started', () => {
    const run = fold([started({ origin: PHONE, resumed: true })]);
    expect(startedLine(run.identity)).toBe("Resumed from Adam's iPhone.");
  });

  test('a later start from this window drops the phone: that session was not started there', () => {
    const run = fold([started({ origin: PHONE }), started({ resumed: true })]);
    expect(run.identity?.startedFrom).toBeUndefined();
    expect(startedLine(run.identity)).toBeNull();
  });
});

describe('a run started anywhere else draws nothing new', () => {
  // No origin is the window's own invoke and the terminal's (neither sends
  // one); `pilot`, `gates` and `desktop` are labels that are not a phone; an
  // empty phone name is unreadable, and unreadable is absent.
  const others: [string, Record<string, unknown>][] = [
    ['the window or a terminal', {}],
    ['the pilot', { origin: 'pilot' }],
    ['the gate matrix', { origin: 'gates' }],
    ['a desktop label', { origin: 'desktop' }],
    ['a phone with no name', { origin: PHONE_ORIGIN }],
    ['a non-string', { origin: 7 }],
  ];
  for (const [who, extra] of others) {
    test(who, () => {
      const run = fold([started(extra)]);
      expect(run.identity).not.toBeNull();
      expect(Object.hasOwn(run.identity ?? {}, 'startedFrom')).toBe(false);
      expect(startedLine(run.identity)).toBeNull();
      for (const html of drawn(run)) {
        expect(html).not.toContain('Started from');
        expect(html).not.toContain('Resumed from');
      }
    });
  }

  test('and a run with no identity yet draws no line', () => {
    expect(startedLine(emptyRun().identity)).toBeNull();
  });
});

describe('a setting saved from a phone', () => {
  const changed = (key: string, origin?: string) =>
    origin === undefined ? { what: 'config', key } : { what: 'config', key, origin };

  test('a phone save of the file on screen names the phone', () => {
    expect(configWriteFor(changed('/repo', PHONE), 'project', '/repo')).toEqual({ phone: "Adam's iPhone" });
    expect(configWriteFor(changed('global', PHONE), 'global', '/repo')).toEqual({ phone: "Adam's iPhone" });
  });

  test('a save with no phone origin is still a write to this file, and names nobody', () => {
    // It has to clear an earlier phone's note: the file is no longer the one
    // that phone wrote.
    expect(configWriteFor(changed('/repo'), 'project', '/repo')).toEqual({ phone: null });
    expect(configWriteFor(changed('/repo', 'pilot'), 'project', '/repo')).toEqual({ phone: null });
  });

  test('a write to another file, or not to config, is not about this screen', () => {
    expect(configWriteFor(changed('/other', PHONE), 'project', '/repo')).toBeNull();
    expect(configWriteFor(changed('global', PHONE), 'project', '/repo')).toBeNull();
    expect(configWriteFor({ what: 'memory', key: 'global', origin: PHONE }, 'global', '/repo')).toBeNull();
  });

  test('the settings screen draws it, takes it from configWriteFor, and lets the next save supersede it', () => {
    // Source-read, as the other settings tests are: there is no jsdom, and the
    // screen reaches the host on mount.
    expect(settings).toContain('configWriteFor(c, scope, dir)');
    expect(settings).toContain('setSavedFrom(wrote.phone)');
    expect(settings).toMatch(/saved from \{savedFrom\}, and reread from the file/);
    // This window's own save clears it, and so does pointing the screen elsewhere.
    const write = /const write = useCallback\([\s\S]*?\n {2}\);/.exec(settings)?.[0] ?? '';
    expect(write).toContain('setSavedFrom(null)');
    expect(settings).toContain('useEffect(() => setSavedFrom(null), [scope, dir])');
    // No timer: the note is for somebody who was away from the desktop.
    const near = settings.slice(settings.indexOf('const [savedFrom'), settings.indexOf('const [savedFrom') + 1200);
    expect(near).not.toMatch(/setTimeout/);
  });
});

test("`phone:` is spelled in one place in the app's source", () => {
  // #365's spelling rule, applied to the code it added: the reducer and the
  // settings screen reach the prefix through `phoneOf`, never by writing it.
  const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  // Comments out, since prose may name the prefix; `phone://` is the Tauri
  // event namespace, a different word that happens to start the same way.
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const spelled = Object.entries(sources)
    .filter(([, text]) => /['"`]phone:(?!\/\/)/.test(code(text)))
    .map(([file]) => file);
  expect(spelled).toEqual(['./origin.ts']);
});
