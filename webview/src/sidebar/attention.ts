import { isZh } from "../i18n";
import type { Project, Workspace } from "../state/useServer";
import { isAgentActive } from "../workspace/agents";

export interface AttentionSummary {
  // Sessions with unread updates, your turn, or both.
  count: number;
  unread: number;
  yourTurn: number;
}

export function summarizeAttention(
  workspaces: readonly Workspace[],
  activeWsId: string | null,
  projects: readonly Project[] = [],
): AttentionSummary {
  const archivedProjects = new Set(
    projects.filter((project) => project.archivedAt != null).map((project) => project.id),
  );
  const summary: AttentionSummary = { count: 0, unread: 0, yourTurn: 0 };
  for (const ws of workspaces) {
    if (
      ws.id === activeWsId ||
      ws.archivedAt != null ||
      (ws.projectLink && archivedProjects.has(ws.projectLink.projectId))
    ) {
      continue;
    }
    // Keep these predicates identical to the session rows in Sidebar.
    const unread = (ws.unread ?? 0) > 0;
    const yourTurn = !!ws.awaitsUser && !ws.agents.some(isAgentActive);
    if (!unread && !yourTurn) continue;
    summary.count += 1;
    if (unread) summary.unread += 1;
    if (yourTurn) summary.yourTurn += 1;
  }
  return summary;
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
  return summary.yourTurn > 0 ? `${needs}, ${summary.yourTurn} your turn` : needs;
}
