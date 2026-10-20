import { expect, test } from 'vitest';
import { ADD_A_PROJECT_FIRST, settingsRead } from './settingsdoor';

/**
 * Which read each settings door sends (#385). The global door on an install
 * with no project sent `dir: ''` and drew the host's refusal; it now asks with
 * no project, and the project door with none says to add one.
 */

test('the global door with no project asks for the global settings alone', () => {
  expect(settingsRead('global', '')).toEqual({ kind: 'read', dir: null });
  expect(settingsRead('global', '   ')).toEqual({ kind: 'read', dir: null });
});

test('the project door with no project asks nothing, and says to add one', () => {
  expect(settingsRead('project', '')).toEqual({ kind: 'none', why: ADD_A_PROJECT_FIRST });
  expect(ADD_A_PROJECT_FIRST).not.toMatch(/carried|dir\b/);
});

test('either door with a project reads as it always did', () => {
  expect(settingsRead('global', '/repo')).toEqual({ kind: 'read', dir: '/repo' });
  expect(settingsRead('project', '/repo')).toEqual({ kind: 'read', dir: '/repo' });
});
