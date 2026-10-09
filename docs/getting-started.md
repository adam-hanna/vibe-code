# Getting started

## Prerequisites

- **Node 20 or newer.**
- **git.** `vibe run` works inside a git repository, because the review reads a diff.
- **The `claude` and `codex` CLIs, installed and logged in.** vibe installs neither. It runs them as child processes, so they use the subscriptions you are already logged into, and npm cannot install them for you. If vibe cannot find one, point `cli.claude` or `cli.codex` at it in your [settings for all projects](./configuration#sections-only-the-global-file-may-set), or set `VIBE_CLAUDE_BIN` / `VIBE_CODEX_BIN`.

## Install

```bash
npm install -g @adam-hanna/vibe-code
vibe doctor
```

The npm package is scoped, but the command is `vibe`. To build from source instead:

```bash
git clone https://github.com/adam-hanna/vibe-code.git
cd vibe-code && npm install && npm run build && npm link
vibe doctor
```

## Check your setup with `vibe doctor`

`vibe doctor` checks that both CLIs are found and logged in. It runs a small probe in each agent's own shell to confirm that the tools each role needs (`git`, and `node`/`npm` for the implementer by default) actually run there. It then prints the configuration a run would use, including the role table and where the loop will pause. Run it before your first run, and again whenever something changes.

It takes the same options as `vibe run`, so `vibe doctor --max-tokens 40000000` shows exactly what that flag would do.

## Your first run

From inside the repository you want changed:

```bash
vibe run "Add rate limiting to the /api/upload endpoint"
```

Or only plan it, and stop once the plan is approved:

```bash
vibe plan "Migrate the session store to Redis"
```

`-C` points at another repository: `vibe run "Fix the flaky auth tests" -C ../my-service`.

While it runs, vibe prints each phase, and a heartbeat line every 30 seconds during a long turn:

```
plan: 4m12s · 23 tool uses · Read src/orchestrator.ts · 340k tok · ctx 31%
```

The run works on its own branch, `vibe/<run-id>`, and commits after every implement and fix round. When it finishes, review the branch and merge it the way you would any other. To throw a run away, delete the branch. Its record stays in `.vibe/runs/<run-id>/`; see [Artifacts](./artifacts).

## Write a good brief

A one-line task works, but a brief works better. The runs that converge quickly have briefs that:

- **state the decisions you have already made**, such as which library, which file, what is out of scope;
- **say "do not re-derive them"**, so the planner spends its effort on the open questions rather than reopening settled ones;
- **say what done looks like**, so the plan's acceptance criteria have something to match.

Write it to a file and pass it in full:

```bash
vibe run "$(cat brief.md)"
```

The runs that stall are usually the ones whose brief left the design open.

## When a run stops for you

Sometimes a run needs a decision only you can make: a question about what you want, a round it cannot settle, or a gate you asked it to stop at. It then exits with code 2 and writes `NEEDS-INPUT.md` in the run directory. The run's id is printed when it stops, and `vibe list` shows it too.

Answer each question in place. Every question has a `### ` heading, and your answer goes in the blockquote under **Your answer:**, with every line starting with `> `:

```markdown
### 1. Should rate limits be per user or per IP?

**Your answer:**
> Per user. Anonymous requests fall back to per IP.
```

Then resume:

```bash
vibe resume <run-id>
```

If the run stopped on its token ceiling, give it more room as you resume: `vibe resume <run-id> --max-tokens 40000000`.

The same file lets you raise a finding of your own, or move the severity of a finding the run is carrying; see [Findings](./how-it-works#raising-a-finding-yourself). In the desktop app, you answer questions on the Questions tab instead of editing the file.
