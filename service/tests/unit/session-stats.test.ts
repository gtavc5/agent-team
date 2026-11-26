import { expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Auth } from "../../src/server/auth";
import { HttpHandler } from "../../src/server/http";
import { recordUsage } from "../../src/usage/ledger";
import { lifecycleWriter } from "../../src/usage/lifecycle";
import { historyOf, closeHistory } from "../../src/workspace/state";
import { projectStats, sessionStats, statsRequest } from "../../src/usage/session-stats";
import type { SessionStatsPage } from "../../../shared/session-stats";
import type { UsageObservation } from "../../../shared/usage";

const model = (
  id: string,
  turnId: string,
  timestamp: number,
  input: number,
  model = "m",
): UsageObservation => ({
  source: "codex",
  sessionId: "session",
  unit: "inference",
  id,
  turnId,
  timestamp,
  input,
  cacheRead: 2,
  cacheWrite: 1,
  output: 20,
  model,
  price: { kind: "unpriced", usd: null },
});

it("computes disjoint prompt deltas before slicing turns and resets at compactions, missing samples and model switches", () => {
  const facts = [
    model("a", "1", 1, 10),
    model("b", "2", 3, 13),
    {
      id: "compact",
      kind: "compaction" as const,
      name: "compact",
      source: "codex" as const,
      sessionId: "session",
      turnId: "2",
      timestamp: 4,
    },
    model("c", "3", 5, 2),
    model("d", "3", 6, 8, "new"),
    { ...model("e", "4", 7, 9), model: null },
    model("f", "4", 8, 0),
  ];
  const view = projectStats([], facts, 0, 10);
  expect(view.turns.map((t) => t.turnId)).toEqual(["4", "3", "2", "1"]);
  const models = view.turns.flatMap((t) => t.steps).filter((s) => s.kind === "model");
  expect(models.map((s) => [s.inferenceId, s.promptTokens, s.boundary, s.promptDelta])).toEqual([
    ["e", 12, "gap", undefined],
    ["f", 3, "gap", undefined],
    ["c", 5, "compaction", undefined],
    ["d", 11, "model switch", undefined],
    ["b", 16, undefined, 3],
    ["a", 13, "gap", undefined],
  ]);
  expect(projectStats([], facts, 2, 1).turns).toEqual(view.turns.slice(2, 3));
  expect(models.every((s) => s.stepStart === undefined)).toBe(true);
});

it("never computes a delta across an unorderable receipt in the same session", () => {
  const stats = projectStats(
    [],
    [
      model("first", "t", 2, 100),
      { ...model("undated", "t", 3, 800), timestamp: null },
      model("last", "t", 4, 150),
    ],
    0,
    10,
  );
  expect(stats.turns[0].steps.find((s) => s.stepId === "last")).toMatchObject({ boundary: "gap" });
  expect(stats.turns[0].steps.every((s) => s.promptDelta === undefined)).toBe(true);
});

it("joins native journey item IDs and preserves the original trigger across continuations", () => {
  const base = { source: "codex" as const, sessionId: "thread", turnId: "turn" };
  const page = projectStats(
    [
      { ...base, stepId: "input", kind: "user", marker: "stepEnd", at: 10, trigger: "lead" },
      { ...base, stepId: "tool", toolCallId: "tool", kind: "tool", marker: "toolStart", at: 20 },
      { ...base, stepId: "compact", kind: "compaction", marker: "compaction", at: 30 },
      {
        ...base,
        stepId: "answer",
        kind: "model",
        marker: "stepStart",
        at: 40,
        trigger: "continuation",
      },
    ],
    (["tool", "compaction"] as const).map((kind, i) => ({
      ...base,
      kind,
      name: kind,
      id: JSON.stringify(["codex", "thread", "turn", i === 0 ? "tool" : "compact"]),
      timestamp: null,
    })),
    0,
    20,
  );
  expect(page.turns[0].trigger).toBe("lead");
  expect(page.turns[0].steps.map((s) => s.stepId)).toEqual(["input", "tool", "compact", "answer"]);
  expect(page.turns[0].steps[3]).toMatchObject({ trigger: "continuation", boundary: "compaction" });
});

it("keeps an unbound ACP receipt unattributed rather than guessing a turn or observed latency", () => {
  const receipt = {
    ...model("0", "x", 1, 0),
    source: "acp" as const,
    turnId: undefined,
    piSessionId: "pi",
    model: null,
  };
  const page = projectStats([], [receipt], 0, 20);
  expect(page.turns).toHaveLength(1);
  expect(page.turns[0].trigger).toBe("Unattributed history");
  expect(page.turns[0].steps[0]).toEqual({
    stepId: "0",
    kind: "model",
    inferenceId: "0",
    promptTokens: 3,
    boundary: "gap",
  });
});

it("shows a read-only transcript-only legacy turn without inventing prompt tokens or timing", () => {
  const base = mkdtempSync(join(tmpdir(), "stats-legacy-"));
  try {
    historyOf(base).save(
      "legacy",
      [
        {
          id: "reply",
          kind: "agent",
          agentId: "legacy-agent",
          content: "DO NOT COPY",
          timestamp: 345,
          status: "done",
          turnId: "archived-turn",
          model: "legacy-model",
        },
      ],
      "all",
    );
    closeHistory(base);
    const page = sessionStats(base, { workspaceId: "legacy", offset: 0, limit: 20 });
    expect(page.turns).toEqual([
      {
        turnId: "archived-turn",
        trigger: "Unknown",
        steps: [{ stepId: "reply", kind: "model", model: "legacy-model", boundary: "gap" }],
      },
    ]);
  } finally {
    closeHistory(base);
    rmSync(base, { recursive: true, force: true });
  }
});

it("serves persisted observations on reload without leaking another workspace or duplicating an inference", async () => {
  const base = mkdtempSync(join(tmpdir(), "stats-http-"));
  const handler = new HttpHandler(new Auth(() => null), base, base, base, (id) =>
    id === "ws" ? base : undefined,
  );
  const server = createServer((req, res) => handler.handle(req, res));
  try {
    const fact = model("inference", "turn", 10, 17);
    recordUsage(base, { ...fact, workspaceId: "ws" });
    recordUsage(base, { ...model("other", "turn", 12, 999), workspaceId: "other" });
    const write = lifecycleWriter(
      { dataDir: base, workspaceId: "ws" },
      "codex",
      () => fact.sessionId,
    )!;
    const step = {
      turnId: "turn",
      stepId: "item",
      kind: "model" as const,
      inferenceId: "inference",
    };
    write({ ...step, marker: "stepStart", at: 100 });
    write({ ...step, marker: "firstDelta", at: 130 });
    write({ ...step, marker: "stepEnd", at: 140 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("missing address");
    const url = `http://127.0.0.1:${address.port}/api/workspaces/ws/stats`;
    const page = (await (await fetch(url)).json()) as SessionStatsPage;
    expect(page.turns[0].steps).toEqual([
      {
        stepId: "item",
        kind: "model",
        inferenceId: "inference",
        stepStart: 100,
        firstDelta: 130,
        stepEnd: 140,
        model: "m",
        promptTokens: 20,
        boundary: "gap",
      },
    ]);
    expect(await (await fetch(url)).json()).toEqual(page);
    expect((await fetch(url + "?limit=0")).status).toBe(400);
    expect((await fetch(url.replace("/ws/", "/missing/"))).status).toBe(404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(base, { recursive: true, force: true });
  }
});

it("validates bounded pagination and rejects duplicate, fractional and overflowing parameters", () => {
  for (const query of [
    "limit=0",
    "limit=101",
    "offset=-1",
    "offset=1.5",
    "offset=9007199254740992",
    "limit=2&limit=3",
    "any=1",
  ])
    expect(() => statsRequest("workspace", new URLSearchParams(query))).toThrow(RangeError);
  expect(statsRequest("workspace", new URLSearchParams())).toEqual({
    workspaceId: "workspace",
    offset: 0,
    limit: 20,
  });
});
