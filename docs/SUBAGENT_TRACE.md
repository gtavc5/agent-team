# Subagent trace inspection

Expand a subagent card in the transcript to see its task, steps, result, and usage inline. Use **Earlier**, **Newer**, and **Latest** to browse longer traces. Child cards expand in place without replacing the parent's page. Each open card retains one bounded page. Collapsing the card or switching sessions discards that page and any open descendants.

## WebSocket contract

Send `load_subagent_trace` with a numeric `requestId` and the target `workspaceId`, `messageId`, and `taskId`. Omit the cursor for the latest window. `direction: "before"` takes the exclusive end as its cursor; `direction: "after"` takes the inclusive start. For nested traces, `path` is a list of child task IDs beneath the root task (maximum six levels).

`subagent_trace_page` echoes only the request ID. It includes `events`, a half-open `[start, end)` range, `totalEvents`, `revision`, and `hasMore` in the requested direction. Request up to 24 events (`limit`) and 32 KiB (`maxBytes`, minimum 256 bytes). The byte limit counts the entire JSON response encoded in UTF-8, including optional `prompt`, `result`, and `usage` (`totalTokens`, `toolUses`, and `durationMs`). Prompts and results have a 4,096-character cap each and can shrink further to fit the byte limit. An oversized row can be shortened or omitted without blocking later pages; `truncated` reports this separately from pagination. `unavailable` means the target is missing.

The workspace keeps the trace as the source of truth, including existing Pi child artifacts and stored history. The regular transcript carries only summaries, counts, and revisions, including when it reconnects. An open card fetches again when its root revision advances or the browser reconnects; the service never broadcasts trace bodies or subscribes to a Pi run for this. The Pi `/subagents-inspect-rpc` widget remains reserved and is not forwarded to the transcript.
