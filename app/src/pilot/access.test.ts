import { describe, expect, test } from 'vitest';
import pilotPane from './PilotPane.tsx?raw';
import { noCommands } from '../cockpit/commands';
import { emptyRun } from '../cockpit/model';
import { allowedDir, autoRun, NO_ACCESS, safeMatch } from './access';
import { accessNote, systemPrompt } from './brief';
import { settleCall } from './tools';
import { autoRan, emptyConversation } from './transcript';
import type { PilotAccess } from './access';
import type { Conversation } from './transcript';

/**
 * Which of the pilot's proposals run without a card (#223).
 *
 * *"It's completely safe for it to run 'ls', 'cat', 'echo', 'git add|commit'"*,
 * with a YOLO switch and directories beyond the repository. The rule is pure and
 * these cases drive it directly; the last two read the pane's source, because
 * whether a restored conversation can fire a command is decided in an effect and
 * the app has no jsdom.
 */

const REPO = '/home/me/repo';
const SAFE: PilotAccess = {
  ...NO_ACCESS,
  yolo: false,
  safeCommands: ['git status', 'git commit', 'git branch --list'],
  dirs: ['/home/me/shared'],
};

describe('the safe list', () => {
  test('a pattern is a program and its leading arguments, matched as a prefix', () => {
    expect(safeMatch('git', ['status'], REPO, REPO, SAFE)).toBe('git status');
    expect(safeMatch('git', ['commit', '-m', 'fix the thing'], REPO, REPO, SAFE)).toBe('git commit');
    expect(safeMatch('git', ['branch', '--list'], REPO, REPO, SAFE)).toBe('git branch --list');
    expect(safeMatch('git', ['branch', '-D', 'main'], REPO, REPO, SAFE)).toBeNull();
    expect(safeMatch('git', ['push'], REPO, REPO, SAFE)).toBeNull();
    expect(safeMatch('npm', ['test'], REPO, REPO, SAFE)).toBeNull();
  });

  test('global options before the subcommand do not match', () => {
    expect(safeMatch('git', ['-C', '/etc', 'status'], REPO, REPO, SAFE)).toBeNull();
  });

  test('a program named by path never inherits a name on the list', () => {
    expect(safeMatch('./git', ['status'], REPO, REPO, SAFE)).toBeNull();
    expect(safeMatch('C:\\tools\\git.exe', ['status'], REPO, REPO, SAFE)).toBeNull();
    // The Windows spelling of the same program does.
    expect(safeMatch('git.exe', ['status'], REPO, REPO, SAFE)).toBe('git status');
  });

  test('a matching command that reaches outside the allowed directories gets a card', () => {
    expect(safeMatch('git', ['status', '/etc/passwd'], REPO, REPO, SAFE)).toBeNull();
    expect(safeMatch('git', ['status', '../other'], REPO, REPO, SAFE)).toBeNull();
    expect(safeMatch('git', ['status', '--output=/etc/x'], REPO, REPO, SAFE)).toBeNull();
    expect(safeMatch('git', ['status', 'C:\\Windows'], REPO, REPO, SAFE)).toBeNull();
    // Inside: the repository and the directories the person allowed.
    expect(safeMatch('git', ['status', `${REPO}/src`], REPO, REPO, SAFE)).toBe('git status');
    expect(safeMatch('git', ['status'], '/home/me/shared/lib', REPO, SAFE)).toBe('git status');
    expect(safeMatch('git', ['status'], '/elsewhere', REPO, SAFE)).toBeNull();
  });

  test('nothing under .git runs without a card, so a copy cannot plant a hook', () => {
    // `cp evil.sh .git/hooks/pre-commit`, then a safe-listed `git commit`, would
    // run code nobody approved (#223).
    const files: PilotAccess = { ...SAFE, safeCommands: ['cp', 'cat', 'git commit'] };
    expect(safeMatch('cp', ['evil.sh', '.git/hooks/pre-commit'], REPO, REPO, files)).toBeNull();
    expect(safeMatch('cp', ['evil.sh', 'sub/.GIT/hooks/x'], REPO, REPO, files)).toBeNull();
    expect(safeMatch('cat', ['--file=.git/config'], REPO, REPO, files)).toBeNull();
    expect(safeMatch('cp', ['a.txt', 'b.txt'], REPO, REPO, files)).toBe('cp');
    expect(safeMatch('cat', ['.gitignore'], REPO, REPO, files)).toBe('cat');
  });

  test('the pilot picker names the vendor, and Settings names the road', () => {
    // *"you don't need to say 'codex (subscription)'… The settings page
    // dictates if the cli or api key is used"* (#223).
    const picker = pilotPane.slice(pilotPane.indexOf('{keys.PROVIDERS.map((v) => ('));
    expect(picker.slice(0, 200)).toContain('{keys.PROVIDER_NAME[v]}');
  });

  test('an empty list runs nothing', () => {
    expect(safeMatch('git', ['status'], REPO, REPO, NO_ACCESS)).toBeNull();
  });
});

describe('what runs without a card', () => {
  const command = { kind: 'command' as const, dir: REPO, program: 'git', args: ['status'] };

  test('a safe command does, and its reason names the pattern', () => {
    expect(autoRun(command, REPO, SAFE)).toMatch(/"git status" is on the user's safe list/);
    expect(autoRun({ ...command, args: ['push'] }, REPO, SAFE)).toBeNull();
    expect(autoRun({ kind: 'stop_command', commandId: 'cmd-1' }, REPO, SAFE)).toBeNull();
  });

  test('YOLO runs every command and every stop — and never a run or a gate', () => {
    const yolo: PilotAccess = { ...NO_ACCESS, yolo: true };
    expect(autoRun({ ...command, program: 'rm', args: ['-rf', 'build'] }, REPO, yolo)).toMatch(/YOLO/);
    expect(autoRun({ kind: 'stop_command', commandId: 'cmd-1' }, REPO, yolo)).toMatch(/YOLO/);
    expect(autoRun({ kind: 'invoke', argv: ['run', 'x'] }, REPO, yolo)).toBeNull();
    expect(autoRun({ kind: 'answer', askId: 1, decision: { kind: 'continue' } }, REPO, yolo)).toBeNull();
  });

  test('the model is told it ran without asking, never that somebody accepted it', () => {
    const conversation: Conversation = {
      ...emptyConversation(),
      replies: [
        {
          turn: 1,
          provider: 'subscription',
          model: null,
          text: '',
          calls: [
            {
              id: 'c1',
              name: 'run_command',
              input: {},
              unreadable: null,
              settlement: { kind: 'proposes', summary: 's', effect: command },
            },
          ],
          usage: null,
          outcome: 'end_turn',
          startedAt: null,
        } as unknown as Conversation['replies'][number],
      ],
    };
    const after = autoRan(conversation, 'c1', 'YOLO mode is on, so this ran without asking.');
    const last = after.messages[after.messages.length - 1];
    expect(last).toMatchObject({ role: 'tool', id: 'c1' });
    expect(JSON.stringify(last)).not.toMatch(/accepted/);
    expect(JSON.stringify(last)).toMatch(/without asking/);
  });
});

describe('where the pilot may reach', () => {
  test('the project, the allowed directories, and in YOLO anywhere', () => {
    expect(allowedDir(`${REPO}/sub`, REPO, NO_ACCESS)).toBe(true);
    expect(allowedDir('/home/me/shared', REPO, SAFE)).toBe(true);
    expect(allowedDir('/etc', REPO, SAFE)).toBe(false);
    expect(allowedDir('/etc', REPO, { ...NO_ACCESS, yolo: true })).toBe(true);
  });

  const ctx = (access: PilotAccess) => ({ run: emptyRun(), commands: noCommands(), dir: REPO, access });
  const call = (input: unknown) => ({ name: 'run_command', input, unreadable: null });

  test('run_command may name another directory only where the person allowed one', () => {
    const inside = settleCall(call({ program: 'git', why: 'w', directory: '/home/me/shared/x' }), ctx(SAFE));
    expect(inside).toMatchObject({ kind: 'proposes', effect: { dir: '/home/me/shared/x' } });
    const outside = settleCall(call({ program: 'git', why: 'w', directory: '/etc' }), ctx(SAFE));
    expect(outside.kind).toBe('refused');
    // With no directory it runs in the repository, as it always did.
    expect(settleCall(call({ program: 'git', why: 'w' }), ctx(SAFE))).toMatchObject({
      effect: { dir: REPO },
    });
  });

  test('the two read tools are asked of the host, on both backends', () => {
    const list = settleCall({ name: 'list_dir', input: { path: 'src' }, unreadable: null }, ctx(SAFE));
    expect(list).toEqual({ kind: 'reads', op: 'list', path: 'src' });
    const read = settleCall({ name: 'read_file', input: {}, unreadable: null }, ctx(SAFE));
    expect(read).toEqual({ kind: 'reads', op: 'read', path: '.' });
  });
});

describe('the pilot is told', () => {
  test('which commands run without asking, and that the rest are still cards', () => {
    const note = accessNote(SAFE);
    expect(note).toContain('- git status');
    expect(note).toContain('/home/me/shared');
    expect(note).toMatch(/Anything else is a proposal/);
  });

  test('in YOLO, that a run and a gate still need a press', () => {
    expect(accessNote({ ...NO_ACCESS, yolo: true })).toMatch(/start_run and answer_gate are still proposals/);
  });

  test('before the settings are read, that nothing runs unasked', () => {
    expect(accessNote(null)).toMatch(/every command you propose is a card/);
  });
});

describe('the pane', () => {
  test('a conversation read back from storage never runs anything without a press', () => {
    // Yesterday's `git commit` must not fire because the window reopened.
    expect(pilotPane).toContain('restored.current.add(call.id)');
    expect(pilotPane).toMatch(/out\.kind === 'proposes' && !restored\.current\.has\(call\.id\)/);
  });

  test('an auto-run goes through onEffect, the road a pressed card takes', () => {
    const block = pilotPane.slice(pilotPane.indexOf('const why ='), pilotPane.indexOf("dispatch({ type: 'auto'"));
    expect(block).toContain('onEffect(out.effect)');
  });
});

describe('what each backend is told it can read', () => {
  test('only the Claude CLI is told of file tools of its own', () => {
    const claude = systemPrompt(emptyRun(), null, 'emitted', null, true);
    const codex = systemPrompt(emptyRun(), null, 'emitted', null, false);
    expect(claude).toContain("You have the CLI's own Read, Glob and Grep");
    expect(codex).not.toContain("You have the CLI's own Read, Glob and Grep");
    expect(codex).toMatch(/list_dir and read_file and nothing else/);
  });
});
