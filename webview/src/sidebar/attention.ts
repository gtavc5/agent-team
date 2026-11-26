import { isZh } from "../i18n";
import { tWorkspace } from "../i18n/workspace";
import type { Project, Workspace } from "../state/useServer";
import { workspaceStatus } from "./groups";

export type Attention = "yourTurn" | "failed" | "unread";

export interface AttentionSummary {
  count: number;
  unread: number;
  yourTurn: number;
  failed: number;
}

// A live dialog can require an answer even while the turn is still running.
export function sessionAttention(ws: Workspace): Attention | undefined {
  if (ws.awaitsUser) return "yourTurn";
  const status = workspaceStatus(ws);
  if (ws.lastResult === "failed" && status !== "working" && status !== "waiting") return "failed";
  if ((ws.unread ?? 0) > 0) return "unread";
}

export function summarizeAttention(
  workspaces: readonly Workspace[],
  activeWsId: string | null,
  projects: readonly Project[] = [],
): AttentionSummary {
  const archivedProjects = new Set(
    projects.filter((project) => project.archivedAt != null).map((project) => project.id),
  );
  const summary: AttentionSummary = { count: 0, unread: 0, yourTurn: 0, failed: 0 };
  for (const ws of workspaces) {
    if (
      ws.id === activeWsId ||
      ws.archivedAt != null ||
      (ws.projectLink && archivedProjects.has(ws.projectLink.projectId))
    )
      continue;
    const cue = sessionAttention(ws);
    if (!cue) continue;
    summary.count++;
    summary[cue]++;
  }
  return summary;
}

export function attentionBreakdown(summary: AttentionSummary): string {
  return [
    summary.yourTurn && tWorkspace("needYouCount", { count: summary.yourTurn }),
    summary.failed && tWorkspace("failedCount", { count: summary.failed }),
    summary.unread && tWorkspace("unreadCount", { count: summary.unread }),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function describeAttention(summary: AttentionSummary, singularNoun = "session"): string {
  if (isZh()) {
    const noun = singularNoun === "background session" ? "后台会话" : "会话";
    if (summary.count === 0) return `没有需要关注的${noun}`;
    const needs = `${summary.count} 个${noun}需要关注`;
    return summary.yourTurn > 0 ? `${needs}，其中 ${summary.yourTurn} 个等待你回复` : needs;
  }
  if (summary.count === 0) return `no ${singularNoun}s need attention`;
  const sessions = `${summary.count} ${singularNoun}${summary.count === 1 ? "" : "s"}`;
  const needs = `${sessions} ${summary.count === 1 ? "needs" : "need"} attention`;
  return [
    needs,
    summary.yourTurn && `${summary.yourTurn} your turn`,
    summary.failed && `${summary.failed} failed`,
  ]
    .filter(Boolean)
    .join(", ");
}
