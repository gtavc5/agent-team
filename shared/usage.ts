export interface JourneyEvent {
  id: string;
  source: UsageObservation["source"];
  sessionId: string;
  turnId?: string;
  timestamp: number | null;
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
  piSessionId?: string;
  channel?: string;
  turnId?: string;
  toolCalls?: { id: string; name: string }[];
  price: UsagePrice;
}
