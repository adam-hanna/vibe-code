import { describe, expect, test } from 'vitest';
import { readPick, writePick, DEFAULT_PICK } from './pilot/pick';
import { reduceCommands } from './cockpit/commands';
import memorySrc from './memory.ts?raw';
import chatstoreSrc from './pilot/chatstore.ts?raw';
import paneSrc from './pilot/PilotPane.tsx?raw';
import sidebarSrc from './cockpit/Sidebar.tsx?raw';
import cockpitSrc from './cockpit/Cockpit.tsx?raw';
import settingsSrc from './cockpit/Settings.tsx?raw';
import questionsSrc from './cockpit/QuestionsPane.tsx?raw';
import workstreamSrc from './cockpit/NewWorkstream.tsx?raw';
import hostSrc from './host.ts?raw';
import type { CommandStarted } from './host';

/**
 * Everything one client changes is on every other client's screen at once,
 * both ways (#371). Asked for as *"New messages, new runs, etc, should show up
 * immediately - bi-directionally too"* and then *"EVERYTHING needs to be in
 * sync"*. #354 made each window's caches follow another client's writes, and
 * nothing on screen read them again: a project added on the phone, a message
 * sent from it, a model picked on it, appeared on the desktop only after
 * somebody navigated away and back. The app has no jsdom, so the pure parts
 * are driven and the wiring is read as source.
 */
describe('a store says which keys another client moved', () => {
  test('memory and the chats count a key only when its value changed', () => {
    for (const src of [memorySrc, chatstoreSrc]) {
      expect(src).toMatch(/const was = cache\.get\(key\) \?\? null;/);
      expect(src).toMatch(/if \(\(cache\.get\(key\) \?\? null\) !== was\) moved\.push\(key\);/);
    }
    expect(memorySrc).toMatch(/export function useFollowedMemory/);
    expect(chatstoreSrc).toMatch(/export function useChatRevision/);
  });
});

describe('every reader of shared memory follows it', () => {
  test('the sidebar lists, the drafts, the ceiling, the books, the checkpoint toggle and the update skip', () => {
    expect(sidebarSrc).toMatch(/useMemoryRevision\(PROJECTS_KEY, PINNED_KEY, NAMES_KEY, PROJECT_NAMES_KEY\)/);
    expect(cockpitSrc).toMatch(/useMemoryRevision\(DRAFTS_KEY\)/);
    // Through the drafts' one writer, and never saved back.
    expect(cockpitSrc).toMatch(/updateDrafts\(\(\) => next, false\);/);
    expect(cockpitSrc).toMatch(/useFollowedMemory<PilotLimits>\(LIMITS_KEY, readLimits\)/);
    expect(cockpitSrc).toMatch(/useFollowedMemory<string \| null>\(SKIP_KEY/);
    expect(cockpitSrc).toMatch(/useFollowedMemory\(CHECK_KEY/);
    expect(paneSrc).toMatch(/useFollowedMemory<Ledger>\(LEDGER_KEY, readLedger\)/);
    expect(paneSrc).toMatch(/useFollowedMemory\(WATCH_KEY, readWatch\)/);
    expect(settingsSrc).toMatch(/useMemoryRevision\(DRAFTS_KEY\)/);
  });
});

describe('the conversation on screen follows another client', () => {
  test("a saved change to it is restored, but never over this pane's own turn", () => {
    expect(paneSrc).toMatch(/const revision = useChatRevision\(chatKey\(dir, runId\)\);/);
    expect(paneSrc).toMatch(/if \(chat\.current === key && \(!moved \|\| held\.current\.live !== null\)\) return;/);
  });

  test('a turn sent from here names its conversation, so the host can announce it', () => {
    expect(paneSrc).toMatch(/\{ chat: chat\.current, asked: said \?\? '' \}/);
    expect(hostSrc).toMatch(/frame\.type === 'pilot_started' \|\|/);
    expect(paneSrc).toMatch(/startElsewhere\(frame, chat\.current, host\.allocatedHere\)/);
    // A pane opened mid-turn asks what is already running.
    expect(paneSrc).toMatch(/host\s*\.pilotTurnsNow\(\)/);
  });

  test('so does an API-key turn, which Rust runs and the host never sees', () => {
    expect(paneSrc).toMatch(/announce: \{ chat: chat\.current, asked: said \?\? '', asker: origin\.current \}/);
    expect(paneSrc).toMatch(/if \(event\.kind === 'announced'\)/);
    expect(paneSrc).toMatch(/\(\) => event\.asker === origin\.current/);
    expect(paneSrc).toMatch(/pilot\s*\.turnsNow\(\)/);
    // Stopped on its own road.
    expect(paneSrc).toMatch(/elsewhere\?\.road === 'api'\) void pilot\.cancel\(elsewhere\.id\)/);
  });
});

describe("the pilot's vendor, model and effort are one pick", () => {
  test('it reads what another client wrote, and a value that does not read is the default', () => {
    const pick = { vendor: 'openai' as const, model: 'gpt-6', effort: 'high' };
    expect(readPick(writePick(pick))).toEqual(pick);
    expect(readPick(null)).toEqual(DEFAULT_PICK);
    expect(readPick('{not json')).toEqual(DEFAULT_PICK);
    expect(readPick(JSON.stringify({ vendor: 'x', model: '  ', effort: 3 }))).toEqual(DEFAULT_PICK);
  });

  test('the pane reads it from the shared memory, never from state of its own', () => {
    expect(paneSrc).toMatch(/useFollowedMemory\(PICK_KEY/);
    expect(paneSrc).not.toMatch(/useState<keys\.Provider>\('anthropic'\)/);
  });
});

describe('settings saved elsewhere reach what this window acts on', () => {
  test("the cockpit's own read and the composer's defaults follow a config save", () => {
    expect(cockpitSrc).toMatch(/if \(c\.what !== 'config'\) return;/);
    expect(cockpitSrc).toMatch(/configEpoch=\{configEpoch\}/);
    expect(workstreamSrc).toMatch(/\}, \[dir, configEpoch\]\);/);
  });
});

describe('commands, deletions and answers are heard by every client', () => {
  const start = (id: string): CommandStarted => ({
    type: 'command_started',
    id: 1,
    command: { id, program: 'npm', args: ['run', 'dev'], resolved: 'node npm-cli.js', dir: '/repo', startedAt: 1 },
    refused: null,
  });

  test('a start heard twice is one command: the asker hears its own answer and the broadcast', () => {
    const once = reduceCommands({ all: [], refused: null }, start('cmd-1'));
    expect(reduceCommands(once, start('cmd-1')).all).toHaveLength(1);
    expect(reduceCommands(once, start('cmd-2')).all).toHaveLength(2);
  });

  test('a start reaches every client; a refusal stays with the asker', () => {
    expect(hostSrc).toMatch(/frame\.type === 'command_started' && frame\.command !== null/);
  });

  test("another client's delete and answers are re-read here", () => {
    expect(sidebarSrc).toMatch(/\.onRunDeleted\(\(\) => setBeat\(\(n\) => n \+ 1\)\)/);
    expect(questionsSrc).toMatch(/\.onQuestionsAnswered\(/);
  });
});
