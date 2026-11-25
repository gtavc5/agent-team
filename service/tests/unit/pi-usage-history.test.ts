import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { piUsage } from "../../src/session/usage-observation";
import { queryUsage, queryJourney } from "../usage-fixtures";
import { recordUsage } from "../../src/usage/ledger";
import { syncPi } from "../../src/usage/sync";

it("joins live and persisted Pi evidence once, resuming after an incomplete line", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-usage-"));
  try {
    const id = "00000000-0000-4000-9000-111111111111";
    const folder = join(base, "pi-sessions", "workspace");
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `sample_${id}.jsonl`);
    const msg = {
      role: "assistant",
      provider: "example",
      model: "fixture",
      responseId: "ref",
      timestamp: 100,
      usage: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, cost: { total: 0.01 } },
    };
    const line = (v: unknown) => JSON.stringify(v) + "\n";
    writeFileSync(
      path,
      line({ type: "session", version: 3, id }) +
        line({ type: "message", id: "entry", message: msg }) +
        line({ type: "message", id: "entry2", message: { ...msg, responseId: undefined } }) +
        line({ type: "message", id: "acp", message: { ...msg, provider: "antigravity-acp" } }) +
        '{"type":"compact',
    );
    recordUsage(base, piUsage(id, msg)!);
    expect(syncPi(base)).toBe(0);
    expect(queryUsage(base)).toHaveLength(2);
    expect(queryJourney(base)).toEqual([]);
    appendFileSync(path, 'ion","id":"native-entry","timestamp":"2026-01-01T00:00:00Z"}\n');
    expect(syncPi(base)).toBe(0);
    expect(syncPi(base)).toBe(0);
    expect(queryUsage(base)).toHaveLength(2);
    expect(queryJourney(base)).toEqual([
      {
        source: "pi",
        sessionId: id,
        id: "native-entry",
        kind: "compaction",
        name: "Context compaction",
        timestamp: Date.UTC(2026, 0, 1),
      },
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
