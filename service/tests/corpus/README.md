# Offline pilot corpus

`anon-pilot.jsonl` is one JSON record exported from a local YAAT cache and a contiguous run of UI telemetry. It retains two active sessions, three archived worktrees, absent `attention.lastResult`, one cached reply with 35 events, and 32 actions dominated by `workspace.switch` and `chat.send`. The action rows do not identify the sessions, prompts, or replies, and are not backend frames. The stability pilot uses their switch frequency to choose a short repeated switch path, and the cache to restore archive/history structure. The Pi foreground-subagent tape supplies actual RPC input for the separate trace replay. The queue pilot drives the real browser and Hub with the recorded non-steerable Pi queue tape, holding replies until the user has acted.

To export a different slice, pass zero-based positions in `.agent-team/cache/index.json` and optionally `workspace-ordinal:message-seq` selectors for history rows:

```sh
npm exec -- tsx scripts/export-anon-corpus.ts "$YAAT_BASE" new-slice.jsonl 0,2,3 3:5
```

The base directory contains `.agent-team/cache/` and `telemetry.db`. The exporter opens SQLite read-only and refuses to overwrite output. It keeps field presence, nesting, array order, approved enums and structural numbers (including original timestamps), and UTF-16 string lengths. It assigns ordinal aliases to identities and unknown keys, masks freeform strings, and zeroes opaque numbers. Both the exporter and tests verify the serialized shape against an allowlist. The result is a structural fixture, not a session backup. Review the exact timing and other retained structure before sharing a new export; redaction does not erase activity patterns.

## Duration references

On Linux with Node 26 and warm browser assets, root Fast took 11–15 seconds and root Slow took 213 seconds including real offline Pi. The reference budgets are 25 seconds and 270 seconds respectively. These are wall-clock warnings, not assertions; cold builds, CPU contention and OS differences can change the measurements.

## Queue mock equivalence

| Regression guard                                                                             | Replacement or remaining coverage                                                                                                                                                                                     | OS coverage                                                     |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Queued badge, dimming class, and Remove targets the selected message (`components.test.tsx`) | `journey-pilot-queue`: exact queued row shows badge and class; clicking Remove makes only that row disappear, leaves the other queued, and never dispatches the removed prompt. This replaces the callback-only test. | Linux + Windows, same Chromium chain in CI; also Fast and Slow. |
| Steered ownership/authoritative clears (`liveness.test.tsx`, `components.test.tsx`)          | Keep. The queue pilot covers non-steerable cancellation and final hydration, not steering or explicit `queuedFor: null`/`steering: false` transitions.                                                                | Linux + Windows unit tests.                                     |
| Older loaded pages survive a latest-page merge (`stream.test.ts`)                            | Keep. The queue pilot checks a refreshed latest page, not pagination or older retained pages.                                                                                                                         | Linux + Windows unit tests.                                     |

Regression checks during development: suppressing the Hub-to-browser `message_removed` frame left `Third prompt.` visible and the queue pilot failed at its removal assertion. Adding a 1 px right margin to the message column changed its measured width from 974 to 973 CSS pixels and failed the subagent pilot. The passing fixtures contain neither fault injection.
