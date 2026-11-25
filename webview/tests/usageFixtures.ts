import type {
  JourneyEvent,
  UsageJourney,
  UsageObservation,
  UsageOverview,
} from "../../shared/usage";

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
    {
      day: "2026-06-01",
      input: 4,
      cacheRead: 30,
      cacheWrite: 0,
      output: 2,
      models: [
        { model: "example-model", tokens: 30 },
        { model: null, tokens: 6 },
      ],
      other: 0,
    },
    {
      day: "2026-06-03",
      input: 0,
      cacheRead: 66,
      cacheWrite: 4,
      output: 4,
      models: [{ model: "example-model", tokens: 74 }],
      other: 0,
    },
  ],
  ranking: [
    { model: "example-model", tokens: 104 },
    { model: null, tokens: 6 },
  ],
};
export const observation = {
  id: "inference-receipt",
  source: "pi",
  unit: "inference",
  sessionId: "pi-session",
  turnId: "turn-1",
  piSessionId: "native-pi-session",
  workspaceId: "ws-123456789",
  workspaceName: "Design workspace",
  timestamp: Date.UTC(2026, 5, 1),
  model: "example-model",
  input: 0,
  cacheRead: 96,
  cacheWrite: 4,
  output: 4,
  price: { kind: "api-equivalent", usd: 0.125, asOf: "2026-06-01" },
} satisfies UsageObservation & UsageJourney["rows"][number];
export const compaction: JourneyEvent = {
  id: "compaction-receipt",
  source: "pi",
  sessionId: "pi-session",
  timestamp: null,
  kind: "compaction",
  name: "Context compacted",
};
export const recordsUntil = Date.UTC(2026, 5, 4);
const responseStatus = {
  incompleteSources: 0,
  sourcesPending: false,
  since: Date.UTC(2026, 4, 5),
  until: recordsUntil,
};
export const overviewResponse = (fields: Record<string, unknown> = {}) =>
  Response.json({ ...overview, ...responseStatus, ...fields });
export const journeyResponse = (
  rows: UsageJourney["rows"],
  fields: Partial<Omit<UsageJourney, "rows"> & typeof responseStatus> = {},
) =>
  Response.json({ ...responseStatus, rows, page: 1, pageSize: 30, total: rows.length, ...fields });

export function usageUrl(url: Parameters<typeof fetch>[0]) {
  if (typeof url !== "string") throw new Error("Expected a usage URL");
  return new URL(url, "https://usage.example/");
}
