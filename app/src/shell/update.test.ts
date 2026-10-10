import { describe, expect, test } from 'vitest';
import { checkEnabled, excerpt, progress, shown } from './update';
import type { UpdateInfo } from './update';

const info = (version: string): UpdateInfo => ({ version, notes: null, date: null, action: 'install' });

describe('the update button', () => {
  test('is drawn for an update nobody skipped', () => {
    expect(shown(info('1.6.0'), null)).toBe(true);
  });

  test('is hidden for the version that was skipped', () => {
    expect(shown(info('1.6.0'), '1.6.0')).toBe(false);
  });

  test('comes back for a newer version than the skipped one', () => {
    expect(shown(info('1.7.0'), '1.6.0')).toBe(true);
  });

  test('is hidden when there is no update, or the check could not be made', () => {
    expect(shown(null, null)).toBe(false);
  });
});

describe('the check-for-updates setting', () => {
  test('is on by default', () => {
    expect(checkEnabled(null)).toBe(true);
    expect(checkEnabled('on')).toBe(true);
  });

  test('off means off', () => {
    expect(checkEnabled('off')).toBe(false);
  });
});

describe('the notes excerpt', () => {
  test('keeps the first lines and says when it cut', () => {
    const notes = ['## Added', '', '- one', '- two', '- three'].join('\n');
    expect(excerpt(notes, 2)).toEqual({ text: '## Added\n- one', cut: true });
    expect(excerpt(notes, 10)).toEqual({ text: '## Added\n- one\n- two\n- three', cut: false });
  });

  test('no notes is an empty excerpt', () => {
    expect(excerpt(null)).toEqual({ text: '', cut: false });
  });
});

describe('download progress', () => {
  test('is a bar only with a denominator', () => {
    expect(progress({ stage: 'downloading', downloaded: 3_000_000, total: null }).ratio).toBeNull();
    expect(progress({ stage: 'downloading', downloaded: 3_000_000, total: 0 }).ratio).toBeNull();
    const known = progress({ stage: 'downloading', downloaded: 3_000_000, total: 12_000_000 });
    expect(known.ratio).toBe(0.25);
    expect(known.text).toBe('Downloading… 3.0 MB of 12.0 MB');
  });

  test('installing has no bar', () => {
    expect(progress({ stage: 'installing' })).toEqual({ text: 'Installing…', ratio: null });
  });
});
