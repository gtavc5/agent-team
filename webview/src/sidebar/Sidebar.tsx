import { telemetryTarget } from "../telemetryEvents";
import type { QuotaState } from "../../../shared/quota";
import {
  memo,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
  useRef,
  useSyncExternalStore,
} from "react";
import type { Workspace, Project, SystemStatus, SearchHit } from "../state/useServer";
import {
  groupWorkspaces,
  isGroupExpanded,
  archivedWorkspaces,
  archivedFolderLabel,
  canFoldWorker,
  initialIdleWorkers,
  workspaceStatus,
  type GroupStatus,
  type WorkspaceGroup,
} from "./groups";
import { Icon } from "../panels/Icon";
import { DEFAULT_BRANCH } from "../panels/scope";
import { formatBytes, formatRelative } from "../format";
import { t } from "../i18n/chat";
import { tWorkspace, useWorkspaceT } from "../i18n/workspace";
import { RoleTag } from "../workspace/RoleTag";
import { NameInput } from "../project/NameInput";
import { ConfirmDialog } from "../workspace/dialogs";
import { QuotaPanel } from "./QuotaPanel";
import { formatShortDateTime, quotaTone } from "./quota";
import { attentionBreakdown, sessionAttention, summarizeAttention } from "./attention";
import { StreamSilence } from "./StreamSilence";

interface ThemeController {
  get: () => "light" | "dark";
  subscribe: (listener: () => void) => () => void;
  toggle: () => void;
}

declare global {
  interface Window {
    // Installed synchronously by index.html, not by isolated component mounts.
    yaatTheme?: ThemeController;
  }
}

function ThemeToggle({ controller }: { controller: ThemeController }) {
  const tr = useWorkspaceT();
  const dark = useSyncExternalStore(controller.subscribe, controller.get) === "dark";
  return (
    <button
      type="button"
      aria-label={tr("darkTheme")}
      aria-pressed={dark}
      title={tr("darkTheme")}
      onClick={controller.toggle}
    >
      <Icon name={dark ? "moon" : "sun"} />
    </button>
  );
}

function gitTitle(git: { dirty: number; ahead: number; behind: number }): string {
  const parts: string[] = [];
  if (git.dirty)
    parts.push(
      tWorkspace(git.dirty === 1 ? "gitDirtyFile" : "gitDirtyFiles", { count: git.dirty }),
    );
  if (git.ahead) parts.push(tWorkspace("gitAhead", { count: git.ahead }));
  if (git.behind) parts.push(tWorkspace("gitBehind", { count: git.behind }));
  return parts.length ? parts.join(tWorkspace("gitListSep")) : tWorkspace("gitClean");
}

function SessionWait({ workspace }: { workspace: Workspace }) {
  const tr = useWorkspaceT();
  const retry = workspace.agents.find((a) => a.retryLabel)?.retryLabel;
  if (retry) {
    const attempt = retry.match(/\bRetrying (?:in \d+s )?\((\d+)\b/)?.[1];
    return (
      <span className="session-silence" title={retry}>
        {attempt ? tr("retryingSessionAttempt", { attempt }) : tr("retryingSession")}
      </span>
    );
  }
  return <StreamSilence workspace={workspace} />;
}

function statusDotClass(state: GroupStatus): string {
  if (state === "working") return "running";
  if (state === "waiting") return "waiting";
  if (state === "sleeping") return "waiting sleeping";
  return "idle";
}

const STATUS_COLORS = { danger: "var(--error)", warn: "var(--warning)", normal: "var(--accent)" };

export const FOLDED_IDLE_STORAGE_KEY = "sidebarFoldedIdle";

function readFoldedWorkerIds(): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(FOLDED_IDLE_STORAGE_KEY) ?? "[]");
    return new Set(
      Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function writeFoldedWorkerIds(ids: ReadonlySet<string>): void {
  try {
    if (ids.size) localStorage.setItem(FOLDED_IDLE_STORAGE_KEY, JSON.stringify([...ids]));
    else localStorage.removeItem(FOLDED_IDLE_STORAGE_KEY);
  } catch {
    // Private mode: the choice lasts for this mount.
  }
}

function StatusBar({ label, pct, extra }: { label: string; pct: number; extra?: string }) {
  return (
    <div className="status-item">
      <span className="status-label">{label}</span>
      <span className="status-value">
        <span
          className="status-bar"
          role="progressbar"
          aria-label={label}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span
            className="status-bar-fill"
            style={{ width: `${pct}%`, background: STATUS_COLORS[quotaTone(pct)] }}
          />
        </span>
        <span className="status-pct">{extra ?? `${pct}%`}</span>
      </span>
    </div>
  );
}

export function SystemStatusPanel({ status }: { status: SystemStatus }) {
  const tr = useWorkspaceT();
  const memPct = Math.round((status.memUsed / status.memTotal) * 100);

  return (
    <div className="system-status-panel">
      <div className="system-status-grid">
        <StatusBar label={tr("cpuLabel")} pct={status.cpuUsage} />
        <StatusBar
          label={tr("memLabel")}
          pct={memPct}
          extra={`${formatBytes(status.memUsed)} / ${formatBytes(status.memTotal)}`}
        />
      </div>
    </div>
  );
}

export interface SidebarProps {
  workspaces: Workspace[];
  projects?: Project[];
  activeWsId: string | null;
  connected: boolean;
  // True after an authoritative init, including one with zero workspaces.
  snapshotReady?: boolean;
  // Mobile keeps the drawer mounted while it is translated off screen.
  sidebarOpen?: boolean;
  groupOverrides: Record<string, boolean>;
  searchQuery: string;
  searchHits: SearchHit[] | null;
  systemStatus: SystemStatus | null;
  quota?: QuotaState | null;
  onRefreshQuota?: (force?: boolean, providers?: readonly string[]) => void;
  now?: number;
  onSelect: (wsId: string) => void;
  onDelete: (wsId: string) => void;
  // The × on a project's lead deletes the project (after confirming).
  onDeleteProject?: (projectId: string) => void;
  onToggleGroup: (key: string, expanded: boolean) => void;
  onSearchChange: (q: string) => void;
  onJump: (wsId: string, msgId: string) => void;
  onCreate: () => void;
  onCreateProject?: () => void;
  // Create a workspace in a group's folder (the "+" on the group header).
  onCreateIn: (cwd: string) => void;
  onReplayDemo: () => void;
  onOpenUsage?: () => void;
  // Capture synchronously, then save a layout snapshot on the server.
  onDebugSnapshot: () => void | Promise<unknown>;
  // One project's archived sessions, or (null) those in no project.
  onPurgeArchived: (projectId: string | null) => void;
  onArchiveWorkspace?: (wsId: string) => void;
  onArchiveProject?: (projectId: string) => void;
  onRenameProject?: (projectId: string, name: string) => void;
  onRestoreProject?: (projectId: string) => void;
}

export const Sidebar = memo(function Sidebar(p: SidebarProps) {
  const tr = useWorkspaceT();
  const now = p.now ?? Date.now();
  const snapshotReady = p.snapshotReady ?? p.workspaces.length > 0;
  const debug = new URLSearchParams(window.location.search).get("debug") === "1";
  const [debugOpen, setDebugOpen] = useState(debug);
  const [health, setHealth] = useState<"unknown" | "healthy" | "unhealthy">("unknown");
  const [snapshotStatus, setSnapshotStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const snapshotUpload = useRef<Promise<unknown> | null>(null);
  const snapshotStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debugId = useId();
  const debugTrigger = useRef<HTMLButtonElement>(null);
  const debugStrip = useRef<HTMLDivElement>(null);
  const sidebarOpen = p.sidebarOpen ?? true;
  const previousSidebarOpen = useRef(sidebarOpen);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const deleting = p.workspaces.find((ws) => ws.id === deleteId);
  useEffect(() => {
    return () => {
      if (snapshotStatusTimer.current) clearTimeout(snapshotStatusTimer.current);
    };
  }, []);
  useEffect(() => {
    setHealth("unknown");
    if (!p.connected) return;
    let request: AbortController | undefined;
    const check = async () => {
      request?.abort();
      const controller = (request = new AbortController());
      let health: "healthy" | "unhealthy" = "unhealthy";
      try {
        const response = await fetch("api/diagnostics", { signal: controller.signal });
        const report: unknown = response.ok ? await response.json() : null;
        health =
          !!report &&
          typeof report === "object" &&
          "issues" in report &&
          Array.isArray(report.issues) &&
          report.issues.every(
            (issue: unknown) =>
              !!issue &&
              typeof issue === "object" &&
              "severity" in issue &&
              issue.severity === "info",
          )
            ? "healthy"
            : "unhealthy";
      } catch {
        // An unavailable report must not hide the diagnostics attention indicator.
      }
      if (!controller.signal.aborted) setHealth(health);
    };
    void check();
    // Model/account readiness can change without reconnecting the socket.
    const timer = setInterval(() => void check(), 60_000);
    return () => {
      clearInterval(timer);
      request?.abort();
    };
  }, [p.connected]);
  useEffect(() => {
    if (previousSidebarOpen.current && !sidebarOpen) setDebugOpen(false);
    previousSidebarOpen.current = sidebarOpen;
  }, [sidebarOpen]);
  useEffect(() => {
    if (!debugOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const strip = debugStrip.current;
      if (!strip || getComputedStyle(strip).display === "none") return;
      setDebugOpen(false);
      debugTrigger.current?.focus();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
    };
  }, [debugOpen]);

  const saveSnapshot = () => {
    if (snapshotUpload.current) return;
    if (snapshotStatusTimer.current) {
      clearTimeout(snapshotStatusTimer.current);
      snapshotStatusTimer.current = null;
    }
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(p.onDebugSnapshot());
    } catch (err) {
      pending = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    snapshotUpload.current = pending;
    setSnapshotStatus("saving");
    const settle = (status: "saved" | "error") => {
      if (snapshotUpload.current !== pending) return;
      snapshotUpload.current = null;
      setSnapshotStatus(status);
      snapshotStatusTimer.current = setTimeout(
        () => {
          snapshotStatusTimer.current = null;
          setSnapshotStatus("idle");
        },
        status === "error" ? 5000 : 3000,
      );
    };
    // Rejection must not close the strip; inline status and App toast surface it.
    void pending.then(
      () => settle("saved"),
      () => settle("error"),
    );
  };
  const toggleDebug = () => setDebugOpen((v) => !v);
  const diagnosticsState = !p.connected ? "offline" : health === "unhealthy" ? "unhealthy" : null;
  const triggerAbnormal = diagnosticsState !== null && !debugOpen;
  const triggerLabel = triggerAbnormal
    ? tr("debugToolsStatus", { state: tr(diagnosticsState) })
    : tr("debugTools");
  const diagnosticsLabel = diagnosticsState
    ? tr("diagnosticsStatus", { state: tr(diagnosticsState) })
    : tr("serviceDiagnostics");
  const snapshotBusy = snapshotStatus === "saving";
  const snapshotStatusText =
    snapshotStatus === "saving"
      ? tr("savingSnapshot")
      : snapshotStatus === "saved"
        ? tr("savedSnapshot")
        : snapshotStatus === "error"
          ? tr("failedSnapshot")
          : null;
  const known = new Set((p.projects ?? []).map((pr) => pr.id));
  // A lead takes its project with it; one whose project is unknown (its
  // project.json unreadable) is just a workspace.
  const deleteButton = (ws: Workspace) => {
    const link = ws.projectLink;
    const owner = link && p.projects?.find((project) => project.id === link.projectId);
    if (owner?.status === "sealed") return null;
    const project = link?.role === "lead" && known.has(link.projectId) ? link.projectId : null;
    return (
      <button
        type="button"
        className="task-delete"
        title={project ? tr("deleteProject") : tr("deleteSession")}
        onClick={(e) => {
          e.stopPropagation();
          if (project && p.onDeleteProject) p.onDeleteProject(project);
          else setDeleteId(ws.id);
        }}
      >
        <Icon name="close" />
      </button>
    );
  };
  const groups = useMemo(
    () => groupWorkspaces(p.workspaces, p.projects, tr("noPath")),
    [p.workspaces, p.projects, tr],
  );
  const manualFolded = useRef<ReadonlySet<string> | null>(null);
  if (manualFolded.current === null) manualFolded.current = readFoldedWorkerIds();
  const [foldedIdle, setFoldedIdle] = useState<ReadonlySet<string>>(
    () =>
      new Set([
        ...manualFolded.current!,
        ...(snapshotReady ? groups.flatMap((g) => initialIdleWorkers(g, p.activeWsId, now)) : []),
      ]),
  );
  const [showIdle, setShowIdle] = useState<ReadonlySet<string>>(new Set());
  const bootstrapped = useRef(snapshotReady && groups.length > 0);
  const expandedDefaults = useRef(new Map<string, boolean>());
  useLayoutEffect(() => {
    const bootstrap = snapshotReady && !bootstrapped.current && groups.length > 0;
    if (bootstrap) bootstrapped.current = true;
    // Only an authoritative init (including an empty one) may prune storage.
    if (snapshotReady) {
      const eligible = new Set(
        groups
          .filter((g) => g.project && g.project.archivedAt == null)
          .flatMap((g) => g.workspaces)
          .filter((w) => canFoldWorker(w, p.activeWsId))
          .map((w) => w.id),
      );
      const automatic = bootstrap
        ? groups.flatMap((g) => initialIdleWorkers(g, p.activeWsId, now))
        : [];
      // Reconcile before every read and write so another tab's fold is not
      // replaced by this mount's cached set.
      const durable = readFoldedWorkerIds();
      manualFolded.current = durable;
      setFoldedIdle((prev) => {
        const next = new Set([...prev, ...durable, ...automatic].filter((id) => eligible.has(id)));
        return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
      });
      const next = new Set([...durable].filter((id) => eligible.has(id)));
      if (next.size !== durable.size) {
        manualFolded.current = next;
        writeFoldedWorkerIds(next);
      }
    }
    for (const g of groups) {
      if (!expandedDefaults.current.has(g.key) || g.workspaces.some((w) => w.id === p.activeWsId)) {
        expandedDefaults.current.set(
          g.key,
          isGroupExpanded(
            g,
            {},
            now,
            g.workspaces.some((w) => w.id === p.activeWsId),
          ),
        );
      }
    }
  }, [groups, p.workspaces, p.activeWsId, now, snapshotReady]);
  const archived = archivedWorkspaces(p.workspaces, p.projects);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const activeIsArchived = archived.some((w) => w.id === p.activeWsId);
  const showArchived = archivedOpen || activeIsArchived;
  const live = groups.filter((g) => !g.project?.archivedAt);
  const shelved = groups.filter((g) => g.project?.archivedAt);
  const [shelfOpen, setShelfOpen] = useState(false);
  const showShelf =
    shelfOpen ||
    shelved.some((g) => [...g.workspaces, ...g.archived].some((w) => w.id === p.activeWsId));
  // The project whose name is being edited.
  const [renaming, setRenaming] = useState<string | null>(null);
  // Groups whose archived sessions are unfolded.
  const [openArchives, setOpenArchives] = useState<ReadonlySet<string>>(new Set());
  const toggleArchive = (key: string) => {
    setOpenArchives((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const archivedItem = (ws: Workspace, folder: string | null) => (
    <div
      key={ws.id}
      className={`task-item task-item-archived ${ws.id === p.activeWsId ? "active" : ""}`}
      onClick={() => p.onSelect(ws.id)}
      title={ws.cwd}
    >
      <div className="task-status idle" />
      <div className="task-info">
        <div className="task-name">
          <span className="task-name-text">
            <span className="clip">{ws.name}</span>
          </span>
          <span className="task-time">{formatRelative(ws.lastMessageAt ?? ws.createdAt, now)}</span>
        </div>
        {folder && <div className="task-meta">{folder}</div>}
      </div>
      <span className="task-hover">
        <span className="task-time">{formatRelative(ws.lastMessageAt ?? ws.createdAt, now)}</span>
        {deleteButton(ws)}
      </span>
    </div>
  );

  // A group's archived sessions, folded until asked for (or one is open).
  const archiveList = (g: WorkspaceGroup, list: Workspace[]) => {
    const open = openArchives.has(g.key) || list.some((w) => w.id === p.activeWsId);
    return (
      <>
        <div
          className="ws-archive-toggle"
          role="button"
          aria-expanded={open}
          {...telemetryTarget("sidebar.archive_toggle")}
          onClick={() => toggleArchive(g.key)}
        >
          <span className="events-toggle">{open ? "▾" : "▸"}</span>
          <span>{tr("archived")}</span>
          {open && <span className="ws-group-count">{list.length}</span>}
          {open && g.project && g.project.status !== "sealed" && (
            <button
              className="ws-archived-purge"
              title={tr("deleteArchivedProjectSessions", { name: g.label })}
              onClick={(e) => {
                e.stopPropagation();
                p.onPurgeArchived(g.project!.id);
              }}
            >
              {tr("clear")}
            </button>
          )}
        </div>
        {open && list.map((w) => archivedItem(w, archivedFolderLabel(w, g.project)))}
      </>
    );
  };

  // A folder's group or a project's (its row is its lead), with its archived
  // sessions folded under it; `shelf` for an archived project's.
  const renderGroup = (g: WorkspaceGroup, shelf = false) => {
    const current = [...g.workspaces, ...g.archived].some((w) => w.id === p.activeWsId);
    const expanded =
      p.groupOverrides[g.key] ??
      (current || (expandedDefaults.current.get(g.key) ?? isGroupExpanded(g, {}, now)));
    const toggle = () => p.onToggleGroup(g.key, !expanded);
    // A project's own row is its lead, archived with it or not: it opens the
    // lead, which is not listed again under it; the arrow folds the sessions
    // it started.
    const lead = g.project
      ? [...g.workspaces, ...g.archived].find((w) => w.projectLink?.role === "lead")
      : undefined;
    const items = g.workspaces.filter((w) => w !== lead);
    const past = g.archived.filter((w) => w !== lead);
    const attention = summarizeAttention(g.workspaces, null, g.project ? [g.project] : []);
    const summary = attentionBreakdown(attention);
    const idle =
      !shelf && g.project
        ? items.filter((w) => foldedIdle.has(w.id) && canFoldWorker(w, p.activeWsId))
        : [];
    const visible = items.filter((w) => !idle.includes(w));
    const foldable =
      !shelf && g.project ? visible.filter((w) => canFoldWorker(w, p.activeWsId)) : [];
    const idleOpen = showIdle.has(g.key);
    const toggleIdle = () =>
      setShowIdle((prev) => {
        const next = new Set(prev);
        if (!next.delete(g.key)) next.add(g.key);
        return next;
      });
    const foldIdle = () => {
      const manual = new Set([
        ...readFoldedWorkerIds(),
        ...manualFolded.current!,
        ...foldable.map((w) => w.id),
      ]);
      manualFolded.current = manual;
      writeFoldedWorkerIds(manual);
      setFoldedIdle((prev) => new Set([...prev, ...foldable.map((w) => w.id)]));
      setShowIdle((prev) => {
        const next = new Set(prev);
        next.delete(g.key);
        return next;
      });
    };
    const hasContent = items.length > 0 || past.length > 0;
    // A project of archived sessions only (its lead archived too) has no live one.
    const git = (g.workspaces[0] ?? g.archived[0])?.git;
    const groupTitlePath = g.key === "(no path)" ? tr("noPath") : g.key;
    const isRenaming = Boolean(g.project && renaming === g.project.id);
    const canAdd = !g.project || Boolean(g.project.root && g.project.status !== "sealed");
    const canArchiveProject =
      !shelf && Boolean(g.project && g.project.status !== "sealed" && p.onArchiveProject);
    const canRestoreProject =
      shelf && Boolean(g.project && g.project.status !== "sealed" && p.onRestoreProject);
    const leadDelete = lead ? deleteButton(lead) : null;
    const hasActions =
      !isRenaming && (canAdd || canArchiveProject || canRestoreProject || Boolean(leadDelete));
    const renderWorkerItem = (ws: Workspace) => {
      const state = workspaceStatus(ws);
      const busy = state === "working" || state === "waiting";
      const cue = sessionAttention(ws);
      const owner = ws.projectLink
        ? p.projects?.find((project) => project.id === ws.projectLink!.projectId)
        : undefined;
      const canArchive =
        Boolean(p.onArchiveWorkspace) &&
        ws.archivedAt == null &&
        ws.projectLink?.role !== "lead" &&
        owner?.status !== "sealed" &&
        !busy &&
        !ws.queued;
      return (
        <div
          key={ws.id}
          className={`task-item ${ws.id === p.activeWsId ? "active" : ""}${busy ? " task-item-active" : ""}`}
          onClick={() => p.onSelect(ws.id)}
        >
          <div className={`task-status ${statusDotClass(state)}`} aria-hidden="true" />
          <div className="task-info">
            <div className="task-name">
              <span className="task-name-text">
                <RoleTag link={ws.projectLink} />
                <span className="clip" title={ws.name}>
                  {ws.name}
                </span>
              </span>
              {cue ? (
                <span
                  className={`session-attention attention-${cue}${cue === "yourTurn" ? " awaits-tag" : ""}`}
                >
                  {tr(
                    cue === "yourTurn"
                      ? "yourTurnStatus"
                      : cue === "failed"
                        ? "failedSession"
                        : "unreadResult",
                  )}
                </span>
              ) : p.connected ? (
                <SessionWait workspace={ws} />
              ) : null}
            </div>
          </div>
          <span className="task-hover">
            <span className="task-time">
              {formatRelative(ws.lastMessageAt ?? ws.createdAt, now)}
            </span>
            {canArchive && (
              <button
                type="button"
                className="task-archive"
                title={tr("archiveSession")}
                aria-label={tr("archiveSession")}
                onClick={(e) => {
                  e.stopPropagation();
                  p.onArchiveWorkspace!(ws.id);
                }}
              >
                <Icon name="archive" />
              </button>
            )}
            {deleteButton(ws)}
          </span>
        </div>
      );
    };
    return (
      <div key={g.key} className="ws-group">
        <div
          className={`ws-group-header${g.project ? " ws-group-project" : ""}${lead && lead.id === p.activeWsId ? " active" : ""}${current ? " current" : ""}`}
          title={
            lead
              ? tr("openProjectLead", { name: g.label })
              : g.project
                ? (g.project.root ?? tr("noRepository"))
                : groupTitlePath
          }
          onClick={() => (lead ? p.onSelect(lead.id) : toggle())}
        >
          {lead && !hasContent ? (
            // Nothing to fold: an empty slot keeps the name in line.
            <span className="events-toggle" />
          ) : lead ? (
            <button
              type="button"
              className="events-toggle ws-group-toggle"
              aria-label={
                expanded ? tr("foldGroup", { name: g.label }) : tr("unfoldGroup", { name: g.label })
              }
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
            >
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="events-toggle">{expanded ? "▾" : "▸"}</span>
          )}
          {isRenaming ? (
            <NameInput
              name={g.label}
              label={tr("projectNameLabel")}
              className="ws-group-rename"
              onDone={(name) => {
                setRenaming(null);
                if (name) p.onRenameProject?.(g.project!.id, name);
              }}
            />
          ) : (
            <span
              className="ws-group-label"
              {...(g.project &&
                g.project.status !== "sealed" &&
                p.onRenameProject && {
                  title: tr("doubleClickRename"),
                  onDoubleClick: (e: React.MouseEvent) => {
                    e.stopPropagation();
                    setRenaming(g.project!.id);
                  },
                })}
            >
              {g.label}
            </span>
          )}
          {g.project?.status === "sealed" && (
            <span className="ws-group-sealed" title={g.project.sealedReason ?? undefined}>
              {tr("sealed")}
            </span>
          )}
          {git?.branch && !DEFAULT_BRANCH.test(git.branch) && (
            <span className="ws-group-branch" title={gitTitle(git)}>
              {git.branch}
            </span>
          )}
          {!isRenaming && (
            <span className="ws-group-status">
              {g.status !== "idle" && (
                <span className={`task-status ${statusDotClass(g.status)}`} aria-hidden="true" />
              )}
              {g.project && summary ? (
                <span
                  className={`ws-group-attention attention-${attention.yourTurn ? "yourTurn" : attention.failed ? "failed" : "unread"}`}
                  role="status"
                  aria-label={`${g.label}: ${summary}`}
                  title={summary}
                >
                  {summary}
                </span>
              ) : lead && p.connected ? (
                <SessionWait workspace={lead} />
              ) : null}
              {!expanded && !summary && items.length > 0 && (
                <span className="ws-group-count">{items.length}</span>
              )}
            </span>
          )}
          {hasActions && (
            <span className="ws-group-actions">
              {canAdd && (
                <button
                  type="button"
                  className="ws-group-add"
                  title={
                    g.project
                      ? tr("newSessionIn", { name: g.project.name })
                      : tr("newWorkspaceIn", { path: groupTitlePath })
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onCreateIn(g.project?.root ?? g.key);
                  }}
                >
                  <Icon name="plus" />
                </button>
              )}
              {canArchiveProject && (
                <button
                  type="button"
                  className="ws-group-pill ws-group-archive"
                  title={tr("archiveProjectWithSessions", { name: g.label })}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onArchiveProject!(g.project!.id);
                  }}
                >
                  {tr("archive")}
                </button>
              )}
              {canRestoreProject && (
                <button
                  type="button"
                  className="ws-group-pill"
                  title={tr("restoreProjectTooltip", { name: g.label })}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onRestoreProject!(g.project!.id);
                  }}
                >
                  {tr("restore")}
                </button>
              )}
              {leadDelete}
            </span>
          )}
        </div>
        {expanded && hasContent && (
          <div className="ws-group-items">
            {visible.map(renderWorkerItem)}
            {idle.length > 0 ? (
              <>
                <div className="ws-idle-row">
                  <button
                    type="button"
                    className="ws-idle-toggle"
                    aria-expanded={idleOpen}
                    aria-label={`${idleOpen ? "Hide" : "Show"} ${idle.length} folded session${idle.length === 1 ? "" : "s"}`}
                    title={`${idleOpen ? "Hide" : "Show"} ${idle.length} folded session${idle.length === 1 ? "" : "s"}`}
                    onClick={toggleIdle}
                  >
                    <span className="events-toggle" aria-hidden="true">
                      {idleOpen ? "▾" : "▸"}
                    </span>
                    <span className="ws-idle-label">
                      {tr("idleSessions", { count: idle.length })}
                    </span>
                  </button>
                  {foldable.length > 0 && (
                    <button
                      type="button"
                      className="ws-idle-fold"
                      title={tr(foldable.length === 1 ? "foldIdleTitle" : "foldIdlePluralTitle", {
                        count: foldable.length,
                      })}
                      onClick={(e) => {
                        e.stopPropagation();
                        foldIdle();
                      }}
                    >
                      {tr("foldMoreIdle", { count: foldable.length })}
                    </button>
                  )}
                </div>
                {idleOpen && idle.map(renderWorkerItem)}
              </>
            ) : foldable.length > 0 ? (
              <div className="ws-idle-row">
                <button type="button" className="ws-idle-toggle" onClick={foldIdle}>
                  {tr("foldIdle", { count: foldable.length })}
                </button>
              </div>
            ) : null}
            {past.length > 0 && archiveList(g, past)}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="sidebar-header">
        <span className="sidebar-title">
          {tr("workspaces")} {!p.connected && <span className="disconnected">{tr("offline")}</span>}
        </span>
        <span className="sidebar-actions">
          {window.yaatTheme && <ThemeToggle controller={window.yaatTheme} />}
          <button title={tr("newSession")} onClick={p.onCreate}>
            <Icon name="plus" />
          </button>
          {p.onCreateProject && (
            <button title={tr("newProject")} onClick={p.onCreateProject}>
              <Icon name="board" />
            </button>
          )}
          <button
            type="button"
            title={tr("openUsage")}
            aria-label={tr("openUsage")}
            aria-haspopup="dialog"
            onClick={p.onOpenUsage}
          >
            <Icon name="usage" />
          </button>
          <button
            ref={debugTrigger}
            type="button"
            className="sidebar-debug"
            aria-label={triggerLabel}
            aria-expanded={debugOpen}
            aria-pressed={debugOpen}
            aria-controls={debugId}
            title={triggerLabel}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleDebug}
          >
            <Icon name="debug" />
            {triggerAbnormal && <span className="sidebar-debug-dot" aria-hidden="true" />}
          </button>
        </span>
      </div>
      {debugOpen && (
        <div
          ref={debugStrip}
          id={debugId}
          className="sidebar-debug-strip"
          role="group"
          aria-label={tr("debugTools")}
        >
          {snapshotStatusText && (
            <span
              className={`sidebar-debug-status sidebar-debug-status-${snapshotStatus}`}
              role="status"
              aria-live="polite"
            >
              {snapshotStatusText}
            </span>
          )}
          <a
            className="sidebar-debug-action"
            href="api/diagnostics?format=text"
            target="_blank"
            rel="noopener noreferrer"
            aria-label={diagnosticsLabel}
            title={diagnosticsLabel}
          >
            <Icon name="diagnostics" />
            {diagnosticsState !== null && <span className="sidebar-debug-dot" aria-hidden="true" />}
          </a>
          <button
            type="button"
            className="sidebar-debug-action"
            aria-label={tr("replayDemoTitle")}
            title={tr("replayDemoTitle")}
            onClick={p.onReplayDemo}
          >
            <Icon name="play" />
          </button>
          <button
            type="button"
            className="sidebar-debug-action"
            aria-label={tr("saveDebugSnapshotTitle")}
            aria-busy={snapshotBusy}
            title={
              snapshotBusy ? t("snapshotSaving") : `${tr("saveDebugSnapshotTitle")} (Alt+Shift+S)`
            }
            aria-keyshortcuts="Alt+Shift+S"
            disabled={snapshotBusy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={saveSnapshot}
          >
            <Icon name="camera" />
          </button>
        </div>
      )}
      <div className="search-bar">
        <input
          type="text"
          value={p.searchQuery}
          {...telemetryTarget("sidebar.search")}
          onChange={(e) => p.onSearchChange(e.target.value)}
          placeholder={tr("searchMessagesPlaceholder")}
          autoComplete="off"
        />
        {p.searchQuery && (
          <button className="search-clear" onClick={() => p.onSearchChange("")}>
            ×
          </button>
        )}
      </div>
      {p.searchQuery.trim() ? (
        <div className="search-results">
          {p.searchHits === null ? (
            <div className="search-empty">{tr("searching")}</div>
          ) : p.searchHits.length === 0 ? (
            <div className="search-empty">{tr("noResults")}</div>
          ) : (
            p.searchHits.map((r, i) => (
              <div
                key={i}
                className="search-result-item"
                onClick={() => p.onJump(r.workspaceId, r.messageId)}
              >
                <div className="search-result-ws">{r.workspaceName}</div>
                <div className="search-result-snippet">{r.snippet}</div>
                <div className="search-result-time">{formatShortDateTime(r.timestamp)}</div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="task-list">
          {groups.length === 0 && archived.length === 0 && (
            <div className="sidebar-empty">{tr("noWorkspacesYet")}</div>
          )}
          {live.map((g) => renderGroup(g))}
          {shelved.length > 0 && (
            <div className="ws-group ws-shelf">
              <div
                className="ws-group-header ws-archived-header"
                {...telemetryTarget("sidebar.archive_toggle")}
                onClick={() => setShelfOpen((v) => !v)}
                title={tr("archivedProjectsTitle")}
              >
                <span className="events-toggle">{showShelf ? "▾" : "▸"}</span>
                <span className="ws-group-label">{tr("archivedProjects")}</span>
                <span className="ws-group-count">{shelved.length}</span>
              </div>
              {showShelf && shelved.map((g) => renderGroup(g, true))}
            </div>
          )}
          {archived.length > 0 && (
            <div className="ws-group ws-archived">
              <div
                className="ws-group-header ws-archived-header"
                {...telemetryTarget("sidebar.archive_toggle")}
                onClick={() => setArchivedOpen((v) => !v)}
                title={tr("archivedWorkspacesTitle")}
              >
                <span className="events-toggle">{showArchived ? "▾" : "▸"}</span>
                <span className="ws-group-label">{tr("archived")}</span>
                {showArchived && <span className="ws-group-count">{archived.length}</span>}
                {showArchived && (
                  <button
                    className="ws-archived-purge"
                    title={tr("deleteLooseArchivedTitle")}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onPurgeArchived(null);
                    }}
                  >
                    {tr("clear")}
                  </button>
                )}
              </div>
              {showArchived && (
                <div className="ws-group-items">
                  {archived.map((ws) => archivedItem(ws, ws.project))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {p.quota && (
        <QuotaPanel quota={p.quota} refresh={p.onRefreshQuota} now={now} connected={p.connected} />
      )}
      {debugOpen && p.systemStatus && <SystemStatusPanel status={p.systemStatus} />}
      {deleting && (
        <ConfirmDialog
          telemetryAction="confirm.delete_session"
          title={tr("deleteSessionTitle", { name: deleting.name })}
          body={tr("deleteSessionBody")}
          confirmLabel={tr("deleteSession")}
          danger
          onConfirm={() => p.onDelete(deleting.id)}
          onClose={() => setDeleteId(null)}
        />
      )}
    </>
  );
});
