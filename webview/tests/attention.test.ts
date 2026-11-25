import { describe, expect, it } from "vitest";
import { describeAttention, summarizeAttention } from "../src/sidebar/attention";
import type { AgentInfo, Project, Workspace } from "../src/state/useServer";

const NOW = 1_800_000_000_000;
const agent = (state: AgentInfo["state"]): AgentInfo => ({
  id: "a",
  name: "Agent",
  model: "m",
  avatar: "A",
  color: "#fff",
  isDefault: true,
  state,
});
const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  project: "repo",
  hostId: "local",
  cwd: `/repo/${id}`,
  agents: [],
  messages: [],
  createdAt: NOW - 1000,
  lastMessageAt: NOW,
  ...over,
});
const project = (id: string, archivedAt?: number): Project => ({
  id,
  name: id,
  root: `/repo/${id}`,
  leadWorkspaceId: "lead",
  createdAt: NOW - 10_000,
  objectives: [],
  ...(archivedAt !== undefined && { archivedAt }),
});
const linked = (id: string, role: "lead" | "worker", over: Partial<Workspace> = {}) =>
  ws(id, { projectLink: { projectId: "p1", role }, ...over });

describe("summarizeAttention", () => {
  it("counts each live background session once with Sidebar's exact unread and running predicates", () => {
    const sessions = [
      ws("active", { unread: 5, awaitsUser: true }),
      linked("both", "worker", { unread: 8, awaitsUser: true }),
      linked("unread", "worker", { unread: 8 }),
      linked("working", "worker", { awaitsUser: true, agents: [agent("working")] }),
      linked("waiting", "worker", { awaitsUser: true, agents: [agent("waiting")] }),
      linked("archived", "worker", { archivedAt: NOW, unread: 3, awaitsUser: true }),
      ws("archived-project", {
        projectLink: { projectId: "p2", role: "worker" },
        unread: 4,
      }),
      ws("quiet"),
    ];
    expect(summarizeAttention(sessions, "active", [project("p1"), project("p2", NOW)])).toEqual({
      count: 2,
      unread: 2,
      yourTurn: 1,
    });
  });

  it("summarizes a project's lead and workers with the same background exclusion", () => {
    const sessions = [
      linked("lead", "lead", { unread: 2 }),
      linked("waiting", "worker", { awaitsUser: true }),
      linked("unread", "worker", { unread: 8 }),
    ];
    expect(summarizeAttention(sessions, "active", [project("p1")])).toEqual({
      count: 3,
      unread: 2,
      yourTurn: 1,
    });
    expect(summarizeAttention(sessions, "lead", [project("p1")])).toEqual({
      count: 2,
      unread: 1,
      yourTurn: 1,
    });
    expect(summarizeAttention(sessions, "active", [project("p1", NOW)])).toEqual({
      count: 0,
      unread: 0,
      yourTurn: 0,
    });
  });
});

describe("describeAttention", () => {
  it("states the session count and your-turn status accessibly", () => {
    expect(describeAttention({ count: 0, unread: 0, yourTurn: 0 }, "background session")).toBe(
      "no background sessions need attention",
    );
    expect(describeAttention({ count: 1, unread: 1, yourTurn: 0 }, "background session")).toBe(
      "1 background session needs attention",
    );
    expect(describeAttention({ count: 2, unread: 1, yourTurn: 1 })).toBe(
      "2 sessions need attention, 1 your turn",
    );
  });
});
