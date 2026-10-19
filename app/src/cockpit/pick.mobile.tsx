import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronRight, Folder, GitBranch, X } from 'lucide-react';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import * as host from '../host';
import { memory } from '../memory';
import { PROJECTS_KEY, readProjects } from './projects';

/**
 * The phone's folder chooser (#345), in place of `pick.ts`.
 *
 * A phone has no view of the desktop's disk, so the OS dialog `pick.ts` opens
 * would show the phone's own files, which are the wrong ones. This browses the
 * desktop instead, over the `fs` read frame the pilot already uses. **Its roots
 * are the host's**: it can reach exactly what the pilot can - the projects
 * already open, the directories the settings allow, and everything in YOLO -
 * and a folder outside them is refused in the host's own words, which name the
 * setting that would allow it.
 *
 * Same contract as `pick.ts`: a string or a cancel, and nothing decided about
 * whether the folder is a repository.
 */
export function pickDirectory(): Promise<string | null> {
  return new Promise((resolve) => {
    const into = document.createElement('div');
    document.body.appendChild(into);
    const root = createRoot(into);
    const done = (chosen: string | null): void => {
      root.unmount();
      into.remove();
      resolve(chosen);
    };
    root.render(<Browser starts={readProjects(memory.getItem(PROJECTS_KEY))} onDone={done} />);
  });
}

/** One listing, or why there is none. */
type Shown =
  | { kind: 'reading' }
  | { kind: 'listed'; path: string; folders: readonly string[]; repository: boolean; truncated: boolean }
  | { kind: 'refused'; message: string };

/** The folders in a listing, in the host's order. A link is not followed. */
export function foldersOf(entries: readonly { name: string; kind: string }[]): readonly string[] {
  return entries.filter((e) => e.kind === 'dir').map((e) => e.name);
}

/**
 * Whether a listing is a git repository's top: a `.git` in it, as a directory
 * or - in a worktree - a file. Read off the listing the host sent, so it is a
 * fact about this folder rather than a guess, and it decides nothing: a folder
 * that is not one can still be chosen, as `pick.ts`'s can.
 */
export function isRepository(entries: readonly { name: string; kind: string }[]): boolean {
  return entries.some((e) => e.name === '.git' && (e.kind === 'dir' || e.kind === 'file'));
}

/**
 * The folders drawn, and how many were left out. A name starting with a dot is
 * left out unless asked for: on a phone the list is the whole screen, and
 * `.git`, `.vibe` and `.cache` at its top are folders nobody adds as a project.
 */
export function visibleFolders(
  folders: readonly string[],
  hidden: boolean,
): { shown: readonly string[]; left: number } {
  if (hidden) return { shown: folders, left: 0 };
  const shown = folders.filter((f) => !f.startsWith('.'));
  return { shown, left: folders.length - shown.length };
}

/**
 * The path as places to go back to, each an absolute path the host resolves.
 * `/home/you/code` is `/`, `/home`, `/home/you`, `/home/you/code`; a Windows
 * desktop's `C:\Users\you` keeps its drive as the first place. A place outside
 * what the host may list is refused by the host, in its words, as any other.
 */
export function crumbs(path: string): readonly { name: string; path: string }[] {
  const parts = path.split(/[\\/]+/).filter((p) => p !== '');
  if (/^[A-Za-z]:[\\/]?/.test(path)) {
    const [drive = '', ...rest] = parts;
    const out = [{ name: drive, path: `${drive}\\` }];
    let at = drive;
    for (const part of rest) {
      at = `${at}\\${part}`;
      out.push({ name: part, path: at });
    }
    return out;
  }
  const out = [{ name: '/', path: '/' }];
  let at = '';
  for (const part of parts) {
    at = `${at}/${part}`;
    out.push({ name: part, path: at });
  }
  return out;
}

/** The last part of a path, for the button that chooses it. */
function leaf(path: string): string {
  const parts = path.split(/[\\/]+/).filter((p) => p !== '');
  return parts.at(-1) ?? path;
}

/**
 * The chooser, drawn as the whole screen (#347). It was a centred dialog with a
 * list capped at twenty rows of a 320px box; on a phone the list is the thing
 * being used, so it gets the screen, the path above it is a row of places to
 * go back to rather than one `..` per level, and the choice is a button at the
 * thumb's end of the screen naming the folder it will choose.
 *
 * It guards nothing, so the way out is a plain cancel at the top - but there is
 * no scrim to press by mistake either, since there is nothing beside it.
 */
function Browser({ starts, onDone }: { starts: readonly string[]; onDone: (chosen: string | null) => void }) {
  // The boundary the host resolves against. A project the window already has
  // open is the obvious start; with none, the person types one.
  const [base, setBase] = useState<string | null>(starts[0] ?? null);
  const [at, setAt] = useState('.');
  const [shown, setShown] = useState<Shown>({ kind: 'reading' });
  const [typed, setTyped] = useState('');
  const [hidden, setHidden] = useState(false);
  // The last folder that listed, so a refusal has somewhere to go back to.
  const [lastGood, setLastGood] = useState<string | null>(null);
  const trail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (base === null) return;
    let live = true;
    setShown({ kind: 'reading' });
    host.fs('list', base, at).then(
      (frame) => {
        if (!live) return;
        if (frame.op === 'list') {
          setShown({
            kind: 'listed',
            path: frame.path,
            folders: foldersOf(frame.entries),
            repository: isRepository(frame.entries),
            truncated: frame.truncated,
          });
          setLastGood(frame.path);
        }
      },
      (err: unknown) => live && setShown({ kind: 'refused', message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [base, at]);

  // The end of the trail is where you are, so it is the end that is kept in view.
  useEffect(() => {
    const el = trail.current;
    if (el !== null) el.scrollLeft = el.scrollWidth;
  }, [shown]);

  const here = shown.kind === 'listed' ? shown.path : null;
  const go = (path: string): void => setAt(path);
  const folders = shown.kind === 'listed' ? visibleFolders(shown.folders, hidden) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="choose a folder on the desktop"
      className="fixed inset-0 z-50 flex flex-col bg-page text-primary"
    >
      <div className="flex flex-none items-center gap-2 border-b border-rule-structure px-2 py-1.5">
        <button
          type="button"
          aria-label="Cancel"
          className="flex size-10 flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-secondary hover:text-emphasis"
          onClick={() => onDone(null)}
        >
          <X className="size-5" aria-hidden />
        </button>
        <div className="min-w-0">
          <div className="text-body font-semibold text-emphasis">Choose a folder</div>
          <div className="text-label text-tertiary">on the desktop this phone is connected to</div>
        </div>
      </div>

      {starts.length > 1 && (
        <div className="flex flex-none gap-1.5 overflow-x-auto px-3 pt-3 [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden">
          {starts.map((s) => (
            <Button
              key={s}
              size="sm"
              className="flex-none"
              variant={s === base ? 'primary' : 'secondary'}
              onClick={() => {
                setBase(s);
                setAt('.');
              }}
            >
              {leaf(s)}
            </Button>
          ))}
        </div>
      )}

      <form
        className="flex flex-none gap-2 px-3 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          const path = typed.trim();
          if (path === '') return;
          setBase(path);
          setAt('.');
        }}
      >
        <input
          className="h-10 min-w-0 flex-1 rounded-sm border border-rule-control bg-card px-3 font-mono text-mono-sm text-primary"
          placeholder="or type a folder's path"
          aria-label="a folder on the desktop"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button type="submit" className="h-10">
          go
        </Button>
      </form>

      {here !== null && (
        <div
          ref={trail}
          className="flex flex-none items-center overflow-x-auto px-2 pt-3 pb-1 font-mono text-mono-sm [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden"
          aria-label="where this is"
        >
          {crumbs(here).map((c, i, all) => (
            <span key={c.path} className="flex flex-none items-center">
              {i > 0 && <ChevronRight className="size-3.5 text-tertiary" aria-hidden />}
              <button
                type="button"
                className={cn(
                  'min-h-9 cursor-pointer rounded-sm border-0 bg-transparent px-1.5 hover:bg-active',
                  i === all.length - 1 ? 'text-emphasis' : 'text-tertiary',
                )}
                aria-current={i === all.length - 1 ? 'location' : undefined}
                onClick={() => go(c.path)}
              >
                {c.name}
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-rule-inner">
        {base === null ? (
          <p className="m-0 px-4 py-4 text-body-sm text-tertiary">
            No project is open yet, so there is nowhere to start. Type a folder on the desktop above.
          </p>
        ) : shown.kind === 'reading' ? (
          <p className="m-0 px-4 py-4 text-body-sm text-tertiary">reading…</p>
        ) : shown.kind === 'refused' ? (
          <div className="flex flex-col items-start gap-3 px-4 py-4">
            {/* The host's sentence, verbatim: it names the directories allowed and the setting that adds one. */}
            <p className="m-0 text-body-sm text-loss">{shown.message}</p>
            {lastGood !== null && (
              <Button variant="secondary" size="sm" onClick={() => go(lastGood)}>
                back to {leaf(lastGood)}
              </Button>
            )}
          </div>
        ) : (
          <>
            <ul className="m-0 list-none p-0">
              {folders !== null && folders.shown.length === 0 && (
                <li className="px-4 py-4 text-body-sm text-tertiary">No folders in here.</li>
              )}
              {folders?.shown.map((name) => (
                <li key={name} className="border-b border-rule-inner">
                  <button
                    type="button"
                    className="flex min-h-12 w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-4 text-left text-body text-primary hover:bg-active"
                    onClick={() => go(`${shown.path}/${name}`)}
                  >
                    <Folder className="size-4 flex-none text-tertiary" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <ChevronRight className="size-4 flex-none text-tertiary" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
            {folders !== null && folders.left > 0 && (
              <button
                type="button"
                className="mx-4 my-3 cursor-pointer border-0 bg-transparent p-0 text-body-sm text-tertiary underline hover:text-emphasis"
                onClick={() => setHidden(true)}
              >
                show {folders.left} hidden {folders.left === 1 ? 'folder' : 'folders'}
              </button>
            )}
            {shown.truncated && (
              <p className="mx-4 my-3 text-label text-tertiary">The host listed only the first part of this folder.</p>
            )}
          </>
        )}
      </div>

      <div className="flex flex-none flex-col gap-2 border-t border-rule-structure px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {shown.kind === 'listed' && (
          <span className="flex items-center gap-1.5 text-body-sm text-tertiary">
            {shown.repository ? (
              <>
                <GitBranch className="size-3.5" aria-hidden /> a git repository
              </>
            ) : (
              'not a git repository'
            )}
          </span>
        )}
        <Button
          variant="primary"
          className="h-11 w-full"
          disabled={here === null}
          onClick={() => here !== null && onDone(here)}
        >
          {here === null ? 'choose this folder' : `choose ${leaf(here)}`}
        </Button>
      </div>
    </div>
  );
}
