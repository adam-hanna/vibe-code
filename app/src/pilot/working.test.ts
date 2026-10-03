import { expect, test } from 'vitest';
import pane from './PilotPane.tsx?raw';

// *"The 'Thinking...' needs to always be at the bottom so the user can see it"*
// (#223). It sat in the live card's header and scrolled away under a long reply.
// The stickiness is CSS, which vitest cannot read; this pins the placement.
test('the open-turn indicator is drawn once, after the live card, and not inside a card', () => {
  const card = pane.slice(pane.indexOf('function ReplyCard('), pane.indexOf('export interface PilotPaneProps'));
  expect(card).not.toMatch(/<ThinkingWave/);
  expect(pane.match(/<ThinkingWave/g)).toHaveLength(1);
  const live = pane.lastIndexOf('<ReplyCard');
  const working = pane.indexOf('<TurnWorking');
  expect(working).toBeGreaterThan(live);
  expect(pane.slice(working, pane.indexOf('</div>', working))).not.toMatch(/<ReplyCard/);
});
