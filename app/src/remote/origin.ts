/**
 * The one place the app spells a phone's origin (#344).
 *
 * The desktop's bridge writes `phone:<name>` as the `origin` of every frame a
 * phone sends (`origin_for` in `src-tauri/src/remote/bridge.rs`), so a gate a
 * phone answered comes back on `gate_released` or `gate_stopped` carrying it.
 * `origin.test.ts` reads the prefix out of that file, so a rename on either
 * side fails rather than every attribution silently disappearing.
 */
export const PHONE_ORIGIN = 'phone:';

/** The phone's name, when `origin` is a phone's; null for anything else. */
export function phoneOf(origin: unknown): string | null {
  if (typeof origin !== 'string' || !origin.startsWith(PHONE_ORIGIN)) return null;
  const name = origin.slice(PHONE_ORIGIN.length).trim();
  return name === '' ? null : name;
}
