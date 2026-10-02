# Workspace design

The October 2026 redesign replaces the original visual direction in HANDOFF.md.
The historical handoff and audit remain useful records of behavior and evidence;
their old composition, palette, typefaces, and square controls are superseded.

The workspace uses warm charcoal surfaces, a soft lime accent, rounded controls,
and readable system typography. The welcome headline pairs the sans serif with
an editorial serif. Fonts and icons work offline; there are no external assets.
Colors remain centralized in tokens.css and still pass the contrast audit.

The main canvas gets the most room. Projects occupy a 240px sidebar and run
history occupies a 320px overview. Both retain their collapsed controls. Artifact
navigation stays in the canvas, with usage in its heading rather than taking
space from the tabs. Narrow windows can scroll that navigation; short windows
use compact prompt cards. Long documents and dialogs retain independent scroll.

The welcome gives three useful prompts. Selecting one fills and focuses the
composer; it sends nothing. A new run's form says **Discuss with pilot**, because
that action opens a conversation and the run starts only after approval of a
proposal. Pause and stop appear only once there is an actual run or preflight.
Chat auto-follow starts with the first log entry, so it cannot hide the welcome.

Restoring a saved chat marks its existing tool results as seen and its usage as
historical. Reopening therefore starts no vendor turn and adds no past usage
to today's ledger. A reply's timestamp distinguishes reused turn ids across
window launches; new tool results still continue an attended conversation.

The run's measurements, provenance, missing-data explanations, gate behavior,
archive navigation, and destructive confirmations keep their existing contracts.
No progress, elapsed time, model, or cost is invented for presentation. The four
overview groups keep their pairing and round navigation; headings do not imply
that revisiting a group is advancing through a fixed pipeline.

workspace.css composes the existing components. tokens.css owns color and type;
Icon.tsx owns the small SVG icon vocabulary and brand mark. The original CSS
keeps the underlying component structures and their documented history.

Verification includes the contrast audit, web and Rust suites, the packaged
Tauri build, and browser checks at desktop and compact sizes. Existing source
checks in composer, frontdoor, opened-run, and squares were updated because they
pinned the previous copy or usage location. Their original behavior checks remain:
typing is always available, sending has one guard, starting requires approval,
missing chats are named, usage is absent until reported, and navigation order
is preserved. welcome.test.ts additionally renders the footer to check that
empty workspaces have no process controls while preflight and live turns do.

Build the core explicitly before packaging or testing if npm has
`ignore-scripts=true`: that setting skips the root test suite's pretest hook,
and staging an older dist/ can leave a new window speaking to an older host.
Vite excludes src-tauri/ from its watcher so a simultaneous Windows package
build cannot stop the preview by locking an executable it tries to watch.
