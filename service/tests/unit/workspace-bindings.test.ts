import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { recordJourney, withLedger } from "../../src/usage/ledger";
import { syncPi, syncSources } from "../../src/usage/sync";
import { saveIndex } from "../../src/workspace/state";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "yaat-usage-workspace-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function bindings() {
  return withLedger(base, (db) => db.prepare("SELECT * FROM usage_workspace").all());
}

it("links previously imported Pi facts to a managed directory only after native ID verification", () => {
  const imported = randomUUID();
  const mismatch = randomUUID();
  const ambiguous = randomUUID();
  function writePi(folder: string, fileId: string, headerId = fileId) {
    const dir = join(base, "pi-sessions", folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `sample_${fileId}.jsonl`),
      JSON.stringify({ type: "session", version: 3, id: headerId }) +
        "\n" +
        JSON.stringify({ type: "compaction", id: "compact" }) +
        "\n",
    );
  }
  writePi("ws-owner", imported);
  writePi("ws-other", mismatch, randomUUID());
  writePi("ws-owner", ambiguous);
  writePi("ws-other", ambiguous);
  writePi("local", randomUUID());
  expect(syncPi(base)).toBe(1);
  withLedger(base, (db) => db.exec("DELETE FROM usage_workspace"));
  expect(syncPi(base)).toBe(1);
  expect(bindings()).toEqual([{ source: "pi", session: imported, workspace: "ws-owner" }]);
});

it("backfills only exact Codex session IDs from indexed YAAT workspace metadata", () => {
  const thread = randomUUID();
  const unrelated = randomUUID();
  const ambiguous = randomUUID();
  const wrongBackend = randomUUID();
  const folder = join(base, ".agent-team", "cache", "workspaces");
  mkdirSync(folder, { recursive: true });
  saveIndex(base, ["ws-owner", "ws-other", "ws-missing"]);
  function save(id: string, agents: { sessionId: string; backend: string }[]) {
    writeFileSync(
      join(folder, `${id}.json`),
      JSON.stringify({
        id,
        cwd: "/same-cwd",
        agents: agents.map(({ sessionId, backend }) => ({
          session: { sessionId, config: { backend } },
        })),
      }),
    );
  }
  save("ws-owner", [
    { sessionId: thread, backend: "codex" },
    { sessionId: ambiguous, backend: "codex" },
  ]);
  save("ws-other", [
    { sessionId: wrongBackend, backend: "pi" },
    { sessionId: ambiguous, backend: "codex" },
  ]);
  save("ws-not-indexed", [{ sessionId: unrelated, backend: "codex" }]);
  for (const sessionId of [thread, unrelated, ambiguous, wrongBackend]) {
    recordJourney(base, {
      source: "codex",
      sessionId,
      id: "tool",
      kind: "tool",
      name: "test",
      timestamp: null,
    });
  }
  expect(syncSources(base)).toBe(0);
  expect(syncSources(base)).toBe(0);
  expect(bindings()).toEqual([{ source: "codex", session: thread, workspace: "ws-owner" }]);
});
