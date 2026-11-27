# YAAT repository guide

YAAT is a self-hosted panel for Pi RPC and native Codex app-server sessions. Older backend histories are read-only. `service/` owns runtime, delivery and persistence; `webview/` renders the WebSocket projection; `shared/` holds contracts used by both; `scripts/` owns operational tooling.

## Invariants

- Use Node.js 26+ and install workspaces from the repository root. Do not add `"type": "module"` to the root package: `dist/server.js` is CommonJS.
- Do not restart, kill, or deploy the live service from a session without explicit permission in the current request. An authorized staged deployment must use `scripts/yaat-service.sh deploy-deferred --when-idle`; see the deploy skill. Do not match server processes with `pkill -f`; target a specific PID when authorized.
- Run affected tests during development. After review, run `npm run test:fast`, `npm run test:slow`, and `npm run build` on the final candidate. Add a regression test for each behavior change. Do not skip a failing test.
- Read the event path end to end: session → workspace → WebSocket → client state → renderer. A continuously connected browser and a fresh snapshot should show the same transcript and queue affordances. Use recordings for backend frame shape and order; never invent them. Explain any snapshot change before regenerating it.
- Use real-account captures and smoke tests sparingly, one at a time. Prefer existing fixtures or deterministic offline tests; live sessions spend the user's quota.
- Keep changes small and reversible. Clean up references to behavior you replace, across code, tests, documentation and skills. Preserve the existing UI layout unless asked to change it; follow [docs/UI_ZEN.md](docs/UI_ZEN.md) for `webview/` UI changes, and state the host surface (trigger, reading location, and reused primitive) when a task changes visible UI or interaction. Comment non-obvious constraints, not the edit itself.
- Commit and push only when requested. Review non-trivial diffs independently before committing (review skill). Use an imperative conventional commit subject. Keep `main` linear: integrate branches with rebase + `git merge --ff-only`, cherry-pick, or squash; do not create merge commits on `main`.

## Test tiers

- **Fast — usability (`npm run test:fast`):** Fail when the user cannot send, receive, Stop, cancel, switch sessions, or reconnect. Run service and webview tests in parallel. Run journeys in Node and jsdom; do not launch Chromium. Target 5 seconds typical and 10 seconds at the 99th percentile. To filter by file, run `npm run test:fast -w <service|webview> -- <file>`.
- **Slow — stability (`npm run test:slow`):** Run checks, stability unit tests, the browser suite, and the subagent and Demo browser journeys. Preserve exact geometry, theme contrast, reading continuity, bounded DOM and retained state, archive/worktree stress, and legacy cache recovery. Install Chromium with `npx playwright install chromium`. Target 180 seconds typical and 270 seconds at the 99th percentile. Report factual durations; do not warn or fail on tier duration drift or use retries to hide failures.
- **CI — reliability (`npm run test:ci`):** Run the same recorded and offline tests on Linux and Windows, including both Chromium pilots, offline Demo and browser journeys, and deterministic Stop/crash/file-lock cases. On Linux, run real offline Pi after the common tests and separately verify that a missing Pi fails closed. Each CI job has a 10-minute hard limit including setup.
- Put deliberate user interrupt and abort in Fast and cross-platform CI. Put a single deterministic crash, nonzero process exit, or disconnect and recovery in Fast and cross-platform CI. Keep crash storms, repeated or mid-write kills, and orphan or leak stress in Slow only. Reduce each confirmed race to one reproducible Fast and CI regression.
- Use recorded backend frames, anonymized cache shapes and replayed user actions for behavior chains. Before removing a mock, record its regression guard, equivalent replacement and OS coverage. See [the pilot corpus](service/tests/corpus/README.md).

## Skills

Read these when their boundary applies:

- `.agents/skills/deploy/SKILL.md` — before building, scheduling a deployment, or checking whether production restarted.
- `.agents/skills/capture-sdk/SKILL.md` — when backend emission order or shape matters; use a recorded Pi/Codex fixture.
- `.agents/skills/stream-debug/SKILL.md` — before changing session/workspace/client event projection or investigating a transcript rendering issue.
- `.agents/skills/add-model/SKILL.md` — before editing `service/src/config/presets.ts`.
- `.agents/skills/review/SKILL.md` — before non-trivial commits and for independent review.
