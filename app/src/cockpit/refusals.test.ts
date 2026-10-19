import { expect, test } from 'vitest';
import settings from './Settings.tsx?raw';

// *"I can't change maxWaitMinutes in project settings"* (#223). The save was
// refused because a run was going; the field kept the typed number, so it read
// as saved. Every save-on-blur field must re-seed when a save is refused.
test('every field that saves on blur resets when a save is refused', () => {
  const fields = ['NumberField', 'TextField', 'ListField'];
  // Case 2 (#371): the re-seed moved into one hook every field takes, which
  // also keeps a field somebody is typing in - but never past a refusal.
  const hookAt = settings.indexOf('function useTyped(');
  const hook = settings.slice(hookAt, settings.indexOf('\nfunction ', hookAt + 1));
  expect(hook).toMatch(/useContext\(Refusals\)/);
  expect(hook).toMatch(/refusals\]\);/);
  expect(hook).toMatch(/if \(editing\.current && !byRefusal\) return;/);
  for (const name of fields) {
    const start = settings.indexOf(`function ${name}(`);
    const body = settings.slice(start, settings.indexOf('\nfunction ', start + 1));
    expect(body, name).toMatch(/useTyped\(/);
    expect(body, name).toMatch(/\{\.\.\.focus\}/);
    expect(body, name).toMatch(/left\(\);/);
  }
  expect(settings).toMatch(/setRefusals\(\(n\) => n \+ 1\)/);
  expect(settings).toMatch(/<Refusals\.Provider value=\{refusals\}>/);
});

// *"Set `progress.maxQuietMs` before you press it"* - and the screen called it
// "silence". Every row whose label is prose names its key too.
test('a setting named by its key in a message can be found by that key here', () => {
  for (const key of [
    'progress.maxQuietMs',
    'verify.enabled',
    'verify.command',
    'verify.runs',
    'verify.timeoutMs',
    'git.worktree',
    'git.worktreeCommand',
    'git.worktreeTimeoutMs',
  ]) {
    expect(settings, key).toContain(`<Key name="${key}" />`);
  }
});

// *"git.baseRef is \"origin/develop\", but ..."* - the run's own refusals name
// the base by its key (#249), so the field that sets it carries the key too.
test('the base a run starts from can be found by the key its refusals name', () => {
  expect(settings).toContain('<Key name="git.baseRef" />');
});
