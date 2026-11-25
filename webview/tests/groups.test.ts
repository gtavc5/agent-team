import { describe, it, expect } from "vitest";
import {
  groupWorkspaces,
  isGroupExpanded,
  STALE_MS,
  archivedWorkspaces,
  isArchived,
  initialIdleWorkers,
  archivedFolderLabel,
  IDLE_FOLD_MS,
} from "../src/sidebar/groups";
import { Workspace } from "../src/state/useServer";

const NOW = 1_800_000_000_000;

function ws(id: string, cwd: string, lastMessageAt: number, busy = false): Workspace {
  return {
    id,
    name: id,
    project: cwd.split("/").pop() ?? "",
    hostId: "local",
    cwd,
    git: null,
    pr: null,
    agents: busy
      ? [{ id: "a", name: "A", model: "m", avatar: "x", color: "#fff", isDefault: true, busy }]
      : [],
    messages: [],
    createdAt: lastMessageAt - 1000,
    lastMessageAt,
  };
}

describe("groupWorkspaces", () => {
  it("orders groups and members by creation, not changes in last activity", () => {
    const groups = groupWorkspaces([
      { ...ws("old-a", "/repo/a", NOW - 10 * 86_400_000), lastMessageAt: NOW },
      ws("new-b", "/repo/b", NOW - 1000),
      ws("new-a", "/repo/a", NOW - 2000),
    ]);
    // /repo/a has the latest message but does not move.
    expect(groups.map((g) => g.key)).toEqual(["/repo/b", "/repo/a"]);
    expect(groups[1].workspaces.map((w) => w.id)).toEqual(["new-a", "old-a"]);
    expect(groups[1].label).toBe("a");
    expect(groups[1].lastActive).toBe(NOW);
  });

  it("marks groups with busy agents as running", () => {
    const groups = groupWorkspaces([
      ws("idle", "/repo/a", NOW),
      ws("busy", "/repo/a", NOW - 500, true),
    ]);
    expect(groups[0].running).toBe(true);
  });
});

describe("isGroupExpanded", () => {
  const fresh = groupWorkspaces([ws("f", "/repo/fresh", NOW - 1000)])[0];
  const stale = groupWorkspaces([ws("s", "/repo/stale", NOW - STALE_MS - 1)])[0];
  const staleRunning = groupWorkspaces([ws("r", "/repo/run", NOW - STALE_MS - 1, true)])[0];

  it("expands recent groups and collapses stale ones by default", () => {
    expect(isGroupExpanded(fresh, {}, NOW)).toBe(true);
    expect(isGroupExpanded(stale, {}, NOW)).toBe(false);
  });

  it("keeps a stale group expanded while something is running in it", () => {
    expect(isGroupExpanded(staleRunning, {}, NOW)).toBe(true);
  });

  it("lets explicit user toggles override the defaults", () => {
    expect(isGroupExpanded(fresh, { "/repo/fresh": false }, NOW)).toBe(false);
    expect(isGroupExpanded(stale, { "/repo/stale": true }, NOW)).toBe(true);
  });

  it("expands a stale group holding the active workspace, unless collapsed by hand", () => {
    expect(isGroupExpanded(stale, {}, NOW, true)).toBe(true);
    // The active group must still be collapsible — explicit toggle wins.
    expect(isGroupExpanded(fresh, { "/repo/fresh": false }, NOW, true)).toBe(false);
  });
});

describe("running state includes background subagents", () => {
  it("marks a group running when an agent is waiting on background work, not when sleeping", () => {
    const w = ws("bg", "/repo/bg", NOW - 1000);
    w.agents = [
      {
        id: "a",
        name: "A",
        model: "m",
        avatar: "x",
        color: "#fff",
        isDefault: true,
        state: "waiting",
      },
    ];
    const groups = groupWorkspaces([w]);
    expect(groups[0].running).toBe(true);
    expect(groups[0].status).toBe("waiting");
    w.agents = [{ ...w.agents[0], state: "sleeping" }];
    expect(groupWorkspaces([w])[0].running).toBe(false);
    expect(groupWorkspaces([w])[0].status).toBe("sleeping");
    w.agents = [{ ...w.agents[0], state: "working" }];
    expect(groupWorkspaces([w])[0].status).toBe("working");
    w.agents = [{ ...w.agents[0], state: "idle" }];
    expect(groupWorkspaces([w])[0].status).toBe("idle");
    // Running keeps even a stale group expanded.
    expect(isGroupExpanded({ ...groups[0], lastActive: NOW - STALE_MS - 1 }, {}, NOW)).toBe(true);
  });
});

describe("archived workspaces", () => {
  it("keeps archived workspaces out of the folder groups", () => {
    const live = ws("live", "/repo/a", NOW - 1000);
    const old = { ...ws("old", "/repo/a", NOW - 20 * 86_400_000), archivedAt: NOW - 1000 };
    const groups = groupWorkspaces([live, old]);
    expect(groups).toHaveLength(1);
    expect(groups[0].workspaces.map((w) => w.id)).toEqual(["live"]);
    expect(isArchived(old)).toBe(true);
    expect(isArchived(live)).toBe(false);
  });

  it("lists archived workspaces newest first, and drops the group when all are archived", () => {
    const a = { ...ws("a", "/repo/x", NOW - 5000), archivedAt: NOW };
    const b = { ...ws("b", "/repo/y", NOW - 1000), archivedAt: NOW };
    expect(archivedWorkspaces([a, b]).map((w) => w.id)).toEqual(["b", "a"]);
    expect(groupWorkspaces([a, b])).toEqual([]);
  });
});

describe("initial idle worker folding", () => {
  const project = {
    id: "p1",
    name: "clice",
    root: "/repo/clice",
    leadWorkspaceId: "lead",
    createdAt: 0,
    objectives: [],
  };
  const lead = {
    ...ws("lead", "/repo/clice", NOW),
    projectLink: { projectId: "p1", role: "lead" as const },
  };
  const worker = (id: string, at: number, lastResult?: "done") => ({
    ...ws(id, "/repo/clice-wt-1", at),
    projectLink: { projectId: "p1", role: "worker" as const },
    ...(lastResult && { lastResult }),
  });
  const folded = (workers: Workspace[]) =>
    initialIdleWorkers(groupWorkspaces([lead, ...workers], [project])[0], null, NOW);

  it("folds done workers immediately and quiet null-result workers at one hour", () => {
    expect(IDLE_FOLD_MS).toBe(60 * 60 * 1000);
    expect(STALE_MS).toBe(3 * 86_400_000);
    expect(
      folded([
        worker("done-fresh", NOW - 1000, "done"),
        worker("fresh", NOW - IDLE_FOLD_MS + 1),
        worker("boundary", NOW - IDLE_FOLD_MS),
        worker("old", NOW - IDLE_FOLD_MS - 1),
      ]),
    ).toEqual(["done-fresh", "boundary", "old"]);
  });

  it("uses latest activity and never folds the active or attention worker", () => {
    const active = worker("active", NOW - IDLE_FOLD_MS);
    const attention = { ...worker("attention", NOW - IDLE_FOLD_MS), awaitsUser: true };
    const freshActivity = worker("fresh-activity", NOW - IDLE_FOLD_MS);
    freshActivity.lastMessageAt = NOW - 1000;
    expect(folded([attention, freshActivity])).toEqual([]);
    expect(
      initialIdleWorkers(groupWorkspaces([lead, active], [project])[0], active.id, NOW),
    ).toEqual([]);
  });
});

describe("archived folder labels", () => {
  const project = {
    id: "p1",
    name: "clice",
    root: "/repo/clice",
    leadWorkspaceId: "lead",
    createdAt: 0,
    objectives: [],
  };
  const label = (cwd: string) => archivedFolderLabel(ws("old", cwd, NOW), project);

  it("suppresses the root, descendants, and project worktree paths", () => {
    expect(label("/repo/clice")).toBeNull();
    expect(label("/repo/clice/")).toBeNull();
    expect(label("/repo/clice/packages/app")).toBeNull();
    expect(label("/repo/clice-wt-1")).toBeNull();
    expect(label("/repo/clice-wt-1/packages/app")).toBeNull();
    expect(label("/home/u/worktrees/clice-wt-2")).toBeNull();
  });

  it("keeps genuinely external folders and similarly prefixed projects", () => {
    expect(label("/repo/clice-next")).toBe("clice-next");
    expect(label("/wt/clice-x")).toBe("clice-x");
    expect(label("/home/u/worktrees/other-wt-1")).toBe("other-wt-1");
    expect(label("/repo/clice-wt-")).toBe("clice-wt-");
    expect(label("/home/u/worktrees/clice-wt-")).toBe("clice-wt-");
    expect(archivedFolderLabel(ws("old", "/external", NOW))).toBe("external");
  });
});

describe("a project's archive", () => {
  it("holds its archived sessions, dated by them too; those in no project stay apart", () => {
    const project = {
      id: "p1",
      name: "clice",
      root: "/repo/clice",
      leadWorkspaceId: "lead",
      createdAt: 0,
      objectives: [],
    };
    const lead = {
      ...ws("lead", "/repo/clice", 1000),
      projectLink: { projectId: "p1", role: "lead" as const },
    };
    const old = {
      ...ws("old", "/repo/clice", 5000),
      archivedAt: 6000,
      projectLink: { projectId: "p1", role: "worker" as const },
    };
    const loose = { ...ws("loose", "/repo/other", 3000), archivedAt: 4000 };
    const [g] = groupWorkspaces([lead, old, loose], [project]);
    expect(g.workspaces.map((w) => w.id)).toEqual(["lead"]);
    expect(g.archived.map((w) => w.id)).toEqual(["old"]);
    expect(g.lastActive).toBe(5000);
    expect(archivedWorkspaces([lead, old, loose], [project]).map((w) => w.id)).toEqual(["loose"]);
  });

  it("treats busy:true with explicit state:'idle' as working (agent_busy before agent_state)", () => {
    const starting = {
      ...ws("starting", "/repo/a", 2000),
      agents: [
        {
          id: "a",
          name: "A",
          model: "m",
          avatar: "x",
          color: "#fff",
          isDefault: true,
          busy: true,
          state: "idle" as const,
        },
      ],
    };
    const [g] = groupWorkspaces([starting]);
    expect(g.status).toBe("working");
    expect(g.running).toBe(true);
  });
});
