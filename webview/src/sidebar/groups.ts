import type { Project, Workspace } from "../state/useServer";
import { sessionState } from "../panels/scope";
import { agentState, isAgentActive } from "../workspace/agents";
import { sessionAttention } from "./attention";

// Groups older than this default to collapsed in the sidebar.
export const STALE_MS = 3 * 86_400_000;
// Quiet project workers older than this fold on a fresh sidebar mount.
export const IDLE_FOLD_MS = 60 * 60 * 1000;

export type GroupStatus = "working" | "waiting" | "sleeping" | "idle";

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
  status: GroupStatus;
}

// Effective sidebar status: preserve the independent `busy` flag when
// `agent_busy` arrives before `agent_state` flips an explicit "idle" state.
export function workspaceStatus(ws: Workspace): GroupStatus {
  if (ws.archivedAt != null) return "idle";
  if (ws.agents.some((a) => a.busy)) return "working";
  const s = sessionState(ws);
  return s === "archived" ? "idle" : s;
}

function groupStatus(workspaces: Workspace[]): GroupStatus {
  const states = workspaces.map(workspaceStatus);
  for (const s of ["working", "waiting", "sleeping"] as const) {
    if (states.includes(s)) return s;
  }
  return "idle";
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
      status: groupStatus(live),
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

// A project worktree repeats context its archived row already has. External
// folders keep their basename so the session remains distinguishable.
export function archivedFolderLabel(ws: Workspace, project?: Project): string | null {
  const cwd = ws.cwd.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  const folder = cwd.split("/").filter(Boolean).pop() ?? ws.cwd;
  if (!project?.root) return folder;
  const root = project.root.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  if (cwd === root || cwd.startsWith(`${root === "/" ? "" : root}/`)) return null;
  const rootBase = root.split("/").filter(Boolean).pop() ?? root;
  if (cwd.startsWith(root) && /^-wt-[^/]+(?:\/|$)/.test(cwd.slice(root.length))) return null;
  const parts = cwd.split("/");
  if (
    parts.some((part, i) => {
      const candidate = parts[i + 1];
      const prefix = `${rootBase}-wt-`;
      return (
        part === "worktrees" && candidate?.startsWith(prefix) && candidate.length > prefix.length
      );
    })
  ) {
    return null;
  }
  return folder;
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
        (ws.lastResult === "done" || now - lastActive(ws) >= IDLE_FOLD_MS),
    )
    .map((ws) => ws.id);
}
