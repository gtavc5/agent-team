---
name: review
description: Use before committing a non-trivial change or when asked for an independent code review. Delegate a fixed diff to a read-only reviewer and verify its findings before fixing them.
---

# Review

1. **Freeze the scope.** Name the repository, `cwd`, and review scope. Always write the exact diff to a read-only `.patch` file outside the repository (`chmod 444`):
   - **Commit range:** resolve both endpoints to SHAs and write `git diff --binary <before> <after>`.
   - **Branch:** resolve the reviewed branch tip SHA (`<tip>`) and `$(git merge-base <target> <tip>)`, then write `git diff --binary <base> <tip>`.
   - **Working tree edits (unstaged / staged / untracked):** check `git status --short` and write `git diff --binary HEAD` (all tracked edits), `git diff --cached --binary` (staged only), or `git diff --binary` (unstaged only). Untracked files are not in `git diff`: append `git diff --no-index --binary -- /dev/null <file>` (accepting exit code 1) to the patch before `chmod 444` and list their paths in the scope when they belong to the review.
     Do not modify the repository or the patch while the reviewer works.
2. **Delegate with fresh context.** Enable `pi-subagents` if necessary, then call `subagent` with `agent: "reviewer"`, the explicit `cwd`, and a self-contained task. Use fresh context, not `oracle` (which forks the parent context). Give the reviewer the read-only patch path, repository `cwd`, and review scope (plus any untracked file paths in scope), applicable requirements, and project rules—never just a `git diff` command to run (the reviewer has no `bash` tool, and `watchdog_diff` cannot inspect committed ranges), and never the author's reasoning or preferred conclusion. Let Pi route the reviewer; do not pin a model.
3. **Request read-only findings.** Ask the reviewer to inspect the diff and relevant surrounding code, without editing, committing, or starting other agents. Return findings directly to the parent, ranked by severity, each with `file:line`, the failing input or scenario, observed versus required behavior, and a minimal reproduction or test suggestion. Return “no findings” if none.
4. **Verify in the parent and stop.** Treat every finding as a hypothesis. Inspect the cited path, exercise the smallest reproducer or replay the relevant fixture, and compare the result to the requirement. Fix confirmed defects, add regression coverage, and rerun affected checks.

   **Why one round is the default:** Independent review catches author blind spots, not verified fixes. Every extra review round spends user quota and delivery latency with minimal marginal catch rate once targeted tests prove the fix.

   - **Good (stop after 1 round):** Fixing confirmed defects within the reviewed scope (edge cases, guards, CLI/flag regressions, localized refactors) and verifying them with targeted regression tests.
   - **Good (follow-up allowed):** The fix changes the architecture, alters a public/wire contract, or adds a new unreviewed module—or the user/Lead explicitly requests another review.
   - **Bad:** Starting an incremental/follow-up review “just to be safe” after fixing findings that tests already cover, or treating routine multi-line fixes as “new risk”.
   - **Hard redline:** Default to **1** review round; never exceed **2** autonomous rounds. If residual risk cannot be proven by tests, report it under **unverified** for the user/Lead to decide instead of launching another review.

Use the final verification rule in [AGENTS.md](../../../AGENTS.md) after review findings are resolved.

Report all three categories (use “none” for empty sections):

- **confirmed** — finding, reproduction evidence, fix and validation result.
- **refuted** — finding and the specific counterexample or evidence ruling it out.
- **unverified** — finding, missing evidence, and the next check needed. Do not present it as a defect.
