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
      { day: "2026-04-10", input: 3, cacheRead: 96, cacheWrite: 1, output: 10 },
      { day: "2026-04-11", input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
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

it("applies exact filters and verified many-to-many workspace linkage without imputing event models", () => {
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

it("pages by timestamp and complete identity, including an event and observation with the same key", () => {
  for (let i = 34; i >= 0; i--) recordUsage(dir, { ...obs, id: String(i).padStart(2, "0") });
  recordJourney(dir, { ...event, id: "29" });
  recordJourney(dir, { ...event, id: "00", timestamp: since + 1 });
  const first = journey(dir, q);
  expect(first.rows.map((r) => r.id)).toEqual(
    Array.from({ length: 30 }, (_, i) => String(i).padStart(2, "0")),
  );
  expect(first.nextCursor).toEqual(expect.any(String));
  expect(journey(dir, q, first.nextCursor!)).toEqual({
    rows: [
      { ...event, id: "29" },
      ...Array.from({ length: 5 }, (_, i) => ({ ...obs, id: String(i + 30) })),
      { ...event, id: "00", timestamp: since + 1 },
    ],
    nextCursor: null,
  });
  expect(() => journey(dir, q, "invalid")).toThrow(RangeError);
  expect(() => journey(dir, q, Buffer.from("{}").toString("base64url"))).toThrow(RangeError);
  expect(() => overview(dir, { ...q, until: q.since + 90 * DAY + 1 })).toThrow(RangeError);
  expect(() => journey(dir, { ...q, until: q.since })).toThrow(RangeError);
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
    {
      ...obs,
      workspaceId: "a",
      price: { kind: "channel-estimate", usd: 0.00011, asOf: "2026-04-01" },
    },
    event,
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
  expect(journey(dir, scope).rows[0]).toMatchObject({
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
  expect(journey(dir, q)).toEqual({ rows: [obs, event], nextCursor: null });
  expect(withLedger(dir, (db) => db.prepare("PRAGMA user_version").get()?.user_version)).toBe(2);
});
