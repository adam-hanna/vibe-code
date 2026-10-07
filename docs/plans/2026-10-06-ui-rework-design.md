# UI rework: the cockpit as an editor-shaped workspace

Approved 2026-10-06. Branch `feat/ui-polish`.

## Goal

The app is hard to look at. Rebuild its surface in the VS Code / Cursor idiom on a
UI framework, rework the layout, and keep every behaviour and every measured-state
rule the current app has.

## Foundations

- **Stack.** Tailwind v4 (`@tailwindcss/vite`), shadcn/ui components copied into
  `app/src/ui/`, `lucide-react`, `cmdk`, `react-resizable-panels`. All app-only; the
  root `package.json` keeps `dependencies: {}`.
- **Tokens stay.** `tokens.css` keeps every colour. Tailwind's `@theme` maps them by
  reference, so no hex appears outside `tokens.css` and `audit:contrast` §7 holds
  unchanged. The palette moves to a near-black editor ground, one step lighter for
  sidebars and panels, low-contrast 1px borders, the lime accent kept for selection
  and live state. §1–§6 are re-run against the new values, never relaxed.
- **Type.** The `--size-*` / `--type-*` split and `--type-scale` stay (§8 and the
  Settings slider depend on them). Body defaults to 13px. Inter for UI, JetBrains
  Mono for code, bundled.
- **Deleted.** The 6,589 lines of hand-written CSS, replaced by utilities and about
  ten shadcn components. §9 and §10 re-target the shadcn `Button` and `Dialog`.
- **Cost.** 29 test files read component source as text. Each is re-pointed as its
  component moves, all case 2, claims kept, listed in the PR.

## Layout

```
┌──┬──────────┬────────────────────────────┬──────────┐
│A │ Sidebar  │ Main pane (tabbed)         │ Loop     │
│c │ Runs /   │ Pilot · Plans · Critique   │ column   │
│t │ Projects │ Review · Code · Questions  │          │
│v │ Settings │ Verify · Usage             │          │
│  │          ├────────────────────────────┤          │
│  │          │ Bottom panel               │          │
│  │          │ Output · Commands          │          │
├──┴──────────┴────────────────────────────┴──────────┤
│ Status bar: host · build · spend · gate             │
└─────────────────────────────────────────────────────┘
```

- **Activity bar** replaces the 54px rail: runs, projects, settings. Clicking the
  active icon collapses the sidebar. `＋ ⌘K ⚙` live here permanently (AUDIT §1.1).
- **Sidebar** is `Sidebar.tsx` restyled. A row opens a run and never starts one.
- **Main pane** keeps the artifact tabs. Output and Commands move to the **bottom
  panel** (⌘J), which collapses to a strip.
- **Loop column** stays on the right (#223 decision), in a resizable panel.
- **Status bar** takes the footer's facts (host, build, protocol alarm chip), live
  spend, the current gate and its continue / stop controls.
- **Resizing and memory.** Every divider drags; sizes and collapsed states persist in
  `where.ts` beside tab and run. This widens the earlier "a collapse is a gesture"
  decision: with real handles, an arrangement is a setting.
- **Command palette** (⌘K) lists every action from one action table, so an entry
  cannot exist without a control.

## Components and the rules they carry

- Set: `Button`, `Tabs`, `Dialog`, `Popover`, `Tooltip`, `Select`, `Input`/`Textarea`,
  `Switch`, `ScrollArea`, `Badge`, `Separator`, `Command`, `ResizablePanel`.
- **Pilot pane**: your turns right-bounded at 80%, replies full width (asymmetry
  kept), tool calls as collapsible rows, proposals as bordered cards with one primary
  button. The thinking indicator stays three `v-pulse` dots.
- **Round cards and loop column**: content unchanged; corner marks and hatched
  skeletons replaced by borders, badges and the live accent ring. `Counts` stays a
  control.
- **Settings**: section list left, content right, a search box. The three storage
  kinds (project file, this window, keychain) keep labelled headers.
- **Diagnostics**: popover, no scrim (#204).
- **Rules pinned**: a bar only with a named denominator; absence drawn with its
  reason; no issue numbers on screen (`copy.test.ts`); one element pulses; every exit
  code has a phrase and 2 and 7 never say "failed"; Escape leaves every dialog from
  the window.
- **Icons**: Lucide, 16px chrome, 14px rows, each with a tooltip.

## Delivery

Groundwork first, no visible change, then one pane per commit. Every commit passes
the full gate and the branch is bisectable.

1. **Install and wire.** Tailwind, shadcn, icons, panels, `cmdk`; `@theme` over
   `tokens.css`. The app builds and looks identical.
2. **Shell.** Activity bar, sidebar, resizable panels, bottom panel, status bar,
   palette. Old panes render inside with their CSS still loaded.
3. **Panes, one at a time.** Pilot, loop column and round cards, artifact panes,
   settings, dialogs. Each step deletes that pane's old CSS.
4. **Sweep.** Remove the last old CSS; update `HANDOFF.md` provenance and `AUDIT.md`;
   write the `AGENTS.md` note on what this reverses and why.

## Tests and gates

- Re-pointed source-reading tests: case 2, claims kept, listed in the PR.
- `audit:contrast` keeps all ten sections.
- New: `where.ts` round-trips panel state; the palette's action table matches the
  controls that exist; the status bar's exit-code map (moved from the footer's test).
- No jsdom. Layout logic lives in pure modules (`where.ts`, `actions.ts`).
- Per commit: root `npm run typecheck && npm test`; in `app/`: typecheck, vitest,
  `audit:contrast`, `cargo test`, a real `npm run app:build` and a look at every
  screen.

## Out of scope

- Light theme (tokens allow one later; the audit would need light-ground rows).
- Animation beyond the pulse.
- Any change to frames or to `src/`. A screen that wants a number the wire does not
  carry draws the absence with its reason and the frame gets its own issue.
