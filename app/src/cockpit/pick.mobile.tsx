import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Modal } from '../design';
import { Button } from '@/ui/button';
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
  | { kind: 'listed'; path: string; folders: readonly string[]; truncated: boolean }
  | { kind: 'refused'; message: string };

/** The folders in a listing, in the host's order. A link is not followed. */
export function foldersOf(entries: readonly { name: string; kind: string }[]): readonly string[] {
  return entries.filter((e) => e.kind === 'dir').map((e) => e.name);
}

function Browser({ starts, onDone }: { starts: readonly string[]; onDone: (chosen: string | null) => void }) {
  // The boundary the host resolves against. A project the window already has
  // open is the obvious start; with none, the person types one.
  const [base, setBase] = useState<string | null>(starts[0] ?? null);
  const [at, setAt] = useState('.');
  const [shown, setShown] = useState<Shown>({ kind: 'reading' });
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (base === null) return;
    let live = true;
    setShown({ kind: 'reading' });
    host.fs('list', base, at).then(
      (frame) => {
        if (!live) return;
        if (frame.op === 'list') {
          setShown({ kind: 'listed', path: frame.path, folders: foldersOf(frame.entries), truncated: frame.truncated });
        }
      },
      (err: unknown) => live && setShown({ kind: 'refused', message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [base, at]);

  const here = shown.kind === 'listed' ? shown.path : null;
  const go = (path: string): void => setAt(path);

  return (
    <Modal width={560} label="choose a folder on the desktop" onDismiss={() => onDone(null)}>
      <div className="mb-3 text-title font-semibold text-display">Choose a folder on the desktop</div>

      {starts.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {starts.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={s === base ? 'primary' : 'secondary'}
              onClick={() => {
                setBase(s);
                setAt('.');
              }}
            >
              {s}
            </Button>
          ))}
        </div>
      )}

      <form
        className="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const path = typed.trim();
          if (path === '') return;
          setBase(path);
          setAt('.');
        }}
      >
        <input
          className="h-7 min-w-0 flex-1 rounded-sm border border-rule-control bg-card px-2 font-mono text-mono-sm text-primary"
          placeholder="a folder on the desktop"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button type="submit">go</Button>
      </form>

      {base === null ? (
        <p className="my-2 text-body-sm text-tertiary">No project is open yet, so there is nowhere to start. Type a folder on the desktop.</p>
      ) : shown.kind === 'reading' ? (
        <p className="my-2 text-body-sm text-tertiary">reading…</p>
      ) : shown.kind === 'refused' ? (
        // The host's sentence, verbatim: it names the directories allowed and the setting that adds one.
        <p className="my-2 text-body-sm text-loss">{shown.message}</p>
      ) : (
        <>
          <div className="mb-2 break-all font-mono text-mono-sm text-emphasis">{shown.path}</div>
          <ul className="m-0 max-h-80 list-none overflow-y-auto border-y border-rule-inner p-0">
            <li>
              <button
                type="button"
                className="w-full cursor-pointer border-0 bg-transparent px-2 py-2 text-left font-mono text-mono-sm text-secondary hover:bg-active"
                onClick={() => go(`${shown.path}/..`)}
              >
                ..
              </button>
            </li>
            {shown.folders.map((name) => (
              <li key={name} className="border-t border-rule-inner">
                <button
                  type="button"
                  className="w-full cursor-pointer border-0 bg-transparent px-2 py-2 text-left font-mono text-mono-sm text-primary hover:bg-active"
                  onClick={() => go(`${shown.path}/${name}`)}
                >
                  {name}/
                </button>
              </li>
            ))}
          </ul>
          {shown.truncated && <p className="mt-2 mb-0 text-label text-tertiary">The host listed only the first part of this folder.</p>}
        </>
      )}

      <div className="mt-4 flex gap-2">
        <Button variant="primary" disabled={here === null} onClick={() => here !== null && onDone(here)}>
          choose this folder
        </Button>
        <Button variant="quiet" className="ml-auto" onClick={() => onDone(null)}>
          cancel
        </Button>
      </div>
    </Modal>
  );
}
