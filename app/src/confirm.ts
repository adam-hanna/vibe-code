import { confirmOnDevice } from './transport';

/** What an act refused on the device says (#346). */
export const NOT_CONFIRMED = 'Not confirmed on this phone.';

/**
 * Ask the person holding the device before an act that cannot be taken back
 * (#346), and refuse the act when they do not confirm. Resolves at once on the
 * desktop.
 */
export async function confirmed(reason: string): Promise<void> {
  if (!(await confirmOnDevice(reason))) throw new Error(NOT_CONFIRMED);
}
