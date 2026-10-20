# Cleaning up worktrees

Part of the working notes for this repo; [AGENTS.md](../../AGENTS.md) is the core and links here.
Moved out of AGENTS.md word for word on 2026-10-20, so where a note says *this file* it means
AGENTS.md and these companions together. Read this before changing the code it describes, and
update it in the same PR when that code changes.

## A worktree that built the app costs gigabytes

**This is the one piece of housekeeping nothing in the tooling does for you**, and it is not
proportionate to how it feels: a worktree looks like a checkout, and a checkout that has built
the desktop app is several gigabytes of Rust object files. Nothing warns, nothing rotates, and
`.worktrees/` is gitignored so it never shows up in a `git status` you were going to read
anyway. Measured on 2026-09-10, with the repo about a year old:

| what | size |
|---|---|
| `app/src-tauri/target` in **two** worktrees | 9.07 GB |
| `app/src-tauri/target/debug` in the main tree | 5.89 GB |
| the other 40 worktrees, mostly `node_modules` | ~2.4 GB |
| `app/src-tauri/target/release` — the live build | 1.72 GB |

Three rules come out of it, and the first two cost nothing at all.

- **A `target/debug` here is always residue.** This file already says to verify the app from
  `npm run app:build` and never from a `cargo build` or `tauri dev`, and the corollary is that
  nothing in this repo ever *uses* a debug tree. It was the single largest item on the disk
  and deleting it changes nothing. If one exists, something was built the way the section
  above says not to.
- **Delete a worktree's `app/src-tauri/target` the moment its issue lands**, even if you are
  keeping the worktree. It is a cache: the only thing losing it costs is one cold rebuild in a
  tree you have finished with. Check for `CACHEDIR.TAG` inside before removing, which is what
  makes it a cargo target rather than a directory that happens to be called `target`.
- **Prune the worktree itself**, per the bullet above. Two things make that safe and both were
  checked rather than assumed: every run under a worktree's `.vibe/runs` was already in the
  main checkout's archive — 323 directories, 26 distinct runs, 0 at risk — which is the
  seeding recipe above doing exactly what it is for; and a worktree with uncommitted work
  makes `git worktree remove` refuse rather than proceed.

**`git branch --merged develop` cannot tell you whether a worktree's work has landed here**,
and it will confidently say *no* for every one of them. PRs into `develop` are squash-merged,
so the branch's commits are not ancestors of anything and the merge-base test has nothing to
find. Read `CHANGELOG.md` or the issue, or diff the branch against `develop`; do not delete a
branch on the strength of that flag. Removing the *worktree* is the low-risk half — the branch
and its commits survive it.
