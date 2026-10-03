import { describe, expect, test } from 'vitest';
import panel from './SidePanel.tsx?raw';
import { clampWidth, readWidth, SIDE_DEFAULT } from './SidePanel';

/**
 * The two side columns can be made wider or narrower while open (#223):
 * *"The two side bars (left and right) should be width adjustable when open."*
 * The arithmetic is pure and driven here; the handle is read as source, because
 * the app has no jsdom to drag in.
 */
describe('how wide a side column may be', () => {
  test('a width is kept between a floor and half the window', () => {
    expect(clampWidth(400, 1600)).toBe(400);
    expect(clampWidth(100, 1600)).toBe(240);
    expect(clampWidth(2000, 3000)).toBe(720);
    // Half of a narrow window, so the main pane always keeps the other half.
    expect(clampWidth(700, 1000)).toBe(500);
    // A window too narrow for half to clear the floor still gets the floor.
    expect(clampWidth(300, 300)).toBe(240);
    expect(clampWidth(Number.NaN, 1600)).toBe(SIDE_DEFAULT);
  });

  test('a stored width is read back, and anything else is the design’s', () => {
    expect(readWidth('420')).toBe(420);
    expect(readWidth(null)).toBe(SIDE_DEFAULT);
    expect(readWidth('wide')).toBe(SIDE_DEFAULT);
    expect(readWidth('-5')).toBe(SIDE_DEFAULT);
  });
});

describe('the handle', () => {
  test('is on an open panel only, can be dragged, keyed and reset, and is remembered per edge', () => {
    const shut = panel.slice(panel.indexOf('if (!open) {'), panel.indexOf('  return (\n    <aside className={`v-side v-side--${side}`}'));
    expect(shut).not.toContain('v-side__resize');
    expect(panel).toContain('role="separator"');
    expect(panel).toContain('onPointerMove={onPointerMove}');
    expect(panel).toContain('onKeyDown={onKeyDown}');
    expect(panel).toContain('onDoubleClick={() => setWidth(SIDE_DEFAULT)}');
    expect(panel).toContain('`vibe.side.${side}.width`');
    expect(panel).toContain("style={{ width }}");
  });
});
