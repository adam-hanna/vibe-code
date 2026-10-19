import type { Frame } from '../host';
import { ending, NEEDS_HUMAN } from './format';
import { hostExitWording } from './hosts';

/**
 * Local notifications (#346), fired off frames the cockpit already folds.
 *
 * Five events and no more: a gate held, a run needing input, finished, failed,
 * and a pilot turn finished. Each is read off a frame's **type and id**, as the
 * cockpit reads them - never off prose. A run's ending is the invoke's own
 * `result` or `error`, which is `invokeOutcome`'s answer: a pause, an unpause
 * and a cancel are answered with `result` frames too, and none of those is an
 * ending.
 *
 * **Each is offered once, by key.** A phone that reconnects is sent the live
 * runs' frames again, and an ask it has already announced must not ring twice.
 *
 * The cockpit offers; a sink decides. The desktop build installs none, so this
 * does nothing there. The phone's sink fires only while the app is hidden and
 * its notifications are on, and only while the app is alive - the phone
 * settings sentence says so.
 */
export interface Notice {
  key: string;
  title: string;
  body: string;
}

type Sink = (notice: Notice) => void;

let sink: Sink | null = null;
const offered = new Set<string>();

export function setNoticeSink(next: Sink | null): void {
  sink = next;
}

/** Offer a notice. Nothing without a sink, and nothing twice for one key. */
export function offerNotice(notice: Notice | null): void {
  if (notice === null || sink === null || offered.has(notice.key)) return;
  offered.add(notice.key);
  sink(notice);
}

/** For the tests: forget what was offered. */
export function forgetNotices(): void {
  offered.clear();
}

/**
 * What a run frame announces, given `invokeOutcome`'s reading of it. `label`
 * is how the window names the run.
 */
export function runNotice(
  from: string,
  frame: Frame,
  outcome: 'completed' | 'failed' | null,
  label: string,
): Notice | null {
  if (frame.type === 'ask') {
    return { key: `${from}:ask:${String(frame.id)}`, title: 'Waiting for you', body: `${label} is holding at a gate.` };
  }
  if (frame.type === 'result' && outcome === 'completed') {
    const key = `${from}:end`;
    if (frame.exit === 0) return { key, title: 'Run finished', body: label };
    if (frame.exit === NEEDS_HUMAN) return { key, title: 'Run needs input', body: `${label} stopped on a question.` };
    const said = ending(frame.exit);
    return {
      key,
      title: said === null ? `Run ended with exit ${String(frame.exit)}` : `Run ended: ${said.kicker}`,
      body: said === null ? label : `${label}: ${said.detail}`,
    };
  }
  if (frame.type === 'error' && outcome === 'failed') {
    return { key: `${from}:end`, title: 'Run failed', body: `${label}: ${frame.message}` };
  }
  return null;
}

/** A run host that exited while its run was live: the run is lost. */
export function exitNotice(from: string, code: number | null, label: string): Notice {
  return { key: `${from}:exit`, title: 'Run failed', body: `${label}: ${hostExitWording(code)}` };
}

/** A pilot turn's final event, on either road. A turn somebody stopped is not news. */
export function pilotNotice(
  road: 'api' | 'host',
  event: { kind: 'ended' | 'failed' | 'cancelled'; turn: number },
): Notice | null {
  if (event.kind === 'cancelled') return null;
  const key = `pilot:${road}:${String(event.turn)}:${event.kind}`;
  return event.kind === 'ended'
    ? { key, title: 'The pilot answered', body: 'Its reply is waiting in the pilot chat.' }
    : { key, title: "The pilot's turn failed", body: 'The pilot chat says why.' };
}

/**
 * The phone's sink: send a notice to the phone's Rust only while the app is
 * hidden and notifications are on. Pure over what it is given, for the tests.
 */
export function phoneSink(deps: { hidden(): boolean; notifyOn(): boolean; send(notice: Notice): void }): Sink {
  return (notice) => {
    if (deps.hidden() && deps.notifyOn()) deps.send(notice);
  };
}
