import * as host from './host';
import { flushMemory, loadMemory, memory, memoryChanged } from './memory';
import { chatChanged } from './pilot/chatstore';
import { keepLedgerIn } from './pilot/ledger';

/**
 * Listen for other clients' writes, then read the window's memory (#223, #354).
 * Shared with the phone, which does this once it has a desktop to read from.
 */
export async function prepareCockpit(): Promise<void> {
  // Another client's writes (#354), listened for BEFORE the memory is read, so
  // one landing while it loads is remembered and read again rather than
  // missed. Awaited: the listener is live before the snapshot is asked for.
  if (host.inShell()) {
    await host.onChanged((c) => {
      if (c.what === 'memory') void memoryChanged(c.key);
      else if (c.what === 'chat') void chatChanged(c.key);
    });
  }
  // The window's memory is read before the cockpit exists (#223, `memory.ts`):
  // every setting is read synchronously at mount, and a mount that ran first
  // would draw defaults and then save them over what was stored.
  await loadMemory();
  keepLedgerIn(memory);
  window.addEventListener('pagehide', flushMemory);
}
