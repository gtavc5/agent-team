export type SubagentStatus =
  "queued" | "running" | "completed" | "failed" | "partial" | "paused" | "stopped" | "rejected";

export function isOutstandingSubagentStatus(status: SubagentStatus | undefined): boolean {
  return status === "queued" || status === "running";
}
