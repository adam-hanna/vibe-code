# Building and drawing the desktop app

Part of the working notes for this repo; [AGENTS.md](../../AGENTS.md) is the core and links here.
Moved out of AGENTS.md word for word on 2026-10-20, so where a note says *this file* it means
AGENTS.md and these companions together. Read this before changing the code it describes, and
update it in the same PR when that code changes.

**Verify the app from `npm run app:build`, never from a `cargo build` or `tauri dev`.** This
has now cost time twice, for two different reasons, and both are invisible until you build
properly:

- **Resource paths.** Under a dev build, resources resolve to an ordinary relative path; in a
  bundle they come back as `\\?\C:\...`, which Node refuses as a main module (`EISDIR ...
  lstat 'C:'`). `strip_verbatim` in `src-tauri/src/host.rs` fixes it.
- **`cargo build --release` is still a dev build.** `tauri-build` sets `cfg(dev)` unless the
  build went through `tauri build`, so the exe in `target/release/` loads `devUrl` —
  `http://localhost:1420`. With no Vite server running that is a blank error page, and every
  symptom looks like a broken front end: the window opens, nothing invokes, nothing logs.
  A bundled build is on `http://tauri.localhost/`; check the webview URL first when the app
  seems inert.
- **A blank white window on Linux is the renderer, not the page.** WebKitGTK's DMABUF
  renderer paints nothing under some GPUs - measured on 2026-10-06 on the VMware VM this repo
  is developed on (Fedora 44, X11, webkit2gtk 2.54): three plain launches blank, the previous
  build blank the same way, the same binary painting normally with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`, and the page itself rendering in Firefox. Nothing is
  logged, by either side. `main.rs` sets that variable on Linux before `run()`, and only when
  it is unset, so somebody who needs the renderer on can still say so. It cost half a day as
  a suspected front-end bug, which is why it is here beside the other two.
- **On macOS, a window stuck on `connecting` can be the bundled `node` refusing to run
  JavaScript.** Tauri signs every binary in the `.app` with the hardened runtime, the
  sidecar `node` included, and under it V8 cannot map executable memory without
  `com.apple.security.cs.allow-jit`. The process then dies with SIGTRAP (exit 133) on its
  first line of JavaScript and prints nothing. v1.6.0 shipped that way: `vibe-desktop.log`
  showed the service host start and end *"without an exit code"* 20ms later, and the
  window said *"no host service is running"*. **`node --version` still works**, because it
  runs no JavaScript, so it proves nothing. `app/src-tauri/Entitlements.plist` grants
  `allow-jit` and nothing else, through `bundle.macOS.entitlements`. `release.yml` starts
  the real host from the built `.app` and fails unless it says `ready`. To check a bundle
  by hand: `echo '' | Vibe.app/Contents/MacOS/node
  Vibe.app/Contents/Resources/host/dist/src/hostmain.js` must print a `ready` frame, and
  `codesign -d --entitlements - Vibe.app/Contents/MacOS/node` must list `allow-jit`. The bundle
  is universal (#325, `releases.md`), so run the same line again under `arch -x86_64` for the
  slice an Intel Mac runs, and `lipo -archs` on each file in `Contents/MacOS` must say
  `x86_64 arm64`.

  **A white window from the released AppImage is a second cause with the same symptom**
  (#331). The variable above was set and did not help. WebKit aborted at start-up with
  `Could not create surfaceless EGL display: EGL_BAD_ALLOC. Aborting...`, and the window
  stayed white over a process that was still running. linuxdeploy had bundled the CI
  runner's Ubuntu 22.04 `libwayland-client`, `-cursor` and `-egl`, and the host's Mesa
  could not create a display against them. Builds made on this machine never showed it,
  because they bundle this machine's libraries. `libwayland-server` stays bundled: it is
  not part of the clash, and some hosts with GTK 3 do not have it. `app/scripts/prune-appimage.mjs` repacks the AppImage without them
  and re-signs it, and `app/scripts/smoke-appimage.sh` launches the result on six
  distributions under Xvfb before the release uploads it. The abort reproduces under Xvfb,
  so the check catches it. The script runs locally with podman or docker:
  `app/scripts/smoke-appimage.sh path/to/Vibe.AppImage`. When a Linux window is blank,
  look for an `EGL_BAD_*` line on stderr before suspecting the page.

`npm run app:build` needs Rust on PATH (`~/.cargo/bin`) and runs `stage:sidecar` itself. The
staged tree is ~92 MB of Node plus ~1.5 MB of compiled core, and both are gitignored — they
are copies of things the repo already has.

**A local Linux build bundles the AppImage unstripped, and that is what lets it build at all**
(#324). linuxdeploy runs its own bundled `strip` over every library it copies, and that strip
is older than what Fedora 44 ships: it stops at the first library with a `.relr.dyn` section
(libxml2, libzstd) with `unknown type [0x13] section '.relr.dyn'`, and the build says only
`failed to run linuxdeploy`. `app:build` is `scripts/app-build.mjs`, which sets `NO_STRIP=true`
on Linux unless `CI` is set or `NO_STRIP` already is. The local AppImage is about 163 MB
against CI's stripped 125 MB. It bundles this machine's libraries, so it is for testing this
build and never for handing out: the portable one is CI's, built on Ubuntu 22.04 on purpose.
`CI=true npm run app:build` reproduces the failure.

**The update bundle can be signed and checked locally with a throwaway key**, so a bundling
change can be checked before an rc is tagged. Keep the key out of the checkout:

```bash
npx tauri signer generate --ci -p "" -w /tmp/throwaway.key
TAURI_SIGNING_PRIVATE_KEY="$(cat /tmp/throwaway.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  npm run app:build -- --bundles appimage --config '{"bundle":{"createUpdaterArtifacts":true}}'
```

That writes `Vibe_<v>_amd64.AppImage.sig` beside the AppImage. It is a minisign signature
over the file's BLAKE2b-512, and it verifies against `/tmp/throwaway.key.pub`. It proves the
signing step works, never that the release key does: an installed app trusts only the real one.

`npm run audit:contrast` is the design system's equivalent of `npm test`: it parses
`tokens.css` and checks the two rules the build spec names as most likely to slip — the text
floor across every surface, and the ramps — plus that no hex literal exists outside
`tokens.css`. It takes no dependencies and it should stay that way. The hex check **walks
`src/` rather than naming files**; the named list missed `cockpit.css` the day it appeared,
which is the failure mode of any allow-list somebody has to remember to extend.

**There are two palettes, and every colour check runs on both** (#347). The dark one is
`:root`; the light one is `:root[data-theme='light']` and sets colour tokens only, VS Code's
Light Modern beside the Dark Modern the dark values came from. `appearance.ts` resolves the
choice - light, dark or the system's, per device like the type scale - and the cockpit sets
`data-theme` on the root (`main.tsx` sets the system's before the first paint). Check 0
fails when the light block leaves a dark colour unset, and the severity ramp and the diff
rows are measured as contrast against the panel, which holds on either ground where
luminance does not. **`cn` has to be told the app's font sizes** (`FONT_SIZES` in
`lib/utils.ts`, §11): tailwind-merge read `text-label` as a colour and silently dropped the
`text-on-accent` before it, which was invisible on the dark palette and dark-on-blue on the
light one.

**Its last two sections are a different kind of check and are there for a reason vitest
cannot cover.** §9 and §10 are both about a rule broken by the **absence** of a declaration —
a `button` with no background taking the platform's near-white, and a dialog with no
`max-height` growing past the bottom of the screen — which is invisible to a reader of the
stylesheet and unreachable from a token pairing. They live here rather than in a vitest case
because **vitest stubs a CSS import to the empty string, `?raw` included**, so a test cannot
read a stylesheet at all; this script reads the file. Anything asserting the *content* of CSS
belongs here. Each check reads the file its rule lives in, and moves when the rule does:
§9's reset is Tailwind's preflight since #237, so it checks that `theme.css` imports
`tailwindcss/preflight.css` into the base layer and that the installed preflight still has a
`button` rule clearing the background; §10 reads the `Modal`'s utilities off `Surfaces.tsx`;
§8 reads `--size-*` off `tokens.css`.

**The app draws with Tailwind over the tokens, and there is no other stylesheet** (#231,
#237). `tokens.css` holds every value and is still the only file allowed a hex;
`design/theme.css` maps the tokens into Tailwind's theme *by reference*, imports preflight,
and holds the handful of rules that are global by nature — the page's ground and type, body
`select-none`, focus, the scrollbar, and the one `v-pulse` keyframe. Everything a component
draws is a utility in that component. What it reverses is the original design system's one
rule about itself — *"Class names are `v-` prefixed and flat. No nesting, no CSS-in-JS, no
runtime"*, sixteen primitives in `components.css` — and the reason is the one
`design/AUDIT.md` already gave: composition does not survive being transcribed into a
stylesheet, and 6,589 lines of hand-written CSS had drifted into nine copies of the artifact
pane's layout. Three things the
move had to keep, and did:

- **Preflight came in with the sweep, in `base`, so a utility always wins.** The old resets were
  unlayered, and an unlayered rule beats every layered one whatever its specificity — which
  is how `button { background: none; border: none }` silently erased every new button's
  ground (#231). The few platform defaults the screens were drawn against are put back by
  name in `theme.css` with `revert` (native selects, radios and checkboxes, inline icons,
  placeholder grey, eight-column tabs), and a heading or paragraph that leaned on the user
  agent's weight or margin says so in its own utilities.
- **The off-scale tokens are referenced, not rounded.** `--space-2` is 6px, and the root
  font size is `--type-body`, so `rem` here is 13px — a `px-1.5` or a `pl-10` is not the
  number it looks like. The moved primitives write `px-(--space-2)` and
  `[font:var(--type-mono-sm)]`.
- **`Modal` stayed this repo's own component rather than becoming a radix `Dialog`**, though
  the rework's plan named one. Its safety properties are the point of it — Escape on the
  *window*, no dismiss on a scrim click because every dialog guards something expensive, focus
  to the scrim once on mount, a viewport bound and a body that is the flex item that scrolls —
  and a library dialog closes on an outside click. The command palette *is* a radix dialog
  (`ui/command.tsx`), because it guards nothing.

**The screens the source keeps citing are in `app/src/design/HANDOFF.md`.** Twelve comments
name a frame — `3a`, `4a`, `4h`, `5c`, `6a`, `7a`, `7c`, `7d`, `hi-fi 5`, `hi-fi 11` — and
until it landed, none of those references could be followed from a checkout: `tokens.css`
cites a `Vibe Design Spec.dc.html` this repo has never had. **The annotations are the spec**,
which is why the markdown is worth committing and the artwork is not.

Two things it is not. It is **not the palette** — the wireframe greys and `#5980a6` it lists
are the low-fidelity convention and the document disowns them in its own "Fidelity" section;
`tokens.css` is the design system and the only file here allowed to hold a hex. And it is
**not current**: `7i — Provenance` sorts every frame into *real today* / *app-side* /
*unbuilt*, and every issue that lands moves a name between those. Read that section as a claim
about the day it was written, and check it before building from a frame rather than after.
