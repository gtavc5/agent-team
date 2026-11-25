import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageObservation } from "../../../shared/usage";
import { DatabaseSync } from "node:sqlite";
import { piUsage } from "../../src/session/usage-observation";
import { queryUsage, queryJourney } from "../usage-fixtures";
import { recordUsage, recordJourney } from "../../src/usage/ledger";

let dir: string;
const obs: UsageObservation = {
  source: "pi",
  sessionId: "example",
  unit: "inference",
  id: "response-1",
  model: null,
  timestamp: Date.UTC(2026, 3, 10),
  channel: "gateway",
  input: 1000,
  cacheRead: 8000,
  cacheWrite: 0,
  output: 25,
  price: { kind: "unpriced", usd: null },
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yaat-usage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("durable usage", () => {
  it("preserves live-only observations and events across a competing writer and reopen", () => {
    queryUsage(dir);
    const lock = new DatabaseSync(join(dir, ".agent-team", "usage.sqlite"));
    const fact = { ...obs, source: "codex" as const };
    const event = {
      id: "item",
      source: "codex" as const,
      sessionId: "example",
      timestamp: null,
      kind: "tool" as const,
      name: "command",
    };
    try {
      lock.exec("BEGIN IMMEDIATE");
      recordUsage(dir, fact);
      recordJourney(dir, event);
    } finally {
      lock.close();
    }
    expect(queryUsage(dir)).toEqual([fact]);
    expect(queryJourney(dir)).toEqual([event]);
    expect(queryUsage(dir)).toEqual([fact]);
  });
  it("does not count an aborted Pi placeholder as a native inference", () => {
    expect(
      piUsage(
        "session",
        {
          role: "assistant",
          stopReason: "aborted",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        "entry",
      ),
    ).toBeNull();
  });
  it("preserves all tokens without a price and deduplicates on reopen", () => {
    recordUsage(dir, obs);
    recordUsage(dir, obs);
    expect(queryUsage(dir)).toEqual([obs]);
  });
  it("freezes a dated channel estimate; an exact receipt replaces it without adding requests", () => {
    const rate = {
      channel: "gateway",
      effective: "2026-03-01",
      input: 1,
      cacheRead: 0.1,
      cacheWrite: 1,
      output: 8,
    };
    const file = join(dir, "usage-pricing.json");
    writeFileSync(
      file,
      JSON.stringify({ schedules: [{ ...rate, effective: "2026-07-01", input: 7 }, rate] }),
    );
    recordUsage(dir, obs);
    const price = { kind: "channel-estimate", usd: 0.002, asOf: rate.effective };
    expect(queryUsage(dir)).toEqual([{ ...obs, price }]);
    writeFileSync(file, "{}");
    recordUsage(dir, obs);
    expect(queryUsage(dir)[0].price).toEqual(price);
    const receipt = {
      source: obs.source,
      id: obs.id,
      sessionId: obs.sessionId,
      asOf: "2026-05-01",
      usd: 0.007,
    };
    writeFileSync(file, JSON.stringify({ receipts: [receipt] }));
    expect(queryUsage(dir)).toEqual([
      { ...obs, price: { kind: "reported", usd: receipt.usd, asOf: receipt.asOf } },
    ]);
    writeFileSync(file, "{}");
    expect(queryUsage(dir)[0].price.kind).toBe("reported");
  });
});
