/** GET /api/workspaces/:workspaceId/stats?offset=0&limit=20. Newest turns first.
 * Optional metrics are unknown, not zero. Times are Unix milliseconds. */
export interface SessionStatsPage {
  turns: StatsTurn[];
  total: number;
  offset: number;
  limit: number;
}

export interface StatsTurn {
  /** Native IDs are unique within a session, not across parent and child sessions. */
  key?: string;
  source?: "pi" | "codex" | "acp";
  sessionId?: string;
  turnId: string;
  trigger: string;
  steps: StatsStep[];
}

export interface StatsStep {
  stepId: string;
  kind: "model" | "user" | "tool" | "compaction";
  trigger?: string;
  inferenceId?: string;
  toolCallId?: string;
  model?: string;
  promptTokens?: number;
  promptDelta?: number;
  boundary?: "model switch" | "compaction" | "gap";
  stepStart?: number;
  firstDelta?: number;
  stepEnd?: number;
  toolStart?: number;
  toolResult?: number;
  /** Native occurrence time when available; otherwise the live observation time. */
  compaction?: number;
  compactionObservedAt?: number;
}
