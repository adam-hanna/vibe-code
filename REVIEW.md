# Review standards for this repository

These are this repository's own rules, and they add to vibe's review instructions. They come from
the code-style and test rules in `AGENTS.md`. They say what to flag, not how to build. Severities
are the floor for a confirmed case. Raise one higher when the concrete failure is worse.

## Measurements

- **An invented number is a P1.** This is the repository's one recurring rule. An unknown value
  stays `null`, absent or "not reported". It is never guessed from a model name, derived from a
  price table, or filled in to make a field complete. Flag any figure the code cannot trace to
  something it measured or read.
- **A proxy dressed as another measurement is a P1.** A proxy is allowed if its wording says what
  it actually counted (see `src/work.ts`: "9 of the 14 files the plan names", never `step 9/14`
  or a `%`). Flag a label, a field name or a sentence that lets a counted thing read as a
  different quantity.
- **Not failing closed is a finding.** If an input cannot be read, it is absent, never zero. A
  measurement that cannot be attributed is not recorded. A guard that cannot decide refuses rather
  than allows. Flag any path where an unreadable, missing or malformed input becomes a confident
  answer.

## Tests

- **Editing a test so that it passes is a P1.** When a test breaks, there are two legitimate
  answers. Either the change broke something, so fix the code, or the test's claim is no longer
  the contract, so rewrite the test and keep every part of the claim that still holds. A test
  edited into green without saying which of the two it was destroys the signal that would have
  caught the regression.
- **A PR that changes an existing test must say which case it was, and the evidence.** A changed
  test with no such statement is a finding. So is a deleted case without a reason.
- **Wall-clock fixtures.** A hard-coded epoch timestamp or date in a test passes until it doesn't.
  Times are computed relative to now.
- **Network or real agents in tests.** Tests use the injection points (`tests/helpers/fake-transport.ts`,
  `tests/helpers/stub-server.ts`, `tests/helpers/loop-harness.ts`). A test that reaches the network
  or spawns a real `claude` or `codex` is a finding.
- **A wait on a child process must be able to say which way it failed.** "Ended before it wrote"
  and "wrote nothing within the deadline" are different findings. Flag:
  - a fixed sleep used as a wait;
  - a raised timeout offered as a fix;
  - a process that never exits being stopped at the end of the test body rather than in `t.after`.
- **A fixture that shells out says what the command said.** Flag captured stderr thrown away
  (`stdio: 'ignore'`), and flag a retry around a command whose second run would not leave the
  same state.
- **Temporary files go under `os.tmpdir()`.** A hard-coded `/tmp`, or a child spawned with a
  hand-built environment that drops `TMPDIR`, leaks out of the suite's sandbox.

## Code

- **No `any` in `src/`.** Use `unknown` and narrow it. `src/validate.ts` has the vocabulary.
- **Stripped "why" comments are a finding.** A comment that records what was measured to pick a
  number, or the run that taught a rule, is the repository's institutional memory. Flag a removal
  or a rewrite that loses the reason, even when the code beside it is fine.
- **Internal imports go through `@src/*`, with explicit `.js` extensions, and `import type` for
  type-only imports.** The compiler catches most of this. Flag what it does not.

## Findings themselves

- **A finding about behaviour cites a file and line.** The citation has to point at code that
  shows the defect, not just the area. A behaviour claim with no citation a reader can open is a
  finding about the finding, so lower its weight accordingly.
