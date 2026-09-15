/**
 * Filling in `NEEDS-INPUT.md` from somewhere that is not a text editor (#223).
 *
 * **The window could show the questions and could not answer them.** The footer
 * said *"Answer the questions in NEEDS-INPUT.md, then resume the run"* — which
 * is the CLI's instruction, correct there and absurd in a GUI that is already
 * displaying the questions: *"It says I need to answer the questions in
 * needs-input.md but thats crazy, I should answer directly in the app on the
 * questions page."*
 *
 * ## It writes the file the parser already reads, rather than a second road in
 *
 * The tempting shape is a frame carrying answers straight into `state`, and it
 * would be a second definition of what an answer is — one that skips
 * `parseHumanAnswers`, skips the `stalled-`/`answered-` retirement, and skips
 * the raise and severity-move blocks that live in the same file. `resumeRun`
 * would then have two ways to be given answers and they would drift on the next
 * change to either.
 *
 * So this fills in the blockquote the template already leaves empty, and the
 * resume that follows is the ordinary one. **Everything downstream is untouched
 * and cannot tell the difference**, which is the whole point: a person typing
 * into the app and a person typing into vim produce the same file.
 *
 * ## Matched on the question text, which is what both ends already hold
 *
 * `writeEscalation` renders `### <n>. <question>` and `parseHumanAnswers` reads
 * the question back off that line, so the text is the key both sides already
 * agree on — no index, no id. An index would be a third thing to keep in step,
 * and it would silently answer the wrong question the first time a round's
 * questions were reordered.
 *
 * A question this does not recognise is **left alone**, not appended: the file
 * is the record of what was asked, and adding a heading for something nobody
 * asked would put a question in the planner's mouth.
 */

/** One answer, as the window collected it. Only the two fields it can know. */
export interface FilledAnswer {
  question: string;
  answer: string;
}

/** What a fill did, so a caller can report it rather than assume it. */
export interface FillResult {
  md: string;
  /** How many questions got text. Never how many were asked. */
  filled: number;
  /** Questions this was given that the file does not ask. Reported, never added. */
  unmatched: readonly string[];
}

/**
 * The marker the template writes and the parser looks for.
 *
 * One constant, used by the test that drives this function's output through
 * `parseHumanAnswers` — which is the only check that actually matters here, and
 * is stronger than either side matching a format written down in a comment.
 */
export const ANSWER_MARKER = '**Your answer:**';

/** The heading text of a `### <n>. <question>` line, as the parser reads it. */
function headingQuestion(line: string): string {
  return line.replace(/^###\s+/, '').replace(/^\d+\.\s*/, '').trim();
}

/**
 * Render one answer as the blockquote the parser expects.
 *
 * Every line is prefixed, because `parseHumanAnswers` keeps only lines starting
 * with `>` — an answer with a paragraph break would otherwise lose everything
 * after it, silently, which is the worst way for this to fail. Blank lines
 * become a bare `>` so the block stays one quote rather than two.
 */
function quote(answer: string): string {
  const body = answer.replace(/\r\n/g, '\n').trimEnd();
  if (body.trim() === '') return '> ';
  return body
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line.trim()}`))
    .join('\n');
}

/**
 * Put the answers into the file, and say what was placed.
 *
 * Pure: the caller does the reading and the writing, so a test drives this with
 * a string and the round-trip check needs no filesystem.
 */
export function fillAnswers(md: string, answers: readonly FilledAnswer[]): FillResult {
  // By question text, last one winning, which is what a form that let somebody
  // edit the same field twice would mean.
  const wanted = new Map<string, string>();
  for (const a of answers) {
    const key = a.question.trim();
    if (key !== '' && a.answer.trim() !== '') wanted.set(key, a.answer);
  }

  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const used = new Set<string>();
  let current: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // A new heading closes whatever question was open, including the headings
    // this file uses for findings and raises - those carry no answer marker, so
    // the effect is only to stop a later marker being attributed to the wrong
    // question.
    if (line.startsWith('### ')) current = headingQuestion(line);
    out.push(line);

    if (line.trim() !== ANSWER_MARKER || current === null) continue;
    const answer = wanted.get(current);
    if (answer === undefined) continue;

    // Take the template's existing blockquote - which is a blank `> ` line, and
    // is what a re-answer would find already filled - and replace the whole of
    // it. Anything that is not a quote line ends the block and is left where it
    // is.
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? '').trim() === '') {
      out.push(lines[j] ?? '');
      j += 1;
    }
    while (j < lines.length && (lines[j] ?? '').trim().startsWith('>')) j += 1;
    out.push(quote(answer));
    used.add(current);
    i = j - 1;
  }

  return {
    md: out.join('\n'),
    filled: used.size,
    unmatched: [...wanted.keys()].filter((q) => !used.has(q)),
  };
}

/**
 * Whether a file still has an unanswered question in it.
 *
 * Used to refuse a resume that would stop again immediately: `parseHumanAnswers`
 * returns only the blocks that have text, so a partially filled file resumes,
 * spends a preflight, and halts on the same question. The window can say so
 * before any of that.
 */
export function unanswered(md: string): readonly string[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const open: string[] = [];
  let current: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('### ')) current = headingQuestion(line);
    if (line.trim() !== ANSWER_MARKER || current === null) continue;
    let j = i + 1;
    let text = '';
    while (j < lines.length && (lines[j] ?? '').trim() === '') j += 1;
    while (j < lines.length && (lines[j] ?? '').trim().startsWith('>')) {
      text += (lines[j] ?? '').trim().replace(/^>\s?/, '');
      j += 1;
    }
    if (text.trim() === '') open.push(current);
  }
  return open;
}

