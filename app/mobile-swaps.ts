/**
 * The modules the phone build replaces (#345), and nothing else.
 *
 * Each entry is a desktop module under `src/` and the file that takes its place
 * when Vite builds with `--mode mobile`. The engineering design's desktop-only
 * pieces are exactly these: where commands go (`transport`), the folder chooser
 * (`pick`), the keyboard and the palette (`surface`), and what is drawn first
 * (`boot`: the paired desktops and the lock, #346). Everything else - the
 * cockpit, `model.ts`, every reducer and test - is the same source on both.
 *
 * A list rather than a naming convention, so a stray `*.mobile.ts` cannot swap
 * itself in unnoticed: `mobile-swaps.test.ts` fails on a mobile file this list
 * does not name, and on an entry whose files do not both exist.
 */
export const MOBILE_SWAPS: Readonly<Record<string, string>> = {
  'src/transport.ts': 'src/transport.mobile.ts',
  'src/surface.ts': 'src/surface.mobile.ts',
  'src/cockpit/pick.ts': 'src/cockpit/pick.mobile.tsx',
  'src/boot.tsx': 'src/boot.mobile.tsx',
};
