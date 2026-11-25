import type { JourneyEvent, UsageObservation, UsageOverview } from "../../shared/usage";

export const overview: UsageOverview = {
  count: 2,
  input: 4,
  cacheRead: 96,
  cacheWrite: 4,
  output: 6,
  promptBearing: 2,
  eligible: 2,
  at96: 1,
  unpriced: 1,
  costs: { reported: 0, "api-equivalent": 0.125, "channel-estimate": null },
  trend: [
    { day: "2026-06-01", input: 4, cacheRead: 30, cacheWrite: 0, output: 2 },
    { day: "2026-06-03", input: 0, cacheRead: 66, cacheWrite: 4, output: 4 },
  ],
  ranking: [
    { model: "example-model", tokens: 104 },
    { model: null, tokens: 6 },
  ],
};
export const observation: UsageObservation = {
  id: "inference-receipt",
  source: "pi",
  unit: "inference",
  sessionId: "pi-session",
  turnId: "turn-1",
  timestamp: Date.UTC(2026, 5, 1),
  model: "example-model",
  input: 0,
  cacheRead: 96,
  cacheWrite: 4,
  output: 4,
  price: { kind: "api-equivalent", usd: 0.125, asOf: "2026-06-01" },
};
export const compaction: JourneyEvent = {
  id: "compaction-receipt",
  source: "pi",
  sessionId: "pi-session",
  timestamp: null,
  kind: "compaction",
  name: "Context compacted",
};
export const overviewResponse = (fields: Record<string, unknown> = {}) =>
  Response.json({ ...overview, incompleteSources: 0, ...fields });
export const journeyResponse = (
  rows: (UsageObservation | JourneyEvent)[],
  nextCursor: string | null = null,
) => Response.json({ rows, nextCursor, incompleteSources: 0, until: Date.UTC(2026, 5, 4) });
