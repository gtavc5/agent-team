# Usage observations

YAAT stores token counts under `<data directory>/.agent-team/usage.sqlite`. No pricing configuration is required. Missing prices are unknown, not zero. A model catalog amount is an API equivalent, not a subscription charge. Overview is the default view and never downloads individual observations. Records is a secondary audit view of the same ledger, not a per-session execution timeline. A dated observation remains available there even if its session is deleted, or its workspace link or usage details are incomplete.

- `GET /api/usage/overview` returns token and price totals for **one reporting unit**, daily UTC token composition, and the highest-volume models. Cache writes are counted separately from ordinary input; all prices remain separated by basis.
- `GET /api/usage/journey` serves the Records view with up to 30 chronological observations and events per page. Send the returned `nextCursor` with the same filters and `until` to continue. Events have no reporting unit. Session, workspace, source, turn and date filters apply to events; model and channel filters select observations only.
- Both routes accept `range=7d|30d|90d` (default `30d`), `unit=inference|turn|session` (default `inference`), and exact `source`, `channel`, `model`, `workspace`, `session` and `turn` filters. Ranges end at the next UTC midnight unless an exclusive `until` (Unix milliseconds) is supplied. Undated facts remain in storage but are not attributed to a date. Workspace filtering uses verified native session bindings, not path or timestamp similarity.
- Native import runs separately from dashboard requests. `incompleteSources` is the last scan's source-level status, not the percentage of requests observed. `sourcesPending` means the first scan has not finished.

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
