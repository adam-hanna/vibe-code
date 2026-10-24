import { describe, expect, test } from 'vitest';
import settings from './Settings.tsx?raw';
import {
  appendFocus,
  FOCUS_EXAMPLES,
  inheritedTimeout,
  keepQuorumLegal,
  minutesHint,
  quorumReading,
} from './seatform';

/**
 * What the review settings say about a blank field, and the layout they are
 * drawn in (#448): the owner's 1.8.0 screen clipped the verifiers' minutes and
 * remove off the right edge, drew the focus three characters wide, and left
 * `agent's` and `majority` as the only explanation of a blank.
 */

const DEFAULTS = { claude: { planTimeoutMs: 1_800_000 }, codex: { timeoutMs: 2_700_000 } };

describe('a blank minutes field names the number it takes', () => {
  test("a Claude seat takes claude.planTimeoutMs, a Codex seat codex.timeoutMs - vibe doctor's 1800000ms and 2700000ms", () => {
    expect(inheritedTimeout('claude', DEFAULTS)).toEqual({ key: 'claude.planTimeoutMs', minutes: 30, placeholder: "30 (claude's)" });
    expect(inheritedTimeout('codex', DEFAULTS)).toEqual({ key: 'codex.timeoutMs', minutes: 45, placeholder: "45 (codex's)" });
  });

  test('the figure is the configured one, not a default written here', () => {
    expect(inheritedTimeout('codex', { codex: { timeoutMs: 5_400_000 } }).placeholder).toBe("90 (codex's)");
    expect(inheritedTimeout('claude', { claude: { planTimeoutMs: 90_000 } }).minutes).toBe(1.5);
  });

  test('a figure that cannot be read is left out and the key still named, never guessed', () => {
    for (const bad of [{}, { claude: {} }, { claude: { planTimeoutMs: 'soon' } }, { claude: { planTimeoutMs: -1 } }]) {
      expect(inheritedTimeout('claude', bad)).toEqual({ key: 'claude.planTimeoutMs', minutes: null, placeholder: "claude's" });
    }
    expect(minutesHint(['claude', 'codex'], { codex: { timeoutMs: 2_700_000 } })).toBe(
      "Blank minutes takes the agent's limit for a read-only turn: claude.planTimeoutMs for claude, which this screen could not read; codex.timeoutMs for codex, 45 min.",
    );
  });

  test('no agent chosen yet has no number to give', () => {
    expect(inheritedTimeout('', DEFAULTS)).toEqual({ key: null, minutes: null, placeholder: "agent's" });
  });

  test('the column hint says both agents', () => {
    expect(minutesHint(['claude', 'codex'], DEFAULTS)).toBe(
      "Blank minutes takes the agent's limit for a read-only turn: claude.planTimeoutMs for claude, 30 min; codex.timeoutMs for codex, 45 min.",
    );
  });
});

describe('the quorum says what it comes to', () => {
  test("blank is quorumFor's majority, floor(n/2)+1, said as a count", () => {
    expect(quorumReading('', 3)).toEqual({ text: '2 of 3 (a majority)', problem: false });
    expect(quorumReading('', 4)).toEqual({ text: '3 of 4 (a majority)', problem: false });
    expect(quorumReading('  ', 1)).toEqual({ text: '1 of 1 (a majority)', problem: false });
    expect(quorumReading('', 0)).toEqual({ text: 'no verifiers, so nothing is voted on', problem: false });
  });

  test('a typed quorum is counted against the verifiers', () => {
    expect(quorumReading('3', 3)).toEqual({ text: '3 of 3', problem: false });
  });

  test('the two quorums the core refuses are said where they are typed', () => {
    expect(quorumReading('4', 3)).toEqual({
      text: '4 is more than the 3 verifiers there are; the core refuses it',
      problem: true,
    });
    expect(quorumReading('2', 1).text).toBe('2 is more than the 1 verifier there are; the core refuses it');
    expect(quorumReading('1', 0).problem).toBe(true);
    expect(quorumReading('0', 3).problem).toBe(true);
    expect(quorumReading('1.5', 3).problem).toBe(true);
    expect(quorumReading('two', 3).problem).toBe(true);
  });
});

describe('removing verifiers below a saved quorum', () => {
  test('resets the quorum to a majority in the same patch, and says it did', () => {
    const patch = { review: { verifiers: [{ provider: 'codex' }] } };
    expect(keepQuorumLegal(patch, 2)).toEqual({
      patch: { review: { verifiers: [{ provider: 'codex' }], quorum: null } },
      reset: true,
    });
    expect(keepQuorumLegal({ review: { verifiers: [] } }, 1).patch).toEqual({ review: { verifiers: [], quorum: null } });
  });

  test('leaves a quorum that still fits, a majority, and any other patch alone', () => {
    const two = { review: { verifiers: [{ provider: 'codex' }, { provider: 'claude' }] } };
    expect(keepQuorumLegal(two, 2)).toEqual({ patch: two, reset: false });
    expect(keepQuorumLegal({ review: { verifiers: [] } }, null).reset).toBe(false);
    const finders = { review: { finders: [] } };
    expect(keepQuorumLegal(finders, 3)).toEqual({ patch: finders, reset: false });
  });

  test('the verifiers list is the one that resets it', () => {
    expect(settings).toMatch(/kind="verifiers"[\s\S]*?keepQuorumLegal\(patch, saved\)/);
  });

  test("the critique's quorum is held to the same rule, under its own section (#405)", () => {
    const patch = { critique: { verifiers: [{ provider: 'codex' }] } };
    expect(keepQuorumLegal(patch, 2, 'critique')).toEqual({
      patch: { critique: { verifiers: [{ provider: 'codex' }], quorum: null } },
      reset: true,
    });
    // A critique save never touches the review's quorum, and the reverse.
    expect(keepQuorumLegal(patch, 2).reset).toBe(false);
    expect(settings).toMatch(/section="critique"[\s\S]*?keepQuorumLegal\(patch, saved, 'critique'\)/);
  });
});

describe("a finder's focus", () => {
  test('an example chip fills a blank focus, appends after a comma, and is added once', () => {
    expect(appendFocus('', 'security')).toBe('security');
    expect(appendFocus('security', 'performance')).toBe('security, performance');
    expect(appendFocus('look at the parser.', 'performance')).toBe('look at the parser. performance');
    expect(appendFocus('security, performance', 'Performance')).toBe('security, performance');
  });

  test("the issue's five examples, and the field stays free text", () => {
    expect(FOCUS_EXAMPLES).toEqual([
      'security',
      'concurrency and races',
      'error handling and fail-closed paths',
      'test coverage of the claim',
      'performance',
    ]);
    expect(settings).toMatch(/<textarea\s+id=\{`\$\{kind\}-\$\{row\.key\}-focus`\}/);
    expect(settings).toContain('<code>## Focus for this review</code>');
    expect(settings).not.toContain('— the shared prompt —');
  });
});

describe('the layout', () => {
  test('the pane is no longer held to 1024px, and the seat tables span it', () => {
    expect(settings).not.toMatch(/className=\{cn\(PANE, ['"]w-full max-w-5xl/);
    expect(settings).toContain("'w-full table-fixed [&_select]:w-full [&_select]:min-w-0 [&_select]:max-w-full'");
  });

  test('a seat label stays on one line, and a long model option cannot push the columns out', () => {
    expect(settings).toMatch(/<td className="whitespace-nowrap">\s*<code>\{label\}<\/code>/);
    // A fixed table sizes the columns by the header, so the model's select is
    // its column's width whatever its longest option says.
    expect(settings).toMatch(/<th className="w-40">minutes<\/th>\s*<th className="w-24" \/>/);
  });

  test('adding a seat is a bordered button', () => {
    expect(settings).toMatch(/<Button variant="secondary" size="sm" disabled=\{busy\} onClick=\{\(\) => setRows\(\[\.\.\.latest\.current, blankSeatRow\(\)\]\)\}>\s*<span aria-hidden="true">\+<\/span>\s*\{`add a \$\{noun\}`\}/);
  });
});
