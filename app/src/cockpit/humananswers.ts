/**
 * What a person answered, read back from the files the loop already keeps (#223).
 *
 * *"A run stopped on a question that only I could answer. I answered, but then my
 * answer was immediately overwritten by some agent's answer."* The run used the
 * person's answer - the planner's revision prompt quotes it, *"Answered by the
 * user"* - but the Questions pane drew each round from `answers-<n>.json`, which is
 * the answerer's turn, and nothing on screen ever read the person's. So once the
 * form went away, the question showed the answerer's own *"defer to the human"*
 * draft, at high confidence, as its answer.
 *
 * The person's answers are already durable: `NEEDS-INPUT.md` while the run is
 * stopped, and `answered-<n>.md` once a resume has consumed it. This reads both,
 * with the core's own format - `### <n>. <question>`, then `**Your answer:**`,
 * then `> ` lines - which `parseHumanAnswers` in `src/cli.ts` defines and
 * `humananswers.test.ts` reads as source, so a change to either side fails here.
 */

const MARKER = '**Your answer:**';

/** The question as both ends hold it: no leading number, no surrounding space. */
export function questionKey(question: string): string {
  return question.replace(/^\d+\.\s*/, '').trim();
}

/** Every answered question in one file. An empty blockquote is not an answer. */
export function parseAnswered(md: string): { question: string; answer: string }[] {
  const out: { question: string; answer: string }[] = [];
  for (const block of md.split(/^### /m).slice(1)) {
    const question = questionKey(block.split('\n')[0] ?? '');
    const at = block.indexOf(MARKER);
    if (at === -1) continue;
    const answer = block
      .slice(at + MARKER.length)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('>'))
      .map((l) => l.replace(/^>\s?/, '').trim())
      .join(' ')
      .trim();
    if (answer !== '') out.push({ question, answer });
  }
  return out;
}

/** The files that can hold a person's answers, in the order they were written. */
export function answerFiles(names: readonly string[]): string[] {
  const answered = names
    .map((n) => /^answered-(\d+)\.md$/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => m[0]);
  return names.includes('NEEDS-INPUT.md') ? [...answered, 'NEEDS-INPUT.md'] : answered;
}

/** Question to answer, across files; a later file wins, being the later answer. */
export function humanAnswers(texts: readonly string[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const text of texts) for (const a of parseAnswered(text)) map.set(a.question, a.answer);
  return map;
}
