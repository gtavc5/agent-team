# Usage observations

YAAT stores token counts under `<data directory>/.agent-team/usage.sqlite`. No pricing configuration is required. Missing prices are unknown, not zero. A model catalog amount is an API equivalent, not a subscription charge. The dashboard and Journey read the same records through authenticated `GET /api/usage`.

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
