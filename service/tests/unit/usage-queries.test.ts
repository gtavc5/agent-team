import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { JourneyEvent, UsageFilters, UsageObservation } from "../../../shared/usage";
import {
  maintainUsageLedger,
  recordJourney,
  recordUsage,
  withLedger,
} from "../../src/usage/ledger";
import { journey, overview } from "../../src/usage/queries";
import { saveIndex, saveWorkspace } from "../../src/workspace/state";

const DAY = 86_400_000;
const since = Date.UTC(2026, 3, 10);
const q: UsageFilters = { since, until: since + 2 * DAY, unit: "inference" };
const obs: UsageObservation = {
  id: "response",
  source: "pi",
  sessionId: "session",
  turnId: "turn",
  unit: "inference",
  timestamp: since,
  model: "example",
  channel: "gateway",
  input: 3,
  cacheRead: 96,
  cacheWrite: 1,
  output: 10,
  price: { kind: "unpriced", usd: null },
};
const event: JourneyEvent = {
  id: "tool",
  source: obs.source,
  sessionId: obs.sessionId,
  turnId: obs.turnId,
  timestamp: obs.timestamp,
  kind: "tool",
  name: "Read",
};
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yaat-usage-query-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("aggregates exactly one unit, disjoint counts, eligible inference shares, and UTC trend buckets", () => {
  for (const fact of [
    obs,
    {
      ...obs,
      id: "next-day",
      timestamp: since + DAY,
      model: null,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    { ...obs, id: "turn", unit: "turn" },
    { ...obs, id: "session", unit: "session" },
    { ...obs, id: "before", timestamp: since - 1 },
    { ...obs, id: "after", timestamp: q.until },
    { ...obs, id: "undated", timestamp: null },
  ] satisfies UsageObservation[])
    recordUsage(dir, fact);
  recordJourney(dir, { ...event, timestamp: null });
  expect(overview(dir, q)).toEqual({
    count: 2,
    input: 3,
    cacheRead: 96,
    cacheWrite: 1,
    output: 20,
    promptBearing: 1,
    eligible: 1,
    at96: 1,
    unpriced: 2,
    costs: { reported: null, "channel-estimate": null, "api-equivalent": null },
    trend: [
      {
        day: "2026-04-10",
        input: 3,
        cacheRead: 96,
        cacheWrite: 1,
        output: 10,
        models: [{ model: "example", tokens: 110 }],
        other: 0,
      },
      {
        day: "2026-04-11",
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 10,
        models: [{ model: null, tokens: 10 }],
        other: 0,
      },
    ],
    ranking: [
      { model: "example", tokens: 110 },
      { model: null, tokens: 10 },
    ],
  });
  expect(overview(dir, { ...q, unit: "turn" })).toMatchObject({
    count: 1,
    promptBearing: 1,
    eligible: 0,
    at96: 0,
  });
  expect(journey(dir, { ...q, unit: "session" })).toEqual({
    total: 1,
    page: 1,
    pageSize: 30,
    rows: [{ ...obs, id: "session", unit: "session" }],
    nextCursor: null,
  });
});

it("returns only the top six models without dropping other models from token and cost totals", () => {
  for (let i = 1; i <= 20; i++)
    recordUsage(dir, {
      ...obs,
      id: `m${i}`,
      model: `model-${i}`,
      input: i,
      price:
        i === 1
          ? { kind: "reported", usd: 1 }
          : i === 2
            ? { kind: "channel-estimate", usd: 2 }
            : i === 3
              ? { kind: "api-equivalent", usd: 3 }
              : obs.price,
    });
  const r = overview(dir, q);
  expect(r.ranking.map((m) => m.model)).toEqual(
    Array.from({ length: 6 }, (_, i) => `model-${20 - i}`),
  );
  expect(r).toMatchObject({
    count: 20,
    input: 210,
    unpriced: 17,
    costs: { reported: 1, "channel-estimate": 2, "api-equivalent": 3 },
  });
});

it("applies combined filters and verified many-to-many workspace linkage without imputing event models", () => {
  recordUsage(dir, obs);
  recordUsage(dir, { ...obs, workspaceId: "a" });
  recordUsage(dir, { ...obs, workspaceId: "b" });
  recordUsage(dir, { ...obs, id: "other-model", model: "other" });
  recordUsage(dir, { ...obs, id: "other-channel", channel: "other" });
  recordUsage(dir, { ...obs, source: "codex" });
  recordUsage(dir, { ...obs, id: "different-turn", turnId: "next" });
  recordUsage(dir, { ...obs, sessionId: "other" });
  recordJourney(dir, event);
  recordJourney(dir, { ...event, id: "unknown-turn", turnId: undefined });
  const scope = {
    ...q,
    source: obs.source,
    session: obs.sessionId,
    turn: obs.turnId,
    workspace: "a",
  };
  expect(journey(dir, { ...scope, unit: "turn" }).rows).toEqual([event]);
  expect(journey(dir, { ...scope, unit: "turn", model: obs.model! }).rows).toEqual([]);
  expect(journey(dir, { ...scope, model: obs.model!, channel: obs.channel }).rows).toEqual([obs]);
  expect(
    overview(dir, { ...scope, workspace: "b", model: obs.model!, channel: obs.channel }).count,
  ).toBe(1);
  expect(journey(dir, { ...q, channel: obs.channel }).rows).not.toContainEqual(event);
  expect(journey(dir, { ...q, workspace: "a", source: "codex" }).rows).toEqual([]);
  expect(overview(dir, { ...q, workspace: "session" }).count).toBe(0);
});

it("orders the complete identity DESC and pages across an event and observation with the same key", () => {
  for (let i = 34; i >= 0; i--) recordUsage(dir, { ...obs, id: String(i).padStart(2, "0") });
  recordJourney(dir, { ...event, id: "06" });
  const newest = { ...event, id: "00", timestamp: since + 1 };
  recordJourney(dir, newest);
  const first = journey(dir, q);
  expect(first).toMatchObject({ total: 37, pageSize: 30, page: 1 });
  expect(first.rows).toEqual([
    newest,
    ...Array.from({ length: 28 }, (_, i) => ({ ...obs, id: String(34 - i).padStart(2, "0") })),
    { ...event, id: "06" },
  ]);
  expect(first.nextCursor).toEqual(expect.any(String));
  const second = {
    total: 37,
    pageSize: 30,
    page: 2,
    rows: Array.from({ length: 7 }, (_, i) => ({ ...obs, id: `0${6 - i}` })),
    nextCursor: null,
  };
  expect(journey(dir, q, first.nextCursor!)).toEqual(second);
  expect(journey(dir, q, undefined, 2)).toEqual(second);
  expect(journey(dir, q, undefined, 99)).toEqual(second);
  expect(journey(dir, { ...q, model: "no match" }, undefined, 99)).toEqual({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 30,
    nextCursor: null,
  });
  expect(() => journey(dir, q, "invalid")).toThrow(RangeError);
  expect(() => journey(dir, q, Buffer.from("{}").toString("base64url"))).toThrow(RangeError);
  expect(() => overview(dir, { ...q, until: q.since + 90 * DAY + 1 })).toThrow(RangeError);
  expect(() => journey(dir, { ...q, until: q.since })).toThrow(RangeError);
});

it("orders tied sources and sessions DESC and never repeats events after an observation cursor", () => {
  const second = { ...obs, id: "z", sessionId: "a" };
  const third = { ...obs, id: "z", source: "codex" } as const;
  for (const row of [second, third, obs]) recordUsage(dir, row);
  const tied = { ...event, id: obs.id };
  recordJourney(dir, tied);
  const cursor = Buffer.from(
    JSON.stringify([obs.timestamp, obs.source, obs.sessionId, obs.id, 0]),
  ).toString("base64url");
  expect(journey(dir, q).rows).toEqual([tied, obs, second, third]);
  expect(journey(dir, q, cursor).rows).toEqual([second, third]);
});

it("reads only committed facts and prices until collector maintenance replays pending facts and receipts", () => {
  withLedger(dir, () => {});
  const config = join(dir, "usage-pricing.json");
  writeFileSync(
    config,
    JSON.stringify({
      schedules: [
        {
          channel: obs.channel,
          effective: "2026-04-01",
          input: 1,
          cacheRead: 1,
          cacheWrite: 1,
          output: 1,
        },
      ],
    }),
  );
  const lock = new DatabaseSync(join(dir, ".agent-team", "usage.sqlite"));
  try {
    lock.exec("BEGIN IMMEDIATE");
    recordUsage(dir, { ...obs, workspaceId: "a" });
    recordJourney(dir, event);
  } finally {
    lock.close();
  }
  writeFileSync(config, "{}");
  const scope = { ...q, workspace: "a" };
  expect(journey(dir, scope).rows).toEqual([]);
  maintainUsageLedger(dir);
  expect(journey(dir, scope).rows).toEqual([
    { ...event, workspaceId: "a" },
    {
      ...obs,
      workspaceId: "a",
      price: { kind: "channel-estimate", usd: 0.00011, asOf: "2026-04-01" },
    },
  ]);
  expect(overview(dir, scope).costs).toEqual({
    reported: null,
    "channel-estimate": 0.00011,
    "api-equivalent": null,
  });
  writeFileSync(
    config,
    JSON.stringify({
      receipts: [
        { source: obs.source, sessionId: obs.sessionId, id: obs.id, asOf: "2026-04-11", usd: 0 },
      ],
    }),
  );
  expect(overview(dir, scope).costs.reported).toBeNull();
  maintainUsageLedger(dir);
  expect(overview(dir, scope)).toMatchObject({
    count: 1,
    unpriced: 0,
    costs: { reported: 0, "channel-estimate": null },
  });
  writeFileSync(config, "{}");
  expect(journey(dir, scope).rows[1]).toMatchObject({
    price: { kind: "reported", usd: 0, asOf: "2026-04-11" },
  });
});

it("migrates v1 JSON facts, supporting dated indexes without changing stored data", () => {
  const store = join(dir, ".agent-team");
  mkdirSync(store);
  const old = new DatabaseSync(join(store, "usage.sqlite"));
  try {
    old.exec(`CREATE TABLE observations (source TEXT, session TEXT, id TEXT, fact TEXT, PRIMARY KEY(source,session,id));
      CREATE TABLE journey (source TEXT, session TEXT, id TEXT, fact TEXT, PRIMARY KEY(source,session,id));
      CREATE TABLE receipts (source TEXT, session TEXT, id TEXT, dated TEXT, usd REAL, PRIMARY KEY(source,session,id));
      PRAGMA user_version=1;`);
    old
      .prepare("INSERT INTO observations VALUES(?,?,?,?)")
      .run(obs.source, obs.sessionId, obs.id, JSON.stringify(obs));
    old
      .prepare("INSERT INTO journey VALUES(?,?,?,?)")
      .run(event.source, event.sessionId, event.id, JSON.stringify(event));
  } finally {
    old.close();
  }
  expect(overview(dir, q)).toMatchObject({ count: 1, at96: 1 });
  expect(journey(dir, q)).toEqual({
    rows: [event, obs],
    total: 2,
    page: 1,
    pageSize: 30,
    nextCursor: null,
  });
  expect(withLedger(dir, (db) => db.prepare("PRAGMA user_version").get()?.user_version)).toBe(2);
});

it("floors epoch ms to UTC hours across midnight and merges effort variants before selecting the top six", () => {
  const hour = 3_600_000;
  const models = [
    "family-minimal",
    "family-LOW",
    "family-medium",
    "family-HIGH",
    "family-xhigh",
    "family-max",
    "family",
  ];
  for (const [i, model] of models.entries()) {
    recordUsage(dir, {
      ...obs,
      model,
      id: model,
      timestamp: since + (i === 0 ? DAY - 1 : DAY),
      input: 2,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
    });
  }
  for (const [i, model] of ["family-highspeed", "v1", "v2", "v3", null, "v4", "v5"].entries()) {
    recordUsage(dir, {
      ...obs,
      model,
      id: `extra${i}`,
      timestamp: since + DAY + hour - 1,
      input: 10 - i,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
    });
  }
  const result = overview(dir, { ...q, granularity: "hour" });
  expect(result.ranking).toEqual([
    { model: "family", tokens: 14 },
    { model: "family-highspeed", tokens: 10 },
    { model: "v1", tokens: 9 },
    { model: "v2", tokens: 8 },
    { model: "v3", tokens: 7 },
    { model: null, tokens: 6 },
  ]);
  expect(result.trend).toEqual([
    {
      day: "2026-04-10T23:00:00Z",
      input: 2,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      models: [{ model: "family", tokens: 2 }],
      other: 0,
    },
    {
      day: "2026-04-11T00:00:00Z",
      input: 61,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      models: [
        { model: null, tokens: 6 },
        { model: "family", tokens: 12 },
        { model: "family-highspeed", tokens: 10 },
        { model: "v1", tokens: 9 },
        { model: "v2", tokens: 8 },
        { model: "v3", tokens: 7 },
      ],
      other: 9,
    },
  ]);
  recordUsage(dir, { ...obs, id: "previous-epoch", timestamp: -1 });
  expect(
    overview(dir, { since: -hour, until: 1, unit: q.unit, granularity: "hour" }).trend[0]?.day,
  ).toBe("1969-12-31T23:00:00Z");
});

it("matches literal substrings in model, channel, workspace name and IDs without guessing workspaces", () => {
  const active = {
    id: "ws-active",
    name: "Café %_ Active",
    project: "p",
    hostId: "h",
    cwd: dir,
    agents: [],
    createdAt: since,
  };
  const archived = { ...active, id: "ws-old", name: "Prior %_ Work", archivedAt: since };
  saveWorkspace(dir, active);
  saveWorkspace(dir, archived);
  saveIndex(dir, [active.id, archived.id]);
  const first = {
    ...obs,
    model: "Prefix%_Model",
    channel: "EDGE_%West",
    sessionId: "native-SESSION",
    piSessionId: "Parent-ABC",
  };
  const next = {
    ...first,
    id: "different",
    model: "PrefixXXModel",
    sessionId: "another",
    workspaceId: active.id,
  };
  const own = { ...first, id: "own", workspaceId: archived.id };
  recordUsage(dir, first);
  recordUsage(dir, own);
  recordUsage(dir, next);
  recordJourney(dir, { ...event, sessionId: first.sessionId });
  const scope = {
    ...q,
    model: "%_mOD",
    channel: "e_%w",
    session: "ve-sess",
    workspace: "OR %_ WO",
  };
  expect(overview(dir, scope).count).toBe(2);
  expect(journey(dir, { ...scope, session: "ENT-aBC" }).rows).toEqual([
    { ...first, workspaceId: archived.id, workspaceName: archived.name },
    { ...own, workspaceName: archived.name },
  ]);
  expect(journey(dir, { ...q, workspace: "CAFÉ %_" }).rows).toEqual([
    { ...next, workspaceName: active.name },
  ]);
  const archivedRows = journey(dir, { ...q, workspace: "WS-OL" });
  expect(archivedRows.total).toBe(3);
  expect(archivedRows.rows[0]).toEqual({
    ...event,
    sessionId: first.sessionId,
    workspaceId: archived.id,
    workspaceName: archived.name,
  });
  expect(overview(dir, { ...scope, workspace: "%_no" }).count).toBe(0);
  expect(overview(dir, { ...scope, turn: "TURN" }).count).toBe(0);
  expect(overview(dir, { ...scope, turn: "ur" }).count).toBe(0);
  expect(overview(dir, { ...scope, turn: "turn" }).count).toBe(2);
  recordUsage(dir, { ...first, workspaceId: active.id });
  expect(journey(dir, scope).rows).toEqual([first, { ...own, workspaceName: archived.name }]);
});
