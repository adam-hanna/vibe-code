import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Activity, Terminal, X } from 'lucide-react';
import type { Layout, LayoutChangedMeta } from 'react-resizable-panels';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { ActivityBar } from '../shell/ActivityBar';
import { Palette } from '../shell/Palette';
import { StatusBar } from '../shell/StatusBar';
import { ACTIONS, available, chordLabel, shortcutFor } from '../shell/actions';
import type { ActionId } from '../shell/actions';
import { ResizableGroup, ResizablePanel, ResizableSeparator } from '../ui/resizable';
import { TooltipProvider } from '../ui/tooltip';
import { cn } from '@/lib/utils';
import { projectName } from './projects';
import * as host from '../host';
import * as keys from '../pilot/keys';
import type { KeyStatus } from '../pilot/keys';
// `PilotPane`, not `Pilot`: `pilot.ts` beside it is the wire, and two files
// differing only in case is a compile error on Windows and macOS both.
import { PilotPane } from '../pilot/PilotPane';
import { noCommands, reduceCommands, restore, running } from './commands';
import { NOWHERE, readWhere, WHERE_KEY, writableWhere } from './where';
import type { BottomTab, Panels, Viewing, Where } from './where';
import { CommandsPane } from './CommandsPane';
import { CodePane } from './CodePane';
import { Diagnostics } from './Diagnostics';
import { Footer } from './Footer';
import { PlansPane } from './PlansPane';
import { ReportPane } from './ReportPane';
import { Kickoff } from './Kickoff';
import {
  NAMES_KEY,
  PINNED_KEY,
  PROJECT_NAMES_KEY,
  PROJECTS_KEY,
  dirKey,
  moveProject,
  preview,
  readNames,
  readPins,
  readProjectNames,
  readProjects,
} from './projects';
import {
  DRAFTS_KEY,
  addDraft,
  bindDraft,
  markLaunched,
  newDraft,
  readDrafts,
  removeDraft,
} from './pending';
import type { Draft } from './pending';
import { chatKey } from '../pilot/saved';
import { loadChats, putChat } from '../pilot/chatstore';
import { useReplay } from './useReplay';

import { LoopColumn } from './LoopColumn';
import { NewWorkstream } from './NewWorkstream';
import { OutputPane } from './OutputPane';
import { Sidebar } from './Sidebar';
import { QuestionsPane } from './QuestionsPane';
import { RateLimitStrip } from './RateLimit';
import { Settings } from './Settings';
import { SpendPane } from './SpendPane';
import { StopConfirm } from './StopConfirm';
import { Summary } from './Summary';
import { Workstreams } from './Workstreams';
import { VerifyPane } from './VerifyPane';
import { StalenessStrip } from './Staleness';
import { NEEDS_HUMAN, tokens as fmtTokens } from './format';
import { emptyRun, foldReplay, forResume, latestQuestions, nextRun, reduce, staleness } from './model';
import { rounds } from './rounds';
import { implementArgv, readLaunchArgv, resumeArgv } from './argv';
import { SCALE_KEY, SCALE_VAR, readScale, writable } from './appearance';
import { readLimits, writeLimits } from '../pilot/ledger';
import type { PilotLimits } from '../pilot/ledger';
import type { Launched, Raise } from './argv';
import type { Caps } from './Footer';
import type { Effect } from '../pilot/tools';
import { memory } from '../memory';
import type { Frame } from '../host';
import type { Run } from './model';

/**
 * A tab in the main pane's bar (the UI rework). Stated rather than inherited:
 * these were the app's only unstyled buttons once, and an unselected tab is
 * navigation you are not in, which is the prose tier. The selected one takes the
 * accent and the 2px rule under it, and nothing dims.
 */
const TAB =
  'cursor-pointer whitespace-nowrap border-0 border-b-2 border-transparent bg-transparent px-2.5 pt-2.5 pb-3 text-body-sm font-medium text-secondary hover:bg-column hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent';
const TAB_ON = 'border-accent text-accent';

/**
 * The cockpit, at the slice #159 scopes it to.
 *
 * All four of `3a`'s regions — rail, loop column, output pane, footer — plus the
 * pilot, which since #211 is where you land and where a run is started from.
 *
 * ## The left rail, and what changed about the argument against it
 *
 * It was absent for two stated reasons and only one of them survived. The first
 * — *"projects and workstreams need the archive reader (#114)"* — stopped being
 * true when the `archive` frame landed. The second was that **`serve.ts` runs
 * one run at a time**, so there is never a second live workstream to switch
 * between, and a rail over the *archive* is `1b` in a sidebar.
 *
 * That is still true, and it is why the rail's squares **navigate rather than
 * reopen** (see `Rail.tsx`). What it does not justify is having no rail: the
 * design puts `＋`, ⌘K and `⚙` on it in every frame, and with nowhere for them
 * to live they were pushed into the tab bar — which is how that bar came to have
 * twelve tabs against the design's seven. `design/AUDIT.md` §1.1 and §1.2 are
 * one finding, and this is the half that fixes both.
 *
 * Everything on screen comes from a frame. There is no state here that was
 * inferred: `reduce` is the only thing that decides what the run looks like, and
 * it decides it from ids.
 */

/** How often the elapsed clock re-renders between heartbeats. */
const TICK_MS = 1000;

/** Where the last repository is remembered. See `repoDir` below. */
const REPO_KEY = 'vibe.repo';

/** Where the window was pointed when it last closed. See `where.ts`. */
function storedWhere(): Where {
  try {
    return readWhere(memory.getItem(WHERE_KEY));
  } catch {
    return NOWHERE;
  }
}

interface Wire {
  connected: boolean;
  hostPid: number | null;
  uncontained: string | null;
  failure: string | null;
  /**
   * The whole status, kept for the diagnostics panel (#201).
   *
   * The fields above are read on nearly every render and stay unpacked; this is
   * the same object they came from, held so the panel can show the build stamp
   * and the uptime without a second shape to keep in step.
   */
  status: host.Status | null;
  /** Prose from the host's stderr and any stdout line the relay could not parse. */
  log: readonly string[];
  /** A frame this version does not recognise. Shown, never discarded. */
  unknown: readonly string[];
}

export function Cockpit() {
  const [run, dispatch] = useReducer(
    // `Date.now()` here rather than inside `reduce`: the model takes the arrival
    // time as an argument so it stays pure and testable, and this is the one
    // place a real clock is read.
    (state: Run, action: Frame | { type: 'reset' } | { type: 'seed'; run: Run }) => {
      if (action.type === 'reset') return nextRun(state);
      // **A resume's column, before the loop adds to it** (#223). The run the
      // replay folded IS a `Run`, so this replaces rather than merges - there is
      // nothing to merge with, because `resume` seeds before it sends the
      // invoke and no live frame can have arrived yet.
      if (action.type === 'seed') return { ...action.run, protocol: state.protocol, seq: state.seq };
      return reduce(state, action, Date.now());
    },
    undefined,
    emptyRun,
  );
  const [wire, setWire] = useState<Wire>({
    connected: false,
    hostPid: null,
    uncontained: null,
    failure: null,
    status: null,
    log: [],
    unknown: [],
  });
  // The pilot's stored conversations, once the host can answer (#223). In a
  // browser preview there is no host and they come from localStorage instead.
  useEffect(() => {
    if (wire.connected || !host.inShell()) void loadChats();
  }, [wire.connected]);
  /**
   * How big the product is drawn (#223).
   *
   * Held here rather than in `Settings`, because the setting outlives the screen
   * that changes it: the pane is conditional and unmounts the moment you look at
   * anything else, so a scale that lived in it would snap back to 1 on every
   * navigation. The effect below is the one place `--type-scale` is written.
   */
  const [scale, setScale] = useState(() => {
    try {
      return readScale(memory.getItem(SCALE_KEY));
    } catch {
      // Storage can be unavailable. Text at the size it was designed is a
      // smaller failure than a window that will not render.
      return 1;
    }
  });
  useEffect(() => {
    document.documentElement.style.setProperty(SCALE_VAR, String(scale));
  }, [scale]);
  const rescale = useCallback((next: number) => {
    setScale(readScale(String(next)));
    try {
      memory.setItem(SCALE_KEY, writable(next));
    } catch {
      // It still applies for this session. See above.
    }
  }, []);


  /**
   * The pilot's own daily ceiling (#223).
   *
   * **Owned here so the control and the enforcement can be in different
   * places.** It is set on the settings screen — *"move pilot tokens and pilot
   * $/day out of pilot chat and into the same settings group"* — and enforced in
   * the pilot pane, which is where a turn is about to be spent. Two siblings, so
   * the state is one level up, exactly as the type scale is and for the same
   * reason: a change in Settings has to reach a pane that is already open.
   *
   * The window's memory (`memory.ts`) and not `vibe.config.json`, unchanged: this is the *pilot's*
   * ceiling, it is this machine's, and the run's two ceilings are the project's.
   */
  const [limits, setLimits] = useState<PilotLimits>(readLimits);
  const relimit = useCallback((next: PilotLimits) => {
    setLimits(next);
    writeLimits(next);
  }, []);
  /** Whether the diagnostics popover is open (#201, #204). ⌘⇧D toggles it. */
  const [diagnostics, setDiagnostics] = useState(false);
  /**
   * Whether each side column is open (#223).
   *
   * **Both start open, and neither is persisted.** A collapse is a gesture — put
   * the runs away to read a diff — not a decision, and a window that opened three
   * days later still folded would be answering a question nobody asked twice.
   * The window's memory holds the repository and the pilot's spend ceiling because
   * those are decisions.
   */
  /**
   * Which regions are open and how big each is (the UI rework). Kept between
   * launches through `where.ts`, which is where that decision is argued: with
   * drag handles between every region an arrangement is a setting, where a
   * collapse used to be a gesture.
   */
  const [panels, setPanels] = useState<Panels>(() => storedWhere().panels);
  /** The bottom panel's tab: Output or Commands, the two terminal-shaped panes. */
  const [bottom, setBottom] = useState<BottomTab>(() => storedWhere().bottom);
  const saveLayout = useCallback(
    (group: string) => (layout: Layout, meta: LayoutChangedMeta) => {
      // A layout the library recomputed after a window resize is not a
      // decision anybody made; only a drag is.
      if (!meta.isUserInteraction) return;
      setPanels((p) => ({ ...p, sizes: { ...p.sizes, [group]: layout } }));
    },
    [],
  );
  /**
   * A past run this window is reading, or null for the live one (#223).
   *
   * **Opening a run is not starting one, and that separation is the whole
   * feature.** A row in the sidebar used to resume: probe both CLIs, take the
   * lock, run a turn. Reported at once — *"clicking on a run automatically kicks
   * off the pre-flight. I don't want that."* — and it is the sharper form of the
   * rule the rail already had: a click must not silently **spend**. Browsing an
   * archive has to be free.
   *
   * So this is where the window is *pointed*, and every pane that reads a run's
   * own directory follows it: the plans, the two reports, the questions, the
   * code and the transcript are all files on disk, and reading them takes no
   * lock and starts nothing.
   *
   * **It is deliberately not a `Run`.** `reduce` builds one from frames, and a
   * finished run's frames were narrated to a process that has exited — synthesising
   * them would report finished work as running, which is the fabrication this
   * whole model is arranged against. The loop column and the spend readout stay
   * with the live run and say which run they are about.
   */
  // Restored from the last launch (#223): opening a run is a read, so coming
  // back to one costs what a click on the sidebar costs and starts nothing.
  const [viewing, setViewing] = useState<Viewing | null>(() => storedWhere().viewing);
  /** Whether the ⌘K switcher is open (`5f`, #223). */
  const [switching, setSwitching] = useState(false);
  /**
   * The composer, and which repository it is composing for (#223).
   *
   * **A directory rather than a boolean**, because `4a` is now reachable two
   * ways and they answer the repository question differently. Opened from the
   * sidebar's `＋ New run` it is about wherever the window is pointed, and the
   * field is live. Opened from a **project's** `＋` the answer is the project —
   * *"In this window, I shouldn't have to select the project folder, it's
   * already known"* — so the path is stated and there is nothing to pick.
   */
  const [composing, setComposing] = useState<{ dir: string; locked: boolean } | null>(null);
  /**
   * The repository this window is pointed at (#223).
   *
   * **App-side state, and it belongs nowhere else.** It is not run state - a run
   * carries its own directory and always has - and it is not `vibe.config.json`,
   * which is a project file meant to be committed and would be the wrong place
   * for one machine's path. The window's memory is where the pilot's spend ceiling
   * lives for the same reason.
   *
   * It is persisted because `1b` and ⌘K are most useful **before** a launch, and
   * a path the user has to retype every time the app starts is a path they stop
   * using the screen rather than retype.
   */
  const [repoDir, setRepoDir] = useState(() => {
    try {
      return memory.getItem(REPO_KEY) ?? '';
    } catch {
      // Storage can be unavailable or full. A repository field that starts empty
      // is a smaller failure than a window that will not render.
      return '';
    }
  });
  const rememberRepo = useCallback((dir: string) => {
    setRepoDir(dir);
    try {
      memory.setItem(REPO_KEY, dir);
    } catch {
      // See above. Nothing here is worth failing a render over.
    }
  }, []);
  /**
   * A pause this window has asked for and not yet seen honoured (#210).
   *
   * The window's own memory of its own outbound message, like `sentLaunch` — not
   * a re-derivation. The loop is the one that decides when a pause is taken, and
   * it says so with `requested` on `gate_waiting`; this only stops the button
   * being pressed twice while nothing appears to happen.
   */
  const [pausing, setPausing] = useState(false);
  /** Whether the stop confirmation is up. Hi-fi 18: a stop confirms first. */
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [launched, setLaunched] = useState(false);
  /**
   * The conversation the pilot was showing when a run was launched, held until
   * that run says who it is (#223).
   *
   * Launching points the window at the new run before it has an id, so for the
   * seconds until `run_started` the pane had no run to key its chat by and fell
   * back to the project's "before any run" conversation - restoring whatever
   * stale exchange was stored there, which the new run then **adopted** as its
   * own. *"The run that starts, the pilot chat, progress etc gets confused with
   * a previous run. It's like some key isn't unique somewhere."* Holding the key
   * that proposed the run makes the gap a `stay`, so what the new run adopts is
   * the conversation that actually proposed it. A draft holds itself already.
   */
  const [holdChat, setHoldChat] = useState<{ dir: string; runId: string | null } | null>(null);
  const pilotAt = useRef<{ dir: string; runId: string | null }>({ dir: '', runId: null });
  /**
   * The launch this window sent, kept so the pilot can be told about it (#191).
   *
   * **Not a re-derivation.** Every other thing on this screen comes from a frame,
   * and the brief is the one fact no frame carries - the loop narrates phases,
   * turns and gates, never the text it was given. This is the window remembering
   * its own outbound message, read back through `readLaunchArgv` so the reader
   * and the builder cannot drift. An argv it does not recognise leaves this null,
   * which the prompt says out loud rather than papering over.
   */
  const [sentLaunch, setSentLaunch] = useState<Launched | null>(null);
  // There is deliberately no `opening` here any more (#211). It existed to
  // prefill a launch bar with the first thing said to the pilot, and the launch
  // bar is gone: the pilot proposes the run itself, so nothing in this window
  // needs to remember the conversation on its behalf.
  /**
   * The round and token caps in force, or null (#223, `4d`).
   *
   * Read here because a halt banner offering *"+2 rounds and resume"* has to
   * know what it is adding two to. Written as an absolute `7` it would assume
   * the default of 5 and **silently lower** a project configured to 10 — so the
   * offer does not exist until this does, which is the fail-closed direction.
   */
  const [caps, setCaps] = useState<Caps | null>(null);
  /** The gate matrix in force, so `3a`'s footer can say where the run holds. */
  const [gates, setGates] = useState<Readonly<Record<string, string>> | null>(null);
  /**
   * The boundaries in the loop's own order, as `src/gates.ts` declares them.
   *
   * Carried rather than written here, and that is what makes the footer's *next
   * hold* a fact rather than a guess: `GATEABLE`'s comment says *"Order is the
   * loop's, not the alphabet's"*, so a copy on this side would be a second
   * sequence that could disagree with the one the run actually walks.
   */
  const [order, setOrder] = useState<readonly string[]>([]);
  /**
   * What the pilot may do without asking (#223), from the same read. Null until
   * it arrives, which the pane treats as the narrowest answer: everything is a
   * card.
   */
  const [access, setAccess] = useState<host.PilotAccess | null>(null);
  /**
   * Bumped by every save in Settings, so a change there reaches this read —
   * including the pilot's safe list, which an open conversation acts on.
   */
  const [configEpoch, setConfigEpoch] = useState(0);
  useEffect(() => {
    if (repoDir.trim() === '' || !host.inShell()) return;
    let cancelled = false;
    void host
      .config(repoDir)
      .then((frame) => {
        const effective = frame.effective as {
          loop?: Partial<Caps>;
          gates?: Record<string, string>;
        };
        if (cancelled) return;
        setAccess(frame.pilot);
        if (effective.gates !== undefined) setGates(effective.gates);
        setOrder(frame.gateable);
        const loop = effective.loop;
        if (loop === undefined) return;
        const { maxPlanRounds, maxReviewRounds, maxTokens } = loop;
        // All three or none: a partial set would let one button be relative and
        // another be a guess, which is the worse of the two failures.
        if (
          typeof maxPlanRounds === 'number' &&
          typeof maxReviewRounds === 'number' &&
          typeof maxTokens === 'number'
        ) {
          setCaps({ maxPlanRounds, maxReviewRounds, maxTokens });
        }
      })
      // Left null. The banner says it did not read them rather than offering a
      // raise against a number it invented.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repoDir, configEpoch]);
  const [tab, setTab] = useState<
    // Output and Commands are the bottom panel's tabs now (`bottom`, above),
    // not this pane's: both are terminal-shaped, and a dev server's log beside
    // a plan is how an editor arranges them.
    | 'pilot'
    // The four artifact panes (#223). `plans`, `critique` and `review` are what
    // the dashed `Versions` tab was standing in for, and `code` is what `diff`
    // became once a round's own range was on the wire.
    //
    // **`findings` and `diff` are gone rather than kept beside them.** The
    // Findings tab showed the latest round of whichever judge spoke last, from
    // the four counts and a title the wire carries - so a reader asking *why did
    // the loop fix again* got half the evidence and no way to reach the rest. It
    // is one round of `critique` or `review`, both of which now read the report
    // itself. The Diff tab is `code`'s first section, unchanged and still first,
    // because *what has this changed altogether* is a real question - it was
    // just the wrong answer to *what did this round do*.
    | 'plans'
    | 'critique'
    | 'review'
    | 'code'
    | 'verify'
    | 'spend'
    | 'questions'
    // `runs` is `1b`, and it has **no button in the bar** — the same arrangement
    // `settings` has had since the rail landed. It is reached from a project in
    // the sidebar, because what it is *for* is the decision a sidebar row must
    // not make: it states a lock's verdict and confirms a force. Navigation is
    // the sidebar's job and overruling a lock is this screen's, and the reason
    // they are apart is that two places able to force is one too many.
    | 'runs'
    | 'settings'
    // **The pilot, not the output pane** (#211). The complaint was exact: *"I
    // thought my initial prompt would be given to the pilot and the pilot would
    // take control"*, and the app answered it with a form and a tab beside the
    // log. The composer is the front door, so this is where you land — and the
    // output pane has nothing in it before a run anyway.
  >(() => storedWhere().tab);
  /**
   * Which settings the settings screen is showing (#223): the left bar's ⚙ is
   * every project's, a project row's ⚙ is that project's own. Two doors to one
   * screen rather than a switch on it — *"I want the global settings to be
   * accessed via the 'settings' on the left bar… a settings icon on the
   * project dropdown row… where project level settings live."*
   */
  const [settingsScope, setSettingsScope] = useState<'global' | 'project'>('global');
  const openSettings = useCallback((scope: 'global' | 'project') => {
    setSettingsScope(scope);
    setTab('settings');
  }, []);
  /**
   * The round a navigation asked for, or null (#223).
   *
   * **Beside the tab rather than folded into it**, because they answer two
   * different questions and one of them is allowed to be absent: pressing the
   * `Plans` tab is *show me the plans* and the pane's own answer to which one is
   * right — the newest. Clicking a round card is *show me round 2*, and the pane
   * has to be told which.
   *
   * A round number rather than a filename, for the reason on `OpenAt`: both ends
   * already hold the round, and a filename would be a third copy of the loop's
   * naming convention in the one process that cannot be kept in step with it.
   */
  const [openAt, setOpenAt] = useState<number | null>(null);
  const open = useCallback((next: string, round?: number | null) => {
    // A round card's `open verify` and the pilot's `read_command` still name
    // the two panes by their old tab names; they live in the bottom panel now,
    // so opening one opens that panel on it rather than a main tab that is gone.
    if (next === 'output' || next === 'commands') {
      setBottom(next);
      setPanels((p) => (p.bottom ? p : { ...p, bottom: true }));
      return;
    }
    setTab(next as typeof tab);
    setOpenAt(round ?? null);
  }, []);
  /**
   * A brief typed in `1b`, on its way to the pilot (#223).
   *
   * **The composer was the front door and it skipped the pilot entirely**, so a
   * brief typed into it built an argv and started a run: *"in the pilot chat, my
   * request didn't show up and the pilot isn't doing anything."* The intake
   * doctrine existed and nothing was routed through it.
   *
   * Held here because this is the component that owns both — the modal and the
   * pane — and cleared by the pane the moment it has said it, so the same brief
   * cannot be sent twice.
   */
  const [brief, setBrief] = useState<string | null>(null);
  /**
   * Runs asked for and not started yet, and the one on screen (#223).
   *
   * **Pressing start is where a run begins as far as anybody can see**, so the
   * row appears then, under its project, and the conversation that follows is
   * that row's. When the pilot's proposal is pressed and the run says
   * `run_started`, the draft is bound to it and the run adopts the conversation —
   * one row that turns into the run, rather than a second row arriving while the
   * chat that decided it disappeared. See `pending.ts`.
   */
  const [drafts, setDrafts] = useState<readonly Draft[]>(() => {
    try {
      return readDrafts(memory.getItem(DRAFTS_KEY));
    } catch {
      return [];
    }
  });
  /**
   * Bumped when this window's project memory is rewritten outside the sidebar,
   * so the sidebar reads it again rather than drawing what it held (#223).
   */
  const [projectsEpoch, setProjectsEpoch] = useState(0);
  /** The last move, so the new directory's settings can offer the old file. */
  const [moved, setMoved] = useState<{ from: string; to: string } | null>(null);
  const saveDrafts = useCallback((change: (list: readonly Draft[]) => readonly Draft[]) => {
    setDrafts((list) => {
      const next = change(list);
      try {
        memory.setItem(DRAFTS_KEY, JSON.stringify(next));
      } catch {
        // The drafts still work for this session; they will not be back next time.
      }
      return next;
    });
  }, []);
  /**
   * Point the project on screen at another directory, from its settings (#223).
   * `moveProject` decides; this writes the four lists it returns, moves any
   * draft with it, and points the window there. Returns the refusal, or null.
   */
  const relocate = useCallback(
    (to: string): string | null => {
      let moved: ReturnType<typeof moveProject>;
      try {
        moved = moveProject(repoDir, to, {
          projects: readProjects(memory.getItem(PROJECTS_KEY)),
          pins: readPins(memory.getItem(PINNED_KEY)),
          names: readNames(memory.getItem(NAMES_KEY)),
          projectNames: readProjectNames(memory.getItem(PROJECT_NAMES_KEY)),
        });
        if (!moved.ok) return moved.why;
        memory.setItem(PROJECTS_KEY, JSON.stringify(moved.held.projects));
        memory.setItem(PINNED_KEY, JSON.stringify(moved.held.pins));
        memory.setItem(NAMES_KEY, JSON.stringify(moved.held.names));
        memory.setItem(PROJECT_NAMES_KEY, JSON.stringify(moved.held.projectNames));
      } catch (err: unknown) {
        return `this window could not save that: ${err instanceof Error ? err.message : String(err)}`;
      }
      const next = to.trim();
      saveDrafts((list) => list.map((d) => (dirKey(d.dir) === dirKey(repoDir) ? { ...d, dir: next } : d)));
      setProjectsEpoch((n) => n + 1);
      setMoved({ from: repoDir, to: next });
      rememberRepo(next);
      return null;
    },
    [repoDir, rememberRepo, saveDrafts],
  );
  const [draftId, setDraftId] = useState<string | null>(() => {
    // A draft is only restored while it still exists: it may have become a run
    // or been removed in the launch that closed.
    const id = storedWhere().draftId;
    return drafts.some((d) => d.id === id) ? id : null;
  });
  const drafting = drafts.find((d) => d.id === draftId) ?? null;
  useEffect(() => {
    try {
      memory.setItem(WHERE_KEY, writableWhere({ tab, viewing, draftId, bottom, panels }));
    } catch {
      // Storage switched off: the next launch lands on the pilot, as it used to.
    }
  }, [tab, viewing, draftId, bottom, panels]);
  /**
   * The draft whose proposal was pressed, so only ITS run can claim it.
   *
   * A ref rather than a field read off `drafting`, because the thing being
   * guarded against is a run started some other way — a resume from the footer,
   * a run continued into implementation — arriving while a draft happens to be
   * open. Only the pilot's `invoke` sets this, and every other launch clears it.
   */
  const launchedFrom = useRef<string | null>(null);
  /**
   * A brief waiting for its draft's conversation to be on screen.
   *
   * **One commit later, on purpose.** Pointing the pane at a new draft makes it
   * load that draft's (empty) conversation, and a brief handed over in the same
   * render would be sent on top of whatever conversation was on screen before —
   * so the previous chat would ride into the new run's first message. The pane's
   * load runs in a child effect, before this one, so by the time `brief` is set
   * the pane is already holding the right conversation.
   */
  const [queued, setQueued] = useState<string | null>(null);
  useEffect(() => {
    if (queued === null || drafting === null) return;
    setBrief(queued);
    setQueued(null);
  }, [queued, drafting]);
  /** Discard a draft and the conversation kept under it. Nothing on disk. */
  const forgetDraft = useCallback(
    (d: Draft) => {
      saveDrafts((list) => removeDraft(list, d.id));
      try {
        putChat(chatKey(d.dir, d.id), null);
      } catch {
        // Storage off: the conversation was never kept either.
      }
      setDraftId((at) => (at === d.id ? null : at));
    },
    [saveDrafts],
  );
  /** Let go of drafts whose run the archive now draws. Their chat moved already. */
  const settleDrafts = useCallback(
    (ids: readonly string[]) => saveDrafts((list) => list.filter((d) => !ids.includes(d.id))),
    [saveDrafts],
  );
  // The run a draft's proposal started has said who it is: bind the draft to it
  // and let go of the draft, which moves the pilot pane onto the run's key — and
  // that move is a start rather than a click, so the run adopts the conversation.
  const startedId = run.identity?.runId ?? null;
  // The held key goes once the run has an id to adopt into, once it has ended
  // without one, or as soon as the window is pointed somewhere else on purpose.
  const launchSettled = startedId !== null || run.completed !== null;
  useEffect(() => {
    if (launchSettled || viewing !== null || draftId !== null) setHoldChat(null);
  }, [launchSettled, viewing, draftId]);
  useEffect(() => {
    if (startedId === null || drafting === null) return;
    if (launchedFrom.current !== drafting.id) return;
    launchedFrom.current = null;
    saveDrafts((list) => bindDraft(list, drafting.id, startedId));
    setDraftId(null);
  }, [startedId, drafting, saveDrafts]);
  /** Pilot proposals waiting on a person, so a hidden tab can say so (#144). */
  const [proposals, setProposals] = useState(0);
  /**
   * Which providers have a key, read here and nowhere else (#188).
   *
   * Two panes need this fact and each used to fetch its own. The pilot pane is
   * mounted for the whole session and hidden rather than unmounted, so its copy
   * was taken at launch and never taken again: entering a key updated the Keys
   * form, and the pilot went on refusing to let anybody type, correctly
   * according to a snapshot from before the key existed. One reader, one fact.
   */
  const [keyStatuses, setKeyStatuses] = useState<readonly KeyStatus[] | null>(null);
  const [keyFailure, setKeyFailure] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requests = useRef(0);

  const refreshKeys = useCallback(() => {
    void keys
      .status()
      .then((next) => {
        setKeyStatuses(next);
        setKeyFailure(null);
      })
      // The Keys tab shows this and the pilot pane treats it as "no key", which
      // is the fail-closed direction: a request made on an unreadable keychain
      // fails anyway, later, with a worse explanation.
      .catch((err: unknown) => {
        setKeyStatuses([]);
        setKeyFailure(err instanceof Error ? err.message : String(err));
      });
  }, []);
  useEffect(refreshKeys, [refreshKeys]);

  // A local tick, because the heartbeat lands every 30 seconds
  // (`progress.intervalMs`) and a clock that only moved when one arrived would
  // look frozen for half a minute at a time. Every beat re-anchors the turn to
  // the loop's own figure, so this can never drift away from the truth.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const note = useCallback((key: 'log' | 'unknown', text: string) => {
    setWire((w) => ({ ...w, [key]: [...w[key], text].slice(-200) }));
  }, []);

  /**
   * The handler for every action, filled in below the render-time values it
   * closes over and read through a ref here, because the key listener is
   * registered once and a handler table built on one render would be stale on
   * the next.
   */
  const actRef = useRef<Record<ActionId, () => void> | null>(null);
  // Every chord comes from `shell/actions.ts`'s table and is read by
  // `event.code`, so it survives a keyboard layout where the key is not the
  // letter. Escape always leaves, from the window rather than from whichever
  // control happens to have focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setDiagnostics(false);
        setSwitching(false);
        setComposing(null);
        return;
      }
      const id = shortcutFor({ code: event.code, mod: event.metaKey || event.ctrlKey, shift: event.shiftKey });
      if (id === null) return;
      event.preventDefault();
      actRef.current?.[id]();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Re-asked when the panel opens. Uptime is the one fact in it that moves, and
  // a figure measured at connect would be however long ago that was - stated as
  // though it were now.
  useEffect(() => {
    if (!diagnostics || !host.inShell()) return;
    let cancelled = false;
    void host
      .status()
      .then((status) => {
        if (!cancelled) setWire((w) => ({ ...w, status }));
      })
      // Left as it was. A refresh that failed is not a reason to blank four
      // facts the window already has; the panel says when it has none.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [diagnostics]);

  useEffect(() => {
    if (!host.inShell()) return;
    let stop: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      stop = await host.connect({
        frame: (frame) => dispatch(frame),
        unknown: (raw) => note('unknown', JSON.stringify(raw).slice(0, 300)),
        log: (text) => note('log', text),
        exit: (code) => {
          // Never hidden. The run is resumable and the user is the one who has
          // to be told that is what happened.
          setWire((w) => ({
            ...w,
            connected: false,
            hostPid: null,
            failure:
              code === null
                ? 'the host was signalled and reported no exit code'
                : `the host exited ${String(code)}`,
          }));
        },
      });
      if (cancelled) {
        stop();
        return;
      }
      try {
        const status = await host.status();
        setWire((w) => ({
          ...w,
          connected: status.running,
          hostPid: status.pid,
          failure: status.failure,
          uncontained: status.uncontained,
          status,
        }));
        if (status.ready !== null) dispatch(status.ready);
      } catch (err) {
        setWire((w) => ({ ...w, failure: err instanceof Error ? err.message : String(err) }));
      }
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [note]);

  const send = useCallback(
    async (request: object) => {
      setBusy(true);
      try {
        await host.send(request);
      } catch (err) {
        note('log', String(err));
      } finally {
        setBusy(false);
      }
    },
    [note],
  );

  /**
   * Start a run. **The one place this window does that**, and the pilot's
   * `start_run` proposal comes through here rather than sending its own frame
   * (#144) - so the request-id allocation, the column reset and the "one at a
   * time" rule have exactly one definition each. A pilot capability the UI does
   * not also have would be a missing control, which is a design bug rather than
   * a pilot feature.
   */
  const launch = useCallback(
    // `fromDraft` is the draft whose proposal this is, and only the pilot's
    // `invoke` passes one: a resume or an implement is not the run a draft asked
    // for, and must not be the run that claims it (#223).
    (argv: readonly string[], fromDraft: string | null = null) => {
      launchedFrom.current = fromDraft;
      if (fromDraft !== null) saveDrafts((list) => markLaunched(list, fromDraft));
      else setHoldChat(pilotAt.current);
      // A new run is a new column. Appending to the previous one's cycles would
      // draw a single loop out of two runs.
      dispatch({ type: 'reset' });
      // **Point the window at the run it is starting** (#223). `viewing` is
      // where the panes are aimed, and starting a run used to leave it aimed
      // wherever it already was — so a person who had opened a past run from the
      // sidebar and then started a new one got six panes reading the old run
      // while the column narrated the new one. That is exactly what was
      // reported: *"the planner is currently running plan 0, but I see nothing
      // in the output tab… there is nothing under the plan and critiques tabs!
      // No questions either, even though it says three raised."* The Questions
      // **tab** counts the live run and the **pane** was forced to null by
      // `past`, which is why the badge and the pane disagreed.
      setViewing(null);
      setOpenAt(null);
      setLaunched(true);
      const sent = readLaunchArgv(argv);
      setSentLaunch(sent);
      // **And at the repository it is starting in**, which is the same rule one
      // field along (#223). `viewing` was moved above and `repoDir` was not, so a
      // run started somewhere the window was not pointed left the sidebar showing
      // a different project — and since a project section only reads its archive
      // while it is open, that run was not merely in the wrong place in the list,
      // it was never fetched. The pilot's `start_run` carries the directory it
      // was given, so this is the case where the two could differ: open a past
      // run in project B, type a brief, and the run starts in B while the sidebar
      // is still on A.
      //
      // Taken from the argv rather than from a parameter, because the argv is
      // what was actually sent — a second source would be a second answer to
      // which repository this run is in. A null parse leaves it alone: that is an
      // argv this build cannot read, and guessing a directory out of one is worse
      // than pointing at nothing.
      if (sent !== null) rememberRepo(sent.dir);
      requests.current += 1;
      void send({ type: 'invoke', id: requests.current, argv });
    },
    [send, rememberRepo, saveDrafts],
  );

  /**
   * Pick a halted run back up (`4d`).
   *
   * Through `launch`, not beside it: the request-id allocation, the column reset
   * and the one-at-a-time rule keep exactly one definition each, which is the
   * same reason the pilot's `start_run` proposal comes through there (#144).
   */
  /**
   * Take a finished plan-only run into implementation (#223).
   *
   * Through `launch` like every other way a run starts, so the request-id
   * allocation and the one-at-a-time rule keep one definition each. It is a
   * RESUME of that run and not a new one - the core refuses it unless the plan
   * actually cleared critique, and everything the plan phase settled travels
   * with it.
   */
  const implement = useCallback(
    (runId: string, dir: string) => launch(implementArgv(runId, dir)),
    [launch],
  );

  /**
   * Pick a halted run back up, with the column it already had (#223).
   *
   * **A resumed run used to start from an empty column, and that is what was
   * reported:** *"the previous plan, critique, code, etc rounds don't show up on
   * the right bar. I want it to look as I just left it when I stopped the run."*
   * `reduce` builds a `Run` from the frames *this process* narrates, and a
   * resume narrates only what happens from the resume onwards — so a run three
   * plan rounds deep came back showing one, and every earlier round, census and
   * turn was simply gone from the window.
   *
   * So the column is **seeded** with the run's own narration before the loop
   * starts adding to it. The ordering is what makes this safe rather than racy:
   * the replay is fetched and folded *before* the `invoke` is sent, so there are
   * no live frames yet to arrive out of order, and the seed can never land on
   * top of something the loop has already said.
   *
   * The ending is deliberately **not** applied. `useReplay` applies it because a
   * run you opened has ended and must say so; a run you are resuming has not,
   * and seeding `completed` would draw a halt banner over a run that is starting.
   *
   * A replay that fails costs nothing but the history: the resume goes ahead on
   * an empty column, which is exactly what it did before. Losing the seed must
   * never cost somebody the resume.
   */
  const resume = useCallback(
    // `force` last and defaulting to false, so every existing caller sends the
    // ordinary resume: taking a lock somebody may still hold is a decision, and
    // the one screen that can see the lock's verdict is the one that offers it.
    (runId: string, dir: string, raise?: Raise, force = false) => {
      const argv = resumeArgv(runId, dir, raise ?? {}, force);
      if (!host.inShell()) {
        launch(argv);
        return;
      }
      setBusy(true);
      let seed: Run | null = null;
      void host
        .replay(dir, runId)
        .then((got) => {
          // Stripped of the previous ending: a resume has not stopped, and
          // seeding one would draw a halt banner over a run that is starting.
          seed = forResume(foldReplay(got.steps));
        })
        .catch(() => {
          // Deliberately silent. The run is about to start either way, and a
          // failure here means the column begins empty - which is what every
          // resume did until now, not a new failure worth a banner.
        })
        .finally(() => {
          setBusy(false);
          // **`launch` first, and the order is the whole of it.** `launch` opens
          // with `dispatch({ type: 'reset' })`, so a seed dispatched before it
          // is thrown away by the very next action - which is what happened on
          // the first cut of this, and it is invisible because an empty column
          // is exactly what the bug looked like anyway. Both dispatches land in
          // one batch and the reducer applies them in order: reset, then seed.
          //
          // Still before any frame can arrive: `launch` ends at `void send(...)`
          // and the wire delivers asynchronously, so nothing the loop says can
          // be overwritten by this.
          launch(argv);
          if (seed !== null) dispatch({ type: 'seed', run: seed });
        });
    },
    [launch],
  );

  /**
   * Answer a waiting gate.
   *
   * The decision goes over the wire as the host gave us the id, and unnarrowed:
   * `readDecision` in the core is where that vocabulary is defined, and checking
   * it here as well would be a second definition of a legal decision. A
   * pilot-proposed answer carries an `origin` alongside it, which `readOrigin`
   * reads and `state.events` records - the same frame, one field further.
   */
  const answer = useCallback(
    (askId: number, decision: object) => {
      void send({ type: 'answer', id: askId, decision });
    },
    [send],
  );

  /**
   * The two controls hi-fi 18 draws together (#209, #210).
   *
   * Kept side by side here as well as on screen, because the difference is the
   * whole point: `pause` holds at the next boundary and costs nothing, `stop`
   * kills a child that may be forty minutes in. Neither is a kill of the
   * process, and both leave the run resumable.
   */
  const pause = useCallback(() => {
    setPausing(true);
    void host.pause().catch((err: unknown) => {
      // Un-armed on failure. A button that stayed disabled after a request that
      // never landed would be a window claiming a hold it has not asked for.
      setPausing(false);
      note('log', String(err));
    });
  }, [note]);

  const stop = useCallback(
    (reason: string) => {
      setConfirmStop(false);
      void host.cancel(reason).catch((err: unknown) => note('log', String(err)));
    },
    [note],
  );

  // The loop honoured the pause, so the window stops saying it is armed. Told,
  // not guessed: `gate_waiting` carries `requested` precisely so this is not the
  // window deciding a hold must have been the one it asked for.
  useEffect(() => {
    if (run.gate !== null) setPausing(false);
  }, [run.gate]);

  /**
   * Commands this window started (#211).
   *
   * **Held here rather than on `Run`, and the reason is lifetime.** A command is
   * not part of a run: it is started when there is no run at all - *"does the
   * thing you just built start"* is asked after one finishes - and a dev server
   * left up outlives several. On `Run` it would be destroyed by `nextRun`, which
   * would take the card of a process still listening on 5173 with it.
   */
  const [commands, setCommands] = useState(noCommands);
  useEffect(() => {
    if (!host.inShell()) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      stop = await host.onCommandFrame((frame) => {
        setCommands((prev) => reduceCommands(prev, frame));
      });
      if (cancelled) stop?.();
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  // What earlier launches ran (#223), once the host is up. A failure costs the
  // history and says so in the log; this launch's commands are unaffected.
  useEffect(() => {
    if (!wire.connected) return;
    let cancelled = false;
    host
      .pastCommands()
      .then((past) => {
        if (!cancelled) setCommands((prev) => restore(prev, past));
      })
      .catch((err: unknown) => note('log', `earlier commands could not be read: ${String(err)}`));
    return () => {
      cancelled = true;
    };
  }, [wire.connected, note]);

  /**
   * Run one, in the repository this window is pointed at.
   *
   * The **one** sender, exactly as `launch` is: the pilot's accepted proposal
   * and the command bar's own button both arrive here, so a pilot capability the
   * window lacks would be a missing control rather than a special ability
   * (#144). The directory is not a parameter - a command runs where the window
   * is pointed, and letting a caller name one would be a second answer to which
   * repository this is.
   */
  const runCommand = useCallback(
    (program: string, args: readonly string[]) => {
      if (repoDir.trim() === '') {
        note('log', 'no repository is set, so there is nowhere to run a command');
        return;
      }
      void host
        .runCommand(repoDir, program, args)
        .then((frame) => setCommands((prev) => reduceCommands(prev, frame)))
        .catch((err: unknown) => note('log', String(err)));
    },
    [repoDir, note],
  );

  const stopCommand = useCallback(
    (commandId: string) => {
      void host.stopCommand(commandId).catch((err: unknown) => note('log', String(err)));
    },
    [note],
  );

  /**
   * Fire a proposal the user accepted.
   *
   * Nothing here decides anything: the effect was built by `tools.ts` from what
   * the model asked for, and a person pressed a button. This is the routing, and
   * it routes to the same functions the buttons call.
   */
  const onEffect = useCallback(
    (effect: Effect) => {
      if (effect.kind === 'invoke') launch(effect.argv, draftId);
      else if (effect.kind === 'command') runCommand(effect.program, effect.args);
      else if (effect.kind === 'stop_command') stopCommand(effect.commandId);
      else answer(effect.askId, effect.decision);
    },
    [draftId, launch, answer, runCommand, stopCommand],
  );

  const outside = !host.inShell();
  /**
   * The run every disk-reading pane is about.
   *
   * One expression, used by all six, so they cannot disagree about which run is
   * on screen. The live run is the default and an opened one overrides it —
   * and when the live run *is* the opened one, `viewing` is simply redundant
   * rather than wrong.
   */
  // A draft on screen has no run yet, so the panes read nothing rather than
  // whichever run the column happens to hold (#223).
  const shownRunId = viewing?.runId ?? (drafting !== null ? null : (run.identity?.runId ?? null));
  /**
   * The question round the loop is on, through `model.ts` rather than by index.
   *
   * The badge on the Questions tab and the pane behind it read the **same**
   * expression, which is the thing that broke the last time they did not: the
   * tab counted the live run while the pane had been forced to null, so a badge
   * and the pane behind it disagreed about one run and it was reported as two
   * separate bugs.
   */
  const openQuestions = latestQuestions(run);
  /**
   * Which repository those panes read in.
   *
   * **The run's own repository, and `repoDir` only as the last answer.**
   * `run_started` carries `repo` (#223) and it is the authoritative one: it is
   * where the run actually is. `repoDir` is where the *window* is pointed, and
   * the sidebar moves it — opening a run in another project, or adding one,
   * repoints it — so a live run's artifacts were being looked for under
   * whichever project had most recently been clicked. Reading `.vibe/runs/<live
   * id>` under the wrong repository finds nothing, and the pane that finds
   * nothing says *no plans yet*, which is indistinguishable from a planner that
   * has not finished.
   */
  const shownDir = viewing?.dir ?? drafting?.dir ?? run.identity?.repo ?? repoDir;
  // Which conversation the pilot shows: the one on screen, or the one that
  // proposed a launch still waiting for its run id (see `holdChat`).
  const pilotDir = holdChat?.dir ?? shownDir;
  const pilotRunId = holdChat !== null ? holdChat.runId : (drafting?.id ?? shownRunId);
  pilotAt.current = { dir: pilotDir, runId: pilotRunId };
  /**
   * The live run's repository, for the one pane that is always about it.
   *
   * `CodePane` diffs the shas on `Run`, so it has to run those commands in the
   * repository **those shas are in** — `shownDir` would point it at an opened
   * run's repository while it asked about the live run's commits, which is a
   * `git diff` against two objects that are not there.
   */
  const liveRepo = run.identity?.repo ?? repoDir;
  /** Whether what is on screen is a run this window did not narrate. */
  const past = viewing !== null && viewing.runId !== run.identity?.runId;
  // The round cards, built once here and handed to the surfaces that draw them.
  // `rounds()` is a re-shaping of what is already on `Run` - it measures nothing
  // and infers nothing - and one call is what keeps the pilot's log, the report
  // panes and the Code tab from disagreeing about which round a thing arrived in.
  const cards = rounds(run);
  /**
   * The opened run, said again, for the column beside the panes (#223).
   *
   * Asked for only when the window is pointed at a run it is **not** narrating:
   * for the live one the window already has the narration this reconstructs.
   * `run.artifacts.length` re-reads it for the same reason every artifact pane
   * uses it — it counts what the run said it wrote, so a re-read happens because
   * something landed on disk and never on a timer.
   */
  const opened = useReplay(
    past && viewing !== null ? viewing.dir : '',
    past && viewing !== null ? viewing.runId : null,
    run.artifacts.length,
  );
  /**
   * The run the loop column, the round cards and the footer are about.
   *
   * **One expression, so they cannot disagree**, and it is the same `Run` type
   * either way — which is the whole correction to the first attempt at this. A
   * replayed run goes through `reduce` exactly as a live one does, so the column
   * draws it with the same components and *"as if I had run it myself"* is true
   * by construction rather than by resemblance.
   *
   * The live run is what is drawn until the replay arrives, and a replay that
   * failed leaves it there with the failure said beside it — a column showing
   * one run while claiming to show another is the confusion this set out to fix.
   */
  const columnRun = past && opened.run !== null ? opened.run : run;

  /**
   * Every action the shell offers, by id (`shell/actions.ts`). The palette, the
   * keyboard and the activity bar all go through this table, and the type is
   * what makes an entry without a control a compile error.
   */
  const act: Record<ActionId, () => void> = {
    palette: () => setSwitching((o) => !o),
    newRun: () => setComposing({ dir: repoDir, locked: false }),
    toggleSidebar: () => setPanels((p) => ({ ...p, sidebar: !p.sidebar })),
    toggleLoop: () => setPanels((p) => ({ ...p, loop: !p.loop })),
    toggleBottom: () => setPanels((p) => ({ ...p, bottom: !p.bottom })),
    settings: () => openSettings('global'),
    diagnostics: () => setDiagnostics((o) => !o),
    goPilot: () => setTab('pilot'),
    goPlans: () => open('plans'),
    goCritique: () => open('critique'),
    goReview: () => open('review'),
    goCode: () => open('code'),
    goQuestions: () => open('questions'),
    goVerify: () => setTab('verify'),
    goSpend: () => setTab('spend'),
    goOutput: () => open('output'),
    goCommands: () => open('commands'),
    // `1b` in the main pane, which is where a lock can be overruled with a
    // confirmation. Reached from the palette only: the sidebar's per-project
    // link went at the owner's word, and a tab for it is how the bar got to twelve.
    goRuns: () => setTab('runs'),
    pause: () => pause(),
    stop: () => setConfirmStop(true),
    gateContinue: () => {
      if (run.gate !== null) answer(run.gate.askId, { kind: 'continue' });
    },
    gateStop: () => {
      if (run.gate !== null) answer(run.gate.askId, { kind: 'stop', reason: '' });
    },
    backToLive: () => setViewing(null),
  };
  actRef.current = act;
  const paletteShortcut = ACTIONS.find((a) => a.id === 'palette')?.shortcut;
  const paletteChord =
    paletteShortcut === undefined ? '' : chordLabel(paletteShortcut, typeof navigator === 'undefined' ? '' : navigator.platform);

  return (
    <TooltipProvider>
    <div className="flex h-screen flex-col bg-panel text-primary">

      {confirmStop && (
        <StopConfirm
          turn={run.running}
          busy={busy}
          onStop={() => stop('stopped from the window')}
          onPause={() => {
            setConfirmStop(false);
            pause();
          }}
          onKeep={() => setConfirmStop(false)}
        />
      )}

      {composing !== null && (
        <NewWorkstream
          dir={composing.dir}
          // A project's `＋` has already settled this, so the composer states it
          // rather than offering a field. Only the unlocked one can move the
          // window's own repository.
          onDir={(next) => {
            rememberRepo(next);
            setComposing((at) => (at === null ? at : { ...at, dir: next }));
          }}
          locked={composing.locked}
          // The only way out, and the one that spends nothing: the brief goes to
          // the pilot, which reads it, asks about what would change the plan and
          // proposes the run when it is settled (#223). The tab moves with it,
          // because a conversation nobody is looking at is the same as none.
          // **And the row appears now, not when the run starts** (#223). The
          // draft is the run as far as the person is concerned; the core has
          // nothing until the proposal is pressed, and the draft is what the
          // sidebar draws in between.
          onBrief={(message, task) => {
            const draft = newDraft(
              composing.dir,
              task,
              Date.now(),
              Math.random().toString(36).slice(2, 8),
            );
            saveDrafts((list) => addDraft(list, draft));
            setDraftId(draft.id);
            setViewing(null);
            rememberRepo(draft.dir);
            setQueued(message);
            setComposing(null);
            open('pilot');
          }}
          onClose={() => setComposing(null)}
          busy={busy || !wire.connected}
        />
      )}

      {/* ⌘K (`5f`, widened). Every action in the table, and the archive's
          runs. **A pick OPENS a run** - points the window at it, a read - where
          the switcher this replaces resumed one, which was a second place able
          to start a run. Starting stays in `1b` and the pilot. */}
      <Palette
        open={switching}
        onOpenChange={setSwitching}
        actions={available({
          live: run.running !== null || run.preflight !== null,
          gate: run.gate !== null,
          past,
          inShell: !outside,
        })}
        onAction={(id) => act[id]()}
        dir={repoDir}
        onOpenRun={(runId, task) => {
          rememberRepo(repoDir);
          setDraftId(null);
          setViewing({ dir: repoDir, runId, task });
          setOpenAt(null);
        }}
      />

      {/* `7c`, above everything and below the titlebar. It is a statement about
          the whole window - everything under it is as old as the strip says -
          so it cannot sit inside one column. */}
      <StalenessStrip state={staleness(run, now)} hostPid={wire.hostPid} />

      {/* `7e`, above the columns for the same reason: an agent with no headroom
          is a statement about the whole run, not about one pane. Quiet, and
          with no action, because a rate limit asks nobody anything. */}
      <RateLimitStrip wait={run.rateLimit} now={now} />

      {wire.failure !== null && (
        <div className="flex flex-none items-center gap-2 bg-alarm px-5 py-2 text-body-sm text-primary">
          <Badge variant="alarm">no host</Badge> {wire.failure}
        </div>
      )}
      {/* `Status.uncontained` is no longer drawn here: a permanent banner on
          every Linux and macOS launch was removed at the owner's request. The
          field is still read, so it can move into the diagnostics popover. */}

      <div className="flex min-h-0 flex-1">
        {/* The activity bar (the UI rework): VS Code's strip of icons. It is
            where `＋ ⌘K ⚙` live now, at every width - `design/AUDIT.md` §1.1's
            finding was that they had nowhere to live - and its first icon puts
            the sidebar away and brings it back. */}
        <ActivityBar
          sidebarOpen={panels.sidebar}
          onSidebar={act.toggleSidebar}
          onNew={act.newRun}
          onPalette={act.palette}
          onSettings={act.settings}
          paletteChord={paletteChord}
        />
        {/* The three columns, each a resizable region. Sizes are saved on a
            drag and come back next launch (`where.ts`); a shut region is not
            rendered, and the library gives its room to the others. */}
        <ResizableGroup
          id="shell"
          orientation="horizontal"
          className="flex min-h-0 min-w-0 flex-1"
          defaultLayout={panels.sizes['shell']}
          onLayoutChanged={saveLayout('shell')}
        >
        {/* The navigator (#223). **One sidebar, not a rail beside a panel** —
            the two were the same archive twice, reported as *"there are two Runs
            bars on the left now"*. The activity bar is the strip now, and the
            sidebar is a region that can be put away. */}
        {panels.sidebar && (
          <>
          <ResizablePanel id="sidebar" defaultSize="300px" minSize="240px" maxSize="50%" className="flex min-h-0 min-w-0 flex-col bg-column">
          <Sidebar
            dir={repoDir}
            epoch={projectsEpoch}
            drafts={drafts}
            draftId={draftId}
            // Back to a draft's conversation. It has no run to read, so the
            // panes are pointed at nothing and the pilot tab is where it is.
            onDraft={(d) => {
              setViewing(null);
              setDraftId(d.id);
              rememberRepo(d.dir);
              open('pilot');
            }}
            onForgetDraft={forgetDraft}
            onSettled={settleDrafts}
            // The run ON SCREEN, which is what a highlight means (#223). This
            // was the live run, so opening a past one left the highlight on the
            // run you had just left - or on nothing when none was going. A
            // draft on screen is no run at all.
            currentId={viewing?.runId ?? (draftId !== null ? null : (run.identity?.runId ?? null))}
            // A run in THIS project, with the repository already answered. It
            // also points the window there, because the run about to start is
            // the one the panes should be reading.
            onNewIn={(next) => {
              rememberRepo(next);
              setComposing({ dir: next, locked: true });
            }}
            // Points the window at the project first, so the settings shown are
            // the ones for the row that was pressed.
            onProjectSettings={(next) => {
              rememberRepo(next);
              openSettings('project');
            }}
            // Reads only. Points the window at the run and leaves the loop
            // alone — no probe, no lock, no turn.
            onShow={(next, runId, task) => {
              rememberRepo(next);
              setDraftId(null);
              setViewing({ dir: next, runId, task });
              setOpenAt(null);
            }}
            onProject={(next) => {
              rememberRepo(next);
              setDraftId(null);
              // A run in the old project is not a run in this one, and the panes
              // key off the run id alone. Cleared rather than carried.
              setViewing(null);
            }}
            // A deleted run is one the panes must stop reading. Only when it is
            // the one on screen: the sidebar can delete any run in any project,
            // and clearing `viewing` for one nobody was looking at would throw
            // away a reader's place for no reason.
            onDeleted={(deletedDir, deletedRunId) => {
              setViewing((at) =>
                at !== null && at.runId === deletedRunId && at.dir === deletedDir ? null : at,
              );
            }}
          />
          </ResizablePanel>
          <ResizableSeparator orientation="horizontal" />
          </>
        )}

        <ResizablePanel id="center" minSize="30%" className="flex min-h-0 min-w-0 flex-col">
        <ResizableGroup
          id="center"
          orientation="vertical"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          defaultLayout={panels.sizes['center']}
          onLayoutChanged={saveLayout('center')}
        >
        <ResizablePanel id="main" minSize="20%" className="flex min-h-0 min-w-0 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-page" role="main">
          <header className="flex flex-none items-center justify-between gap-4 px-7 pt-6 pb-4">
            <div><p className="mb-1 text-label text-tertiary">{viewing !== null ? 'Run archive' : 'Make room for good work'}</p>
              <h2 className="m-0 text-title font-semibold tracking-tight text-display">{tab === 'pilot' ? 'Your pilot' : tab === 'plans' ? 'Plans' : tab === 'critique' ? 'Plan critique' : tab === 'code' ? 'Code changes' : tab === 'review' ? 'Code review' : tab === 'verify' ? 'Verification' : tab === 'questions' ? 'Questions' : tab === 'spend' ? 'Usage' : tab === 'settings' ? 'Settings' : 'Project runs'}</h2>
            </div>
            <Button variant="quiet" size="sm" onClick={() => setTab('spend')} title="Usage for the live run">
              <Activity size={14} aria-hidden="true" />
              {run.spend.tokens === null ? 'No usage reported' : `${fmtTokens(run.spend.tokens)} tokens`}
            </Button>
          </header>
          {/*
            Hi-fi 1's bar, in the design's own order. It had twelve tabs against
            the design's seven, and `design/AUDIT.md` traced most of that to the
            missing rail rather than to a decision anybody made: `Settings` is
            the rail's `⚙`, `Runs` is the rail plus ⌘K, and `Spend` is a
            readout rather than a tab of its own. The October redesign moves
            that readout into the canvas heading, leaving more room for tabs.

            `Pilot` is first and is where the window lands, which hi-fi 5 says in
            as many words. `Verify`, `Commands` and `Keys` follow the seven: they
            postdate the artwork, so the design cannot be consulted about where
            they go, and putting them after the frames it does name is the least
            it can be wrong by.
          */}
          <nav className="flex flex-none items-stretch gap-0.5 overflow-x-auto border-b border-rule-structure bg-page px-6" aria-label="panes">
            {/* The pilot (#143, #144), and hi-fi 5's first tab. The count is
                proposals waiting on a person, and it is here because a proposal
                nobody sees blocks the conversation silently. */}
            <button
              className={cn(TAB, tab === 'pilot' && TAB_ON)}
              aria-current={tab === 'pilot' ? 'page' : undefined}
              onClick={() => setTab('pilot')}
            >
              Pilot{proposals > 0 ? ` · ${String(proposals)}` : ''}
            </button>
            {/* Output and Commands are the bottom panel's tabs, below. */}
            {/* Hi-fi 3, and it is built now (#223). The tooltip on the tab it
                replaces said *"this window cannot read a run's artifacts"*,
                which was true until the `artifacts` frame landed - a version
                history of an artifact needs the artifacts, and #207 was right
                that reading one is its own decision with #129's link refusal
                attached to it. Both are now on the core side, where they belong. */}
            <button
              className={cn(TAB, tab === 'plans' && TAB_ON)}
              aria-current={tab === 'plans' ? 'page' : undefined}
              onClick={() => open('plans')}
            >
              Plans
            </button>
            {/* The four artifact tabs are in `CycleKind`'s order — plan,
                critique, code, review — which is the loop's own and is the
                order the column beside them draws. Hi-fi 1 names four positions
                here (`Versions · Diff · Findings`) and this build has six, so
                something had to decide the interleaving; making the bar read in
                the same order as the column is a rule, where "keep Diff where
                the artwork put it" would be a coincidence to maintain.

                Where a tab carries a count, that count is **how many things are
                behind it** - rounds, commands, passes. Nothing here badges a
                property of those things, which is the rule the two report tabs
                broke. */}
            {/* **No count on either report tab**, and the reason is what the
                number turned out to say. `Plan critique · 2` was two blocking
                findings, and it was read as two critiques — reasonably, since
                every other count in this bar is how many things are behind the
                tab. A badge whose unit has to be explained is not a badge; the
                counts are inside, on the round they belong to, where `Counts`
                draws all four beside the tolerance that decided them. */}
            <button
              className={cn(TAB, tab === 'critique' && TAB_ON)}
              aria-current={tab === 'critique' ? 'page' : undefined}
              onClick={() => open('critique')}
            >
              Critique
            </button>
            {/* `1d`, per round. The whole-run diff is this pane's first section
                and is still what it opens on before any round has committed. */}
            <button
              className={cn(TAB, tab === 'code' && TAB_ON)}
              aria-current={tab === 'code' ? 'page' : undefined}
              onClick={() => open('code')}
            >
              Code{run.commits.length > 0 ? ` · ${String(run.commits.length)}` : ''}
            </button>
            <button
              className={cn(TAB, tab === 'review' && TAB_ON)}
              aria-current={tab === 'review' ? 'page' : undefined}
              onClick={() => open('review')}
            >
              Review
            </button>
            {/* `1f`. The count is blocking questions, not all of them: an
                advisory question the answerer handled needs nobody, and a
                badge that included it would train you to ignore the badge. */}
            <button
              className={cn(TAB, tab === 'questions' && TAB_ON)}
              aria-current={tab === 'questions' ? 'page' : undefined}
              onClick={() => open('questions')}
            >
              Questions
              {openQuestions !== null && openQuestions.blocking > 0
                ? ` · ${String(openQuestions.blocking)}`
                : ''}
            </button>
            {/* `5d`. The count is verification passes, not gates: the pane's
                subject is the decision in front of you and its trend, and a
                gate count would move for a reason nobody cares about. */}
            <button
              className={cn(TAB, tab === 'verify' && TAB_ON)}
              aria-current={tab === 'verify' ? 'page' : undefined}
              onClick={() => setTab('verify')}
            >
              Verify{run.verify.length > 0 ? ` · ${String(run.verify.length)}` : ''}
            </button>
            {/*
              `5e`, in the place hi-fi 1 puts it: right-aligned in this bar,
              always visible, rather than costing a tab. It is the **readout**
              the design draws and it is also the way in — the pane behind it is
              the per-phase breakdown, and losing that to match a frame would be
              deleting a screen to fix a bar.

              Absent rather than `0 tok` before anything is charged. A run that
              has spent nothing yet has not spent zero; it has not been measured.
            */}
            {/* Usage now lives in the workspace heading, giving the artifact
                navigation its full width. The same pane keeps both providers. */}
          </nav>
          {/* There is no "reading a saved run" strip here any more. The panes
              and the column both follow an opened run (#223), the sidebar
              highlights which run that is, and the footer carries the real
              resume control - so the strip's two buttons were a two-hop link
              labelled `resume it…` that resumed nothing, and a duplicate of a
              sidebar click. Asked to go: "I don't understand… get rid of that
              reading box". The loop column's own `reading` head stays, since
              that is where the one fact worth stating (turn durations are
              missing on a replay) is said. */}
          {tab === 'verify' && <VerifyPane passes={run.verify} />}
          {tab === 'spend' && <SpendPane run={run} />}
          {tab === 'questions' && (
            <QuestionsPane
              questions={past ? null : openQuestions}
              dir={shownDir}
              runId={shownRunId}
              revision={run.artifacts.length}
              // Told by the exit code the run reported, never inferred from the
              // questions: an advisory question the answerer handled leaves open
              // questions on a run nobody is waiting on, and a form beside one
              // would be refused by the core for having no NEEDS-INPUT.md.
              halted={!past && run.completed?.exit === NEEDS_HUMAN}
              busy={busy}
              onResume={resume}
            />
          )}
          {tab === 'settings' && (
            <Settings
              // Remounted per file, so nothing typed into one form survives
              // into the other.
              key={`${settingsScope}:${repoDir}`}
              scope={settingsScope}
              onRelocate={relocate}
              movedFrom={moved !== null && dirKey(moved.to) === dirKey(repoDir) ? moved.from : null}
              dir={repoDir}
              scale={scale}
              onScale={rescale}
              statuses={keyStatuses}
              keyFailure={keyFailure}
              onKeysChanged={refreshKeys}
              limits={limits}
              onLimits={relimit}
              onSaved={() => setConfigEpoch((n) => n + 1)}
            />
          )}
          {/* `1b`, opened from the palette (`goRuns`). The columns the sidebar
              has no room for — status, cost, liveness — and the one control that
              may overrule a lock, which confirms and says what it is overruling. */}
          {tab === 'runs' && (
            <Workstreams
              dir={repoDir}
              onResume={(runId, force) => resume(runId, repoDir, undefined, force)}
            />
          )}
          {/* The four artifact panes. Every one of them reads the run's own
              directory, so all four take the run id the core stated on
              `run_started` - there is no way to derive one, and a pane with no
              run says so rather than showing an empty list. */}
          {/* `run.artifacts.length` is what makes an open pane live (#223). It
              counts what the run SAID it wrote, so a re-read happens because a
              file appeared and never on a timer - and `artifact()` says it after
              the bytes are on disk, so the re-read cannot beat the write. */}
          {tab === 'plans' && (
            <PlansPane
              dir={shownDir}
              runId={shownRunId}
              openAt={openAt}
              revision={run.artifacts.length}
            />
          )}
          {tab === 'critique' && (
            <ReportPane
              dir={shownDir}
              runId={shownRunId}
              kind="critique"
              rounds={past ? [] : cards}
              openAt={openAt}
              revision={run.artifacts.length}
            />
          )}
          {tab === 'review' && (
            <ReportPane
              dir={shownDir}
              runId={shownRunId}
              kind="review"
              rounds={past ? [] : cards}
              openAt={openAt}
              revision={run.artifacts.length}
            />
          )}
          {tab === 'code' && <CodePane run={run} dir={liveRepo} openAt={openAt} />}
          {/* Mounted whatever tab is showing, and hidden rather than unmounted.
              A conversation is state nobody can get back, and a proposal waiting
              on a person would be destroyed by a glance at the output pane -
              which is the one thing this tab must not do. The other two panes
              hold nothing, so they stay conditional. */}
          <div className={cn('min-h-0 flex-1 flex-col', tab === 'pilot' ? 'flex' : 'hidden')} hidden={tab !== 'pilot'}>
            <PilotPane
              run={run}
              launched={sentLaunch}
              // **The run's repository, not the window's** (#223). Every other
              // pane that reads a run moved onto `shownDir` and this one was
              // missed, which is the second-answer-to-which-repository defect
              // AGENTS.md already records, one pane later. It is worse here
              // than on a reader: `dir` is the pilot's PERMISSION BOUNDARY -
              // the directory `claude -p --restricted` is spawned in and the
              // only one it can read - and it is where an accepted
              // `run_command` runs. So opening a run in another project left
              // the pilot reading a different repository from the one on
              // screen, and with no project selected at all it was blocked
              // outright: *"I just tried sending a chat to an old run's pilot
              // but I can't"*.
              dir={pilotDir}
              // Which conversation to show. It follows the run the panes are
              // reading, so opening a finished run brings back the chat about
              // it — and null, before any run, is the conversation that will
              // propose one.
              // A draft's conversation is its own, keyed by the draft id until
              // the run it asked for starts and adopts it (#223).
              runId={pilotRunId}
              access={access}
              // Pointed at rather than started here. `viewing` is set by
              // clicking a row in the archive, and a click is a read — so the
              // conversation must not travel with it, which is what adoption
              // was doing to every run somebody browsed to (#223).
              // A draft counts as pointed-at too: arriving at one restores ITS
              // conversation rather than adopting whatever was on screen, which
              // is what a fresh draft needs. Leaving it for its run is the start.
              opened={holdChat === null && (viewing !== null || drafting !== null)}
              commands={commands}
              onEffect={onEffect}
              ask={brief}
              onAsked={() => setBrief(null)}
              onPending={setProposals}
              limits={limits}
              statuses={keyStatuses}
              // Hi-fi 5's `open verify`. A round card is the round's summary
              // and the pane beside it holds the detail, so the card links to
              // it rather than growing a second copy of that screen - and it
              // names its own round, so the pane opens at the card you clicked
              // rather than at whichever round happens to be newest (#223).
              onOpen={open}
              // The repository, whenever there is no run to watch. Once one is
              // going the pane is a conversation *about* it, and the field is
              // settled — the run is already using that directory, and changing
              // it underneath would point the pilot at a repository the run is
              // not in.
              kickoff={
                (!launched || run.completed !== null) && repoDir.trim() !== '' ? (
                  <Kickoff dir={repoDir} />
                ) : undefined
              }
            />
          </div>
          {wire.unknown.length > 0 && (
            <div className="flex-none border-t border-rule-card px-5 py-2 font-mono text-mono-sm text-emphasis">
              {wire.unknown.length} unrecognised frame(s): {wire.unknown[wire.unknown.length - 1]}
            </div>
          )}
        </div>
        </ResizablePanel>

        {/* The bottom panel (the UI rework): the two terminal-shaped panes,
            docked under the main pane the way an editor docks its terminal, so
            a dev server's log can be read beside a plan. Toggled with the
            `toggleBottom` chord, and opened by anything that names one of its
            two panes through `open()`. */}
        {panels.bottom && (
          <>
          <ResizableSeparator orientation="vertical" />
          <ResizablePanel id="bottom" defaultSize={35} minSize="10%" className="flex min-h-0 min-w-0 flex-col">
            <div className="flex h-8 shrink-0 items-stretch gap-1 border-b border-rule-structure bg-chrome px-2" role="tablist" aria-label="Bottom panel">
              <button
                type="button"
                role="tab"
                aria-selected={bottom === 'output'}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 border-b-2 bg-transparent px-2 text-chip font-bold uppercase tracking-wide outline-none',
                  bottom === 'output' ? 'border-accent text-emphasis' : 'border-transparent text-tertiary hover:text-secondary',
                )}
                onClick={() => setBottom('output')}
              >
                <Activity className="size-3.5" aria-hidden /> Output
              </button>
              {/* The count is what is still RUNNING, not how many have been run
                  (#211). A dev server left up is the fact worth a badge - it is
                  holding a port and it will not stop by itself - and a total that
                  only grew would be the tray-badge failure `4e` names. */}
              <button
                type="button"
                role="tab"
                aria-selected={bottom === 'commands'}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 border-b-2 bg-transparent px-2 text-chip font-bold uppercase tracking-wide outline-none',
                  bottom === 'commands' ? 'border-accent text-emphasis' : 'border-transparent text-tertiary hover:text-secondary',
                )}
                onClick={() => setBottom('commands')}
              >
                <Terminal className="size-3.5" aria-hidden /> Commands
                {running(commands).length > 0 ? ` · ${String(running(commands).length)}` : ''}
              </button>
              <span className="flex-1" />
              <button
                type="button"
                className="my-1.5 flex size-5 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent text-tertiary hover:text-emphasis"
                onClick={act.toggleBottom}
                aria-label="Hide the bottom panel"
                title="Hide the bottom panel"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
            {bottom === 'output' && (
              <OutputPane
                lines={run.output}
                turn={past ? null : run.running}
                staleness={staleness(run, now)}
                // A past run's narration is on disk, in its own transcript. The
                // live run's is on the wire and has never been read from a file.
                transcript={past && viewing !== null ? viewing : null}
              />
            )}
            {bottom === 'commands' && (
              <CommandsPane
                commands={commands}
                dir={repoDir}
                onRun={runCommand}
                onStop={stopCommand}
              />
            )}
          </ResizablePanel>
          </>
        )}
        </ResizableGroup>
        </ResizablePanel>

        {/* `4h`, on the RIGHT since #223. The design puts it on the left and the
            owner moved it, which is a decision about this window rather than a
            correction to the frame: the loop names the rounds the pane beside it
            draws — Plans, Plan critique, Code, Code review — and reading a card
            and then its artifact is the shortest path in the product. The runs
            take the left, next to the rail they are drawn from. */}
        {panels.loop && (
          <>
          <ResizableSeparator orientation="horizontal" />
          <ResizablePanel id="loop" defaultSize="364px" minSize="240px" maxSize="50%" className="flex min-h-0 min-w-0 flex-col bg-column">
          <div className="flex min-h-0 flex-1 flex-col">
            {/* **The column follows the run the window is pointed at** (#223),
                and it is the SAME column. Opening a run used to change six panes
                and leave this one on the live run — *"when I click on an existing
                run, I don't see the right nav update"* — and the first answer to
                that was a summary, a second screen from a second shape, which
                was the wrong answer again: *"I want the right panel to look just
                as it would have when I click on an old run as if I had run it
                myself."*

                So a finished run is fetched as its own **narration** and folded
                through `reduce`, and what is drawn below is `LoopColumn` with a
                `Run` — the same component, the same type, the same cards. The
                objection this overrules is answered rather than dropped: a
                replay would *"report finished work as running"* only if a turn
                could still be open, and every turn in an archive is a turn that
                ended, because `applyCharge` records one when it is charged. */}
            {past && viewing !== null ? (
              <div className="flex flex-col items-start gap-2 p-4 text-body-sm text-secondary">
                <Badge>reading</Badge>
                <span className="text-body text-primary">{preview(viewing.task)}</span>
                {opened.loading && opened.run === null && <p className="m-0">Reading this run…</p>}
                {/* The core's own sentence, verbatim. A run whose id will not
                    join onto a path, a directory vibe refuses to follow (#53)
                    and a `state.json` the validators reject are three findings
                    needing three responses, and *"could not read the run"*
                    answers none of them. */}
                {opened.failure !== null && (
                  <p className="m-0 text-tertiary">{opened.failure}</p>
                )}
                {/* Said once, here, rather than as a blank on every turn row.
                    `state.turnStartedAt` describes the turn in flight, so the
                    only starts an archive keeps are the ones a checkpoint froze
                    — and a duration invented from the gap between two charges
                    would include every gate the loop held at. */}
                {opened.run !== null && (
                  <p className="m-0 text-tertiary">
                    Some turns have no duration: a run records a turn when it is charged, and only a
                    checkpoint keeps the moment one began.
                  </p>
                )}
                <Button variant="quiet" size="sm" onClick={() => setViewing(null)}>
                  back to the live run
                </Button>
              </div>
            ) : (
              <>
                {/* While there is no run, this column is four not-started groups
                    and a sentence saying what it is waiting for — and what it is
                    waiting for is a brief, which is composed next door.

                    The launch form used to live here (#211). It has moved into
                    the pilot pane, because two forms building the same argv is
                    the third spelling that issue warns against, and because the
                    front door being a form beside the conversation is the
                    complaint itself.

                    Offered again once the command has RETURNED, not once the
                    loop said it was done: `serve.ts` runs one at a time and
                    refuses a second invoke until the first settles. */}
                {(!launched || run.completed !== null) && !outside && (
                  <>
                    <div className="mx-4 mb-2 rounded-md border border-rule-card bg-card px-4 py-3.5">
                      <span className="text-body-sm font-medium text-primary">waiting for the brief</span>
                      <p className="mt-1.5 mb-0 text-body-sm leading-relaxed text-secondary">
                        Describe the work to your pilot. Review the brief, then approve its proposal to begin.
                      </p>
                    </div>
                    {/* `4a`, for the one moment somebody is deciding how THIS run
                        should differ from the project's defaults. */}
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mx-4 mb-3 self-start"
                      onClick={() => setComposing({ dir: repoDir, locked: false })}
                      disabled={busy || !wire.connected}
                    >
                      Customize this run
                    </Button>
                  </>
                )}
              </>
            )}
            {/* The counts in the column are controls, and this is where they
                go. The same setter the pilot's round cards use, so a severity
                chip means one thing wherever it is drawn.

                `hostPid` is the live host's, so it is withheld from a run this
                process is not running: a pid beside a finished run would name a
                process that has nothing to do with it. */}
            {/* One scroll for the rail AND the summary. Each used to size
                itself - the rail `flex-1` and the summary by its content - so on
                a finished run the summary's four tiles and its next step took
                the column and left the rail a sliver with `Code review` cut in
                half (reported from a screenshot: "there's a window that's
                totally collapsed"). The footer stays outside, pinned, because
                its one action must never need scrolling to. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <LoopColumn
                run={columnRun}
                now={now}
                compact
                hostPid={past ? null : wire.hostPid}
                onOpen={open}
              />
              {/* `4g`, and only on the ending that means the loop finished.
                  Every other exit is a halt, and a halt gets the footer's
                  banner and its one action rather than a summary of work that
                  stopped early. */}
              {columnRun.completed?.exit === 0 && <Summary run={columnRun} />}
            </div>
            {/* The same footer, about the same run. Its live controls draw
                themselves off `run.completed`, which a finished run has set — so
                stop and pause do not appear beside one, and what remains is the
                ending, the resume and the plan-only offer, which are exactly the
                actions an opened run wants. */}
            <Footer
              run={columnRun}
              busy={busy}
              onDecide={answer}
              onPause={pause}
              onStop={() => setConfirmStop(true)}
              onResume={resume}
              onImplement={implement}
              caps={caps}
              gates={gates}
              order={order}
              pausing={pausing}
            />
          </div>
          </ResizablePanel>
          </>
        )}
        </ResizableGroup>
      </div>

      {/* The status bar (the UI rework): the window's standing facts in one
          row, and the one control a held run needs. The protocol alarm, the
          build stamp and the diagnostics popover moved here from the titlebar;
          the connection dot and the spend readout from the bar above the tabs. */}
      <StatusBar
        outside={outside}
        connected={wire.connected}
        failure={wire.failure}
        project={shownDir.trim() === '' ? null : projectName(shownDir)}
        protocol={run.protocol}
        expected={host.EXPECTED_PROTOCOL}
        run={run}
        busy={busy}
        onDecide={answer}
        onPause={pause}
        onStop={() => setConfirmStop(true)}
        pausing={pausing}
        onSpend={() => setTab('spend')}
        build={wire.status?.build ?? null}
        diagnosticsOpen={diagnostics}
        onDiagnostics={setDiagnostics}
        diagnostics={<Diagnostics status={wire.status} expected={host.EXPECTED_PROTOCOL} identity={run.identity} />}
      />
    </div>
    </TooltipProvider>
  );
}
