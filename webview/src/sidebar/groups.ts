import type { Project, Workspace } from "../state/useServer";
import { agentState, isAgentActive } from "../workspace/agents";
import { sessionAttention } from "./attention";

// Groups older than this default to collapsed in the sidebar.
export const STALE_MS = 3 * 86_400_000;

export interface WorkspaceGroup {
  // Group key = the workspace cwd, so same-folder workspaces fold together;
  // a project's workspaces fold under "project:<id>" wherever they work.
  key: string;
  label: string;
  project?: Project;
  workspaces: Workspace[];
  // A project's archived sessions, newest first, shown under it on demand.
  archived: Workspace[];
  // Newest activity, the archived sessions' included.
  lastActive: number;
  createdAt: number;
  running: boolean;
}

function lastActive(ws: Workspace): number {
  return ws.lastMessageAt ?? ws.createdAt;
}

export function isArchived(ws: Workspace): boolean {
  return ws.archivedAt != null;
}

// Archived workspaces no project holds, in a flat section of their own,
// newest first; a project's are listed under it.
export function archivedWorkspaces(workspaces: Workspace[], projects: Project[] = []): Workspace[] {
  const known = new Set(projects.map((p) => p.id));
  return workspaces
    .filter((w) => isArchived(w) && !(w.projectLink && known.has(w.projectLink.projectId)))
    .sort((a, b) => lastActive(b) - lastActive(a));
}

// Projects come first, each with its lead above its workers. Positions are
// based on creation rather than message activity, which changes mid-read.
export function groupWorkspaces(
  workspaces: Workspace[],
  projects: Project[] = [],
): WorkspaceGroup[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const byKey = new Map<string, { live: Workspace[]; archived: Workspace[] }>();
  for (const ws of workspaces) {
    const project = ws.projectLink && byId.get(ws.projectLink.projectId);
    // Archived ones without a project are in the flat archived section.
    if (isArchived(ws) && !project) continue;
    const key = project ? `project:${project.id}` : ws.cwd || "(no path)";
    let entry = byKey.get(key);
    if (!entry) byKey.set(key, (entry = { live: [], archived: [] }));
    (isArchived(ws) ? entry.archived : entry.live).push(ws);
  }

  const groups: WorkspaceGroup[] = [];
  for (const [key, { live, archived }] of byKey) {
    const project = byId.get(key.slice("project:".length));
    const isLead = (w: Workspace) => (w.projectLink?.role === "lead" ? 1 : 0);
    live.sort(
      (a, b) => isLead(b) - isLead(a) || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    );
    archived.sort((a, b) => lastActive(b) - lastActive(a));
    groups.push({
      key,
      label: project?.name ?? key.split("/").filter(Boolean).pop() ?? key,
      ...(project && { project }),
      workspaces: live,
      archived,
      lastActive: Math.max(...[...live, ...archived].map(lastActive)),
      createdAt: project?.createdAt ?? Math.min(...live.map((w) => w.createdAt)),
      running: live.some((w) => w.agents.some((a) => a.busy || isAgentActive(a))),
    });
  }
  groups.sort(
    (a, b) =>
      (b.project ? 1 : 0) - (a.project ? 1 : 0) ||
      b.createdAt - a.createdAt ||
      a.key.localeCompare(b.key),
  );
  return groups;
}

// A group starts expanded when it has recent activity, something running, or
// holds the active workspace — but an explicit user toggle (persisted per
// group key) always wins, so even the active group can be collapsed.
export function isGroupExpanded(
  group: WorkspaceGroup,
  overrides: Record<string, boolean>,
  now: number,
  containsActive = false,
): boolean {
  const override = overrides[group.key];
  if (override !== undefined) return override;
  return containsActive || !!group.project || group.running || now - group.lastActive < STALE_MS;
}

export function canFoldWorker(ws: Workspace, activeWsId: string | null): boolean {
  return (
    ws.projectLink?.role === "worker" &&
    ws.archivedAt == null &&
    ws.id !== activeWsId &&
    !ws.queued &&
    !sessionAttention(ws) &&
    !ws.agents.some((a) => a.busy || agentState(a) !== "idle")
  );
}

export function initialIdleWorkers(
  group: WorkspaceGroup,
  activeWsId: string | null,
  now: number,
): string[] {
  if (!group.project || group.project.archivedAt != null) return [];
  return group.workspaces
    .filter(
      (ws) =>
        canFoldWorker(ws, activeWsId) &&
        (ws.lastResult === "done" || now - lastActive(ws) >= STALE_MS),
    )
    .map((ws) => ws.id);
}
