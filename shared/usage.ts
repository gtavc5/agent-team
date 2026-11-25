export interface JourneyEvent {
  id: string;
  source: UsageObservation["source"];
  sessionId: string;
  turnId?: string;
  timestamp: number | null;
  workspaceId?: string;
  kind: "tool" | "compaction";
  name: string;
}

export type UsagePrice = {
  kind: "api-equivalent" | "channel-estimate" | "reported" | "unpriced";
  usd: number | null;
  asOf?: string;
};

/** Counts are disjoint. Reasoning already included in output is never added again. */
export interface UsageObservation {
  id: string;
  source: "acp" | "pi" | "codex";
  unit: "inference" | "turn" | "session";
  sessionId: string;
  timestamp: number | null;
  model: string | null;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  workspaceId?: string;
  piSessionId?: string;
  channel?: string;
  turnId?: string;
  toolCalls?: { id: string; name: string }[];
  price: UsagePrice;
}

export interface UsageFilters {
  since: number;
  until: number;
  unit: UsageObservation["unit"];
  source?: UsageObservation["source"];
  channel?: string;
  model?: string;
  workspace?: string;
  session?: string;
  turn?: string;
}

type TokenCounts = Pick<UsageObservation, "input" | "cacheRead" | "cacheWrite" | "output">;
export interface UsageOverview extends TokenCounts {
  count: number;
  promptBearing: number;
  eligible: number;
  at96: number;
  unpriced: number;
  costs: Record<Exclude<UsagePrice["kind"], "unpriced">, number | null>;
  trend: ({ day: string } & TokenCounts)[];
  ranking: { model: string | null; tokens: number }[];
}

export interface UsageJourney {
  rows: (UsageObservation | JourneyEvent)[];
  nextCursor: string | null;
}
