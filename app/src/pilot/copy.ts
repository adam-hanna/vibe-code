import { splitBrief } from '../cockpit/argv';
import { visible } from './emit';
import type { Reply } from './transcript';

/**
 * What each half of an exchange copies (#256), or null where there is nothing
 * to copy and so no control.
 *
 * **Yours is what you typed, byte for byte**, newlines included, because those
 * are the reason shift+enter exists - and only that: the new-run dialog's
 * settings ride under a brief for the model and are drawn as chips (#258), so
 * they are not copied as though you had written them.
 *
 * **The pilot's is its Markdown source, not the page it renders as.** The pilot
 * writes Markdown and somebody copying a reply is usually pasting it somewhere
 * that reads Markdown too - an issue, a doc, another chat - so a fence, a list or
 * a table survives the trip. It is `visible`, exactly what the pane draws: a
 * tool call the subscription backend emitted is a fenced block in the raw text,
 * and the proposal card is the rendering of it, so copying the JSON would hand
 * over something the screen deliberately does not show.
 *
 * Whitespace alone is nothing to copy. A turn still thinking has no text yet,
 * and a control that copied an empty string would empty the clipboard of
 * whatever the person had on it.
 */
export function copyOf(reply: Pick<Reply, 'asked' | 'text'>): { asked: string | null; said: string | null } {
  const said = visible(reply.text);
  const asked = reply.asked === null ? null : splitBrief(reply.asked).brief;
  return {
    asked: asked !== null && asked.trim() !== '' ? asked : null,
    said: said.trim() !== '' ? said : null,
  };
}
