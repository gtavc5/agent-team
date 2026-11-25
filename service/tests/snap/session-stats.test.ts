import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { recordJourney, recordUsage } from "../../src/usage/ledger";
import { sessionStats } from "../../src/usage/session-stats";
import { loadFixture, readRecording, recordingPath, replay } from "./harness";

it.each([
  ["pi", "tools-bash-edit"],
  ["pi", "compaction-and-retry"],
  ["pi", "antigravity-acp-turn"],
  ["codex", "resume"],
] as const)(
  "projects the persisted %s/%s lifecycle and usage receipts identically on reload",
  async (backend, name) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dir = mkdtempSync(join(tmpdir(), "stats-replay-"));
    try {
      await replay(
        backend,
        readRecording(recordingPath(backend, name)),
        await loadFixture(backend, name),
        undefined,
        {
          recordUsage: (f) => recordUsage(dir, { ...f, workspaceId: "ws" }),
          recordJourney: (f) => recordJourney(dir, { ...f, workspaceId: "ws" }),
        },
        dir,
      );
      const query = { workspaceId: "ws", offset: 0, limit: 100 };
      const page = sessionStats(dir, query);
      expect(sessionStats(dir, query)).toEqual(page);
      const steps = page.turns.flatMap((t) => t.steps);
      expect(steps.some((s) => s.kind === "user")).toBe(true);
      if (name === "compaction-and-retry") {
        expect(steps.filter((s) => s.kind === "compaction")).toHaveLength(1);
        expect(steps.find((s) => s.trigger === "retry")).toMatchObject({ boundary: "compaction" });
      } else if (name === "antigravity-acp-turn") {
        expect(steps.filter((s) => s.kind === "model")).toHaveLength(2);
        expect(
          steps
            .filter((s) => s.kind === "model")
            .every((s) => s.promptTokens === undefined && s.firstDelta !== undefined),
        ).toBe(true);
      } else {
        if (backend === "codex")
          expect(
            page.turns.find((t) => t.steps.some((s) => s.kind === "compaction"))?.trigger,
          ).toBe("user");
        const ids = steps.flatMap((s) => (s.inferenceId ? [s.inferenceId] : []));
        expect(ids.length).toBeGreaterThan(0);
        expect(new Set(ids).size).toBe(ids.length);
        expect(steps.some((s) => s.toolCallId && s.toolResult !== undefined)).toBe(true);
      }
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
