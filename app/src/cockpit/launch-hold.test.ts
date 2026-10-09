import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import { chatKey, chatMove } from '../pilot/saved';

// *"Sometimes the run that starts, the pilot chat, progress etc gets confused
// with a previous run. It's like some key isn't unique somewhere"* (#223).
describe('a launch keeps the chat that proposed it until the run has an id', () => {
  const opened = chatKey('/repo', 'run-a');
  const bucket = chatKey('/repo', null);
  const started = chatKey('/repo', 'run-b');

  test('without the hold, the gap restored the project bucket and the run adopted THAT', () => {
    // The defect, as the two moves it was made of.
    expect(chatMove({ from: opened, to: bucket, intoRun: false, opened: false, stored: true, holding: true })).toBe('restore');
    expect(chatMove({ from: bucket, to: started, intoRun: true, opened: false, stored: false, holding: true })).toBe('adopt');
  });

  test('with it, the gap is a stay, and the run adopts the chat that proposed it', () => {
    expect(chatMove({ from: opened, to: opened, intoRun: true, opened: false, stored: true, holding: true })).toBe('stay');
    expect(chatMove({ from: opened, to: started, intoRun: true, opened: false, stored: false, holding: true })).toBe('adopt');
  });

  test('the cockpit holds on a pilot launch, and lets go once the run is known', () => {
    // Case 2 (#246): the hold is no longer a state set on launch and cleared
    // on an id. Each run remembers the conversation that proposed it, and the
    // pane is held on it until that run's adoption has settled - `heldChat`,
    // tested in hosts.test.ts, which also covers a run opened from the sidebar
    // before it was adopted.
    expect(cockpit).toContain("held: draft === null && seed === null && argv[0] !== 'resume' ? pilotAt.current : null,");
    expect(cockpit).toMatch(/const holdChat = heldChat\(lives, shownLive, viewing, drafting\);/);
  });
});
