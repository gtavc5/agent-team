# Offline pilot corpus

`anon-pilot.jsonl` is one JSON record exported from a local YAAT cache and a contiguous run of UI telemetry. It retains two active sessions, three archived worktrees, absent `attention.lastResult`, one cached reply with 35 events, and 32 actions dominated by `workspace.switch` and `chat.send`. The action rows do not identify the sessions, prompts, or replies, and are not backend frames. The stability pilot uses their switch frequency to choose a short repeated switch path, and the cache to restore archive/history structure. The Pi foreground-subagent tape supplies actual RPC input for the separate trace replay. The queue pilot drives the real browser and Hub with the recorded non-steerable Pi queue tape, holding replies until the user has acted.

To export a different slice, pass zero-based positions in `.agent-team/cache/index.json` and optionally `workspace-ordinal:message-seq` selectors for history rows:

```sh
npm exec -- tsx scripts/export-anon-corpus.ts "$YAAT_BASE" new-slice.jsonl 0,2,3 3:5
```

The base directory contains `.agent-team/cache/` and `telemetry.db`. The exporter opens SQLite read-only and refuses to overwrite output. It keeps field presence, nesting, array order, approved enums and structural numbers (including original timestamps), and UTF-16 string lengths. It assigns ordinal aliases to identities and unknown keys, masks freeform strings, and zeroes opaque numbers. Both the exporter and tests verify the serialized shape against an allowlist. The result is a structural fixture, not a session backup. Review the exact timing and other retained structure before sharing a new export; redaction does not erase activity patterns.

## Published journey slice

`anon-journey.jsonl` retains 31 approved actions in order (26 switches and 5 sends) and 11 row kinds from three locally cached session histories. It contains only public enum strings in two arrays. The strict schema accepts no timestamps, identifiers (including aliases), paths, free text, or other metadata. The exporter validates both the structural redaction and the narrower projection; `export-anon-corpus.test.ts` validates the committed output and injects disallowed keys, values and types. Export to a new file:

```sh
npm exec -- tsx scripts/export-anon-corpus.ts --journey "$YAAT_BASE" new-journey.jsonl 0,1,2 0:1 0:2 0:3 0:4 0:5 1:1 1:2 1:3 2:1 2:2 2:3
```

The test assigns sandbox destinations to the leading switch burst and seeds generated message text from row kinds. There is no join between telemetry and sessions. The Pi tape supplies recorded stream and Stop frames, not the activity export; no native session file is opened by the exporter.

## Tier ownership and mock equivalence

| Regression guard                                                                                                                    | Coverage and OS                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send, stream, queued badge and dimming, targeted Remove, no dispatch of the cancelled prompt, and live/rehydrated transcript parity | `queue-journey.test.tsx` runs the production App, real loopback WebSocket, Hub, and workspace persistence against Pi's recorded `single-queue-order` tape. It runs browserless in Fast and in Linux + Windows CI. `journey-pilot-queue` keeps the real Chromium interactions and reload in both CI jobs.                                  |
| Switch sessions, resync a connected App, and deliberate Stop                                                                        | The browserless journey switches between seeded sessions, checks a new socket gets the pending page, remounts before and after settlement, and clicks Stop against `interrupt-abort`. Snap replays retain the original backend lifecycle checks.                                                                                          |
| One nonzero exit and file-lock release                                                                                              | `crash-and-restore` checks Pi resume and no duplicate prompt; `deterministic-process-exit.test.ts` checks real child exit, SQLite rollback, and a new write. Both run in Fast and in Linux + Windows CI.                                                                                                                                  |
| Steered ownership, authoritative clears, and retained older pages                                                                   | Keep `liveness`, `components`, and `stream`: the queue journeys do not test steering, explicit `queuedFor: null`/`steering: false`, or old-page merging. The thousand-message search stays in Slow and CI.                                                                                                                                |
| Real pixels, theme contrast, retained state, and large archive/worktree loads                                                       | Slow retains all browser component tests, local stability unit tests, the Chromium subagent pilot and the full-stack Demo bounds. CI also runs the pilots and Demo, and owns the other offline E2E replays and OS-specific checks. Real Pi and the missing-Pi negative check run on Linux CI; orphan-shutdown stress stays local in Slow. |

Fast and Slow print elapsed time without budget alerts. Target Fast at 5 s typical / 10 s p99, Slow at 180 s / 270 s p99. The two CI jobs use a hard 10-minute ceiling including setup.

Regression checks during development: suppressing the Hub-to-browser `message_removed` frame left `Third prompt.` visible and the queue pilot failed at its removal assertion. Adding a 1 px right margin to the message column changed its measured width from 974 to 973 CSS pixels and failed the subagent pilot. The passing fixtures contain neither fault injection.
