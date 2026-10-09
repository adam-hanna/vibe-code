# Exit codes

Every vibe command exits with one of eight codes, so a wrapper script can act on the result:

```bash
if vibe run "$(cat brief.md)"; then echo "done"; fi
```

| Code | Name | Meaning | What to do |
|---|---|---|---|
| `0` | OK | Done. For `vibe run`: the plan and the code both cleared review, and every required verification gate passed. For `vibe plan`: the plan cleared critique. Any P1 carried under `loop.p1Tolerance` was fixed in a final round and is listed in `OUTSTANDING.md`. | Read `FOLLOW-UPS.md`, then merge the run's branch. |
| `1` | ERROR | An error: a bad flag, an invalid config, a crash. | Read the message. `transcript.log` in the run directory has the rest. |
| `2` | NEEDS_HUMAN | The run needs you. It stopped for a question, a `stop` gate, a round it could not settle, a turn you stopped, a turn that went quiet for too long, or a turn stopped mid-flight for crossing the token ceiling. | Answer `NEEDS-INPUT.md`, then `vibe resume <run-id>`. |
| `3` | NO_CONVERGENCE | Didn't converge: a round cap was reached, or the findings went in circles. | Read the last critique or review. Decide the disputed point yourself in `NEEDS-INPUT.md`, raise the cap, or change the brief. |
| `4` | BUDGET | A ceiling was reached: `budget.maxTokens`, `budget.maxCostUsd` or `budget.planShare`. | `vibe resume <run-id> --max-tokens <n>` if the work is worth more. |
| `5` | RATE_LIMITED | Rate limited: Claude's window, or Codex's window above `budget.codexLimitPercent`, and the run did not wait. | Resume once the window resets. |
| `6` | PREFLIGHT | A precondition failed before any work was done: an agent's environment is missing a tool in `toolchain`, or `vibe run` was started outside a git repository. | Fix the environment and run `vibe doctor`. `vibe plan` still works outside a repository. |
| `7` | UNVERIFIED | The run finished, but a required verification gate never ran because it had no command. The work, its artifacts and its commits are all there. | Set `verify.command` or `verify.gates`. |

Two of these are not failures. **Exit 2** is how an ordinary long run pauses for you. **Exit 7** means the work is done and reviewed, and only the evidence that it runs is missing.

A run that exits 2, 3, 4 or 5 can be resumed with `vibe resume`. See the [CLI reference](./cli#vibe-resume).
