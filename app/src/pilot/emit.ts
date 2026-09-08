/**
 * A tool channel for a backend that has no tool API (#211).
 *
 * The subscription pilot could not propose anything. Tool declaration is a
 * vendor-API feature, `claude -p` takes no schemas from us, and #193 recorded
 * that as a real limitation the pane said out loud. What it actually meant is
 * that on the **default** backend — the one that needs no key, the one somebody
 * lands on first — the conversation was the front door and could not open it.
 * The launch form beside it was doing the opening, which is the complaint #211
 * exists for: *"I shouldn't have a button to start a run, the pilot should
 * control that."*
 *
 * So the model is given a channel it can reach: a fenced block with a known info
 * string, described to it in the system prompt, parsed back here into the exact
 * `Call` shape a vendor tool call produces. Everything downstream is untouched —
 * `execute` in `tools.ts` settles it, a `proposes` settlement draws the same card
 * with the same argv, and the same person presses the same button.
 *
 * ## Why this is not the English-matching the repo refuses
 *
 * It looks adjacent to it, so the difference is worth stating rather than
 * assuming. #133 exists because a host was picking a run's outcome out of prose
 * written for a human: the sentence was authored for one purpose and read for
 * another, and a wording change silently changed a decision.
 *
 * This is the opposite in both halves. The block is **authored for this reader**
 * — the model is told the exact shape in the system prompt, the same way it is
 * told a JSON schema on the API path — and reading it wrong **decides nothing**,
 * because every tool that acts is propose-only. A misparse produces a card with a
 * visibly wrong argv, or no card at all, and in both cases the run is unchanged
 * until somebody reads it and presses. `src/raise.ts` is the same shape already:
 * declared markers in a markdown file, parsed on resume, refused rather than
 * repaired when they are half written.
 *
 * ## Fail closed, in the direction that costs nothing
 *
 * A block that is not JSON becomes a call whose arguments do not parse, which the
 * pane already draws as a call that cannot be run. A block that names no tool
 * becomes a call `execute` refuses by name, listing the tools that do exist — a
 * message the model can act on next turn. Neither invents a call and neither
 * silently drops one.
 */

/** The info string. Anything else fenced is ordinary code the model wrote. */
export const FENCE = 'vibe-tool';

/** What a block that parsed but named no tool is called, so the refusal can say so. */
export const UNNAMED = '(the block named no tool)';

/** A call lifted out of prose, in the three fields a `tool_call` event carries. */
export interface Emitted {
  id: string;
  name: string;
  /** The `input` object as JSON text, exactly as a vendor streams arguments. */
  arguments: string;
}

/**
 * Every complete block in a reply, in the order they appear.
 *
 * Complete only: a fence that opened and never closed is a turn that ran out of
 * room mid-block, and half a call is not a call. It shows in `visible()` as
 * nothing at all rather than as a proposal built from an argument list that was
 * still being written.
 */
const BLOCK = new RegExp('^[ \\t]*```' + FENCE + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?^[ \\t]*```', 'gm');

/** The same opening, unterminated, so a streaming half-block can be hidden. */
const OPEN = new RegExp('^[ \\t]*```' + FENCE + '[ \\t]*$', 'm');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Read the calls a reply emitted.
 *
 * `turn` seeds the ids, which is what keeps them unique across a conversation
 * without a counter and without randomness — a reducer keyed on ids must never
 * be handed two calls that share one, and `settle` would answer only the first.
 * They cannot collide with a vendor's (`toolu_…`, `call_…`) either.
 */
export function readEmitted(text: string, turn: number): readonly Emitted[] {
  const out: Emitted[] = [];
  BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BLOCK.exec(text)) !== null) {
    const body = match[1] ?? '';
    const id = `emit:${String(turn)}:${String(out.length)}`;
    let envelope: unknown;
    try {
      envelope = JSON.parse(body) as unknown;
    } catch {
      // Kept as a call rather than dropped. The pane draws "its arguments do not
      // parse" and the model is told, which is the only way it corrects itself.
      out.push({ id, name: UNNAMED, arguments: body });
      continue;
    }
    if (!isRecord(envelope)) {
      out.push({ id, name: UNNAMED, arguments: body });
      continue;
    }
    const tool = envelope['tool'];
    const input = envelope['input'];
    out.push({
      id,
      name: typeof tool === 'string' && tool.trim() !== '' ? tool.trim() : UNNAMED,
      // An absent `input` is an empty object, not an error: `read_run` takes no
      // arguments and `readCall` already treats an empty string that way.
      arguments: input === undefined ? '' : JSON.stringify(input),
    });
  }
  return out;
}

/**
 * The reply as a person should read it, with the blocks taken out.
 *
 * The raw text stays in `Reply.text` — that is the record of what the model
 * said, and `transcript.ts` is not allowed to trim it. This is the display, and
 * a proposal card two lines down is a much better rendering of a call than the
 * JSON that produced it.
 *
 * An **unterminated** opening fence takes everything after it too, so a block
 * arriving delta by delta does not spill half-written JSON into the pane and
 * then vanish when it closes.
 */
export function visible(text: string): string {
  BLOCK.lastIndex = 0;
  let out = text.replace(BLOCK, '');
  const open = OPEN.exec(out);
  if (open !== null) out = out.slice(0, open.index);
  // The blank lines the model left around a block are now blank lines around
  // nothing. Collapsed rather than left, so a reply that was mostly calls does
  // not read as a reply with a hole in it.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
