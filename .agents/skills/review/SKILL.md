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
4. **Verify in the parent.** Treat every finding as a hypothesis. Inspect the cited path, exercise the smallest reproducer or replay the relevant fixture, and compare the result to the requirement. Fix confirmed defects, add regression coverage where appropriate, and rerun affected checks. Do not automatically run a second full review for verified localized fixes; run a follow-up review on the incremental diff (plus necessary context) only when fixes introduce new risk or invalidate prior review conclusions.

Report all three categories (use “none” for empty sections):

- **confirmed** — finding, reproduction evidence, fix and validation result.
- **refuted** — finding and the specific counterexample or evidence ruling it out.
- **unverified** — finding, missing evidence, and the next check needed. Do not present it as a defect.
