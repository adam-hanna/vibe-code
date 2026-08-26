import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diffChunks, diffSince, splitNul } from '@src/git.js';
import { initGit } from './helpers/loop-harness.js';

/**
 * The packer, against a real repository.
 *
 * `git` is not a seam here for the same reason the loop harness does not fake
 * it: every claim this file makes is a claim about what git actually prints -
 * how it separates two files' sections, what `--name-only -z` does to a path
 * with a space in it, whether `--` makes `[x].txt` a literal path. A fake would
 * be asserting against my belief about git rather than against git (#49).
 *
 * Sizes are small and `maxChars` is passed explicitly. The real 400,000 is
 * exercised through the loop in `review-chunking.test.ts`; here the interesting
 * numbers are the boundaries, and a boundary is easier to hit at 400 than at
 * 400,000.
 */

function repo(options: { commit?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-chunk-'));
  initGit(dir, options);
  return dir;
}

/** A file whose diff is roughly `chars` long, in lines rather than one long one. */
function lines(chars: number, fill = 'x'): string {
  const line = `${fill.repeat(39)}\n`;
  return line.repeat(Math.max(1, Math.ceil(chars / line.length)));
}

function write(dir: string, name: string, body: string): void {
  writeFileSync(path.join(dir, name), body, 'utf8');
}

/**
 * What `diffChunks` will see for one file, measured the same way it measures:
 * the staged diff with one trailing newline removed.
 */
function bodyLength(dir: string, file: string): number {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  const out = execFileSync('git', ['--literal-pathspecs', 'diff', '--cached', '--no-renames', '--', file], {
    cwd: dir,
    encoding: 'utf8',
  });
  return out.endsWith('\n') ? out.length - 1 : out.length;
}

/**
 * Whether the filesystem will hold this name exactly.
 *
 * Windows silently strips a trailing space and refuses a newline outright, so a
 * case about awkward names must be able to say "this one could not be created
 * here" rather than pass because nothing was tested.
 */
function creatable(dir: string, name: string): boolean {
  try {
    write(dir, name, 'body\n');
  } catch {
    return false;
  }
  return readdirSync(dir).includes(name);
}

test('every changed file lands in exactly one chunk, and no chunk overflows', async () => {
  const dir = repo();
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) write(dir, name, lines(300));

  const { chunks, files } = await diffChunks(dir, null, { maxChars: 500 });

  assert.deepEqual(
    chunks.flatMap((c) => c.files),
    files,
    'the chunks and the file list must describe the same change, in the same order',
  );
  assert.equal(new Set(files).size, files.length);
  assert.ok(chunks.length > 1, `expected a split, got ${chunks.length} chunk(s)`);
  for (const chunk of chunks) {
    if (chunk.truncated.length === 0) assert.ok(chunk.diff.length <= 500, `${chunk.diff.length}`);
  }
});

test('a chunk that lands exactly on the limit keeps both files, and one byte less splits them', async () => {
  // The separator regression: the chunk's diff is the file bodies joined with a
  // newline, so a fit test that forgets that byte lets a two-file chunk exceed
  // the limit by exactly one.
  const dir = repo();
  write(dir, 'a.txt', lines(200));
  write(dir, 'b.txt', lines(200));
  const exact = bodyLength(dir, 'a.txt') + 1 + bodyLength(dir, 'b.txt');

  const fits = await diffChunks(dir, null, { maxChars: exact });
  assert.equal(fits.chunks.length, 1);
  assert.equal(fits.chunks[0]?.diff.length, exact);

  const splits = await diffChunks(dir, null, { maxChars: exact - 1 });
  assert.equal(splits.chunks.length, 2);
  assert.deepEqual(splits.chunks[0]?.files, ['a.txt']);
  assert.deepEqual(splits.chunks[1]?.files, ['b.txt']);
});

test('a file bigger than the limit is cut inside its own chunk and named', async () => {
  const dir = repo();
  write(dir, 'huge.txt', lines(2000));
  write(dir, 'small.txt', lines(50));

  const { chunks } = await diffChunks(dir, null, { maxChars: 400 });
  const huge = chunks.find((c) => c.files.includes('huge.txt'));

  assert.deepEqual(huge?.files, ['huge.txt'], 'an oversized file gets a chunk to itself');
  assert.deepEqual(huge?.truncated, ['huge.txt']);
  assert.ok(huge?.diff.includes('[... diff truncated at 400 chars'));
  // Cut to the limit, plus the marker that says so - and nothing else.
  assert.ok((huge?.diff.length ?? 0) < 400 + 100);
  assert.ok(chunks.some((c) => c.files.includes('small.txt')));
});

test('the file list and the diff describe the same change when baseSha..HEAD is empty', async () => {
  // `git.commitEachRound: false` leaves the implementation uncommitted, so
  // `baseSha..HEAD` is empty and `diffSince` falls back to the working tree.
  // `changedFiles` has no such fallback, which used to hand the reviewer a real
  // diff beside an empty file list - and would now hand it nothing at all.
  const dir = repo({ commit: true });
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  write(dir, 'uncommitted.txt', lines(100));
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });

  const { chunks, files } = await diffChunks(dir, baseSha, { maxChars: 50 });

  assert.deepEqual(files, ['uncommitted.txt']);
  assert.ok(chunks[0]?.diff.includes('uncommitted.txt'));
  assert.deepEqual(
    chunks.flatMap((c) => c.files),
    files,
  );
});

test('a change under the limit is the same string diffSince returns', async () => {
  const dir = repo();
  write(dir, 'a.txt', lines(100));
  write(dir, 'b.txt', lines(100));

  const { chunks } = await diffChunks(dir, null);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.diff, await diffSince(dir, null));
  assert.deepEqual(chunks[0]?.truncated, []);
});

test('a patch keeps its trailing whitespace, and two files are separated by one newline', async () => {
  // `git()` trims, and trailing spaces on the last changed line are review
  // content, not noise: a reviewer judging whitespace-sensitive output must see
  // what is actually there.
  const dir = repo();
  write(dir, 'a.txt', `${lines(300)}trailing   \n`);
  write(dir, 'b.txt', lines(300));
  write(dir, 'c.txt', lines(300));
  // Two files in one chunk and a third that does not fit, so the whole-diff
  // shortcut is not taken and the join between a and b is observable.
  const pair = bodyLength(dir, 'a.txt') + 1 + bodyLength(dir, 'b.txt');

  const { chunks } = await diffChunks(dir, null, { maxChars: pair });

  assert.deepEqual(chunks[0]?.files, ['a.txt', 'b.txt']);
  const diff = chunks[0]?.diff ?? '';
  assert.ok(diff.includes('+trailing   \n'), 'trailing spaces survived the read');
  // One newline between the sections - which is what git itself prints, so a
  // chunk is a real prefix-preserving slice of the diff rather than a rebuild.
  assert.ok(diff.includes('+trailing   \ndiff --git a/b.txt'), 'exactly one newline at the join');
  assert.equal(diff.includes('+trailing   \n\ndiff --git'), false);
});

test('an awkward filename is listed and diffed as itself', async () => {
  const dir = repo();
  const wanted = ['with space.txt', '[x].txt', ' lead.txt', 'trail .txt', 'new\nline.txt'];
  const made = wanted.filter((name) => creatable(dir, name));

  // Said out loud rather than skipped silently: on Windows a trailing space and
  // a newline are not storable, and a case that quietly tested neither would
  // read as coverage it does not have.
  const missing = wanted.filter((n) => !made.includes(n));
  if (missing.length > 0) {
    console.log(`  (filesystem refused: ${missing.map((n) => JSON.stringify(n)).join(', ')})`);
  }
  assert.ok(made.includes('with space.txt'));
  assert.ok(made.includes('[x].txt'), 'a pathspec-magic name must at least be testable');

  const { chunks, files } = await diffChunks(dir, null, { maxChars: 1 });

  for (const name of made) {
    assert.ok(files.includes(name), `${JSON.stringify(name)} missing from the file list`);
    const owner = chunks.find((c) => c.files.includes(name));
    assert.ok(owner !== undefined, `${JSON.stringify(name)} is in no chunk`);
    assert.ok(
      owner.diff.length > 0,
      `${JSON.stringify(name)} was claimed as covered with an empty diff`,
    );
  }
});

test('an empty change is one empty chunk and no files at all', async () => {
  const dir = repo({ commit: true });

  const { chunks, files } = await diffChunks(dir, null, { maxChars: 10 });

  assert.deepEqual(files, [], 'not [""] - a phantom file is one the run cannot name');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.diff, '');
  assert.deepEqual(chunks[0]?.files, []);
});

test('the NUL splitter reads empty output as no files and keeps awkward names whole', () => {
  assert.deepEqual(splitNul(''), []);
  assert.deepEqual(splitNul('\0'), []);
  assert.deepEqual(splitNul('a.txt\0'), ['a.txt']);
  assert.deepEqual(splitNul('a.txt\0b.txt'), ['a.txt', 'b.txt']);
  assert.deepEqual(splitNul(' a \0'), [' a ']);
  assert.deepEqual(splitNul('a\nb\0c.txt\0'), ['a\nb', 'c.txt']);
});
