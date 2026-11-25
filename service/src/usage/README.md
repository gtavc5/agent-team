# Usage observations

YAAT stores token counts under `<data directory>/.agent-team/usage.sqlite`. No pricing configuration is required. Missing prices are unknown, not zero. A model catalog amount is an API equivalent, not a subscription charge. Overview is the default view and never downloads individual observations. Records is a secondary audit view of the same ledger, not a per-session execution timeline. A dated observation remains available there even if its session is deleted, or its workspace link or usage details are incomplete.

- `GET /api/usage/overview` returns token and price totals for **one reporting unit**, hourly or daily UTC token composition, and the six highest-volume model families. The `trend` gives both token categories and the ranked families' tokens per bucket, with unranked families grouped as `other`. Ranking combines trailing reasoning-effort variants (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, case-insensitive) before choosing the top six; Records retains raw model IDs. Cache writes are counted separately from ordinary input; all prices remain separated by basis.
- `GET /api/usage/journey` serves the Records view with newest-first observations and events. The response includes `total`, `page`, `pageSize` (30), `rows`, and `nextCursor`. Send a 1-indexed `page` to jump, or send the returned `nextCursor` to continue (not both). Preserve the same filters and exclusive `until` across pages. Empty results report page 1. Late imports can change a previously requested page. Events have no reporting unit. Session, workspace, source, turn and date filters apply to events; model and channel filters select observations only.
- Both routes accept `range=24h|7d|30d|90d` (default `30d`) and `unit=inference|turn|session` (default `inference`). Set `granularity=hour|day` for 24h or 7d; longer ranges accept only `day`. The default is hourly for 24h, daily otherwise. Hourly or 24h windows end at the next UTC hour; other windows end at the next UTC midnight. Pass `until` (Unix milliseconds) to pin the exclusive end. `source` and `turn` are exact; `model`, `channel`, `session`, and `workspace` use case-insensitive literal substrings. `session` includes linked Pi session IDs; `workspace` accepts an ID or an active or archived workspace title. Undated facts remain in storage but are not attributed to a date. Workspace filtering uses verified native session bindings, not path or timestamp similarity.
- Ordinary dashboard reads do not scan native sources. Pass `refresh=1` to sync before reading; concurrent refresh requests share the in-flight scan. The Refresh button drops the pinned end and returns Records to page 1. `incompleteSources` is the last scan's source-level status, not the percentage of requests observed. `sourcesPending` means the first scan has not finished.

For a channel with a known price list, place an optional `usage-pricing.json` in the YAAT data directory. Use the exact channel identifier supplied by the backend. Rates are USD per million tokens; effective dates are UTC. A rate applies when YAAT first records a matching observation at or after that date. Add a new dated schedule for a rate change. Do not infer a private channel from a model name. The newest applicable schedule wins.

```json
{
  "schedules": [
    {
      "channel": "example-gateway",
      "effective": "2026-01-01",
      "input": 2,
      "cacheRead": 0.2,
      "cacheWrite": 2,
      "output": 8
    }
  ],
  "receipts": [
    {
      "source": "pi",
      "sessionId": "example-session",
      "id": "example-inference",
      "asOf": "2026-02-01",
      "usd": 0.023
    }
  ]
}
```

Supply a receipt only when the amount can be reconciled to the exact observation identity. The latest dated receipt replaces the estimate in the dashboard and remains available after restart. It does not add tokens or create another request. The original estimate remains stored with the observation. Output tokens already include any backend-reported reasoning subset. Prompt tokens are ordinary input plus cache reads plus cache writes.
