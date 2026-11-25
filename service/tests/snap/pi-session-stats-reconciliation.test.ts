import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PanelHttpServer } from "../../src/session/panel-http";
import { readLifecycle } from "../../src/usage/lifecycle";
import { sessionStats } from "../../src/usage/session-stats";
import { syncPi } from "../../src/usage/sync";
import { loadFixture, readRecording, recordingPath, replay } from "./harness";
import { piFrame } from "./pi-wire";

it("joins a replayed Pi compaction and responseId-less inference with their imported native entries", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const dir = mkdtempSync(join(tmpdir(), "pi-stats-reconciliation-"));
  const query = { workspaceId: "ws", offset: 0, limit: 20 };
  const name = "compaction-and-retry";
  const rec = readRecording(recordingPath("pi", name));
  const line = (row: unknown) => JSON.stringify(row) + "\n";
  const { result } = piFrame("compaction_end") as { result?: Record<string, unknown> };
  const nativeTime = Date.parse(rec.header.recordedAt) + 60_000;
  const legacyTime = Date.parse(rec.header.recordedAt) - 60_000;
  let sessionFile: string | undefined;
  let nativeSession: string | undefined;
  let assistant: Record<string, unknown> | undefined;
  for (const entry of rec.entries) {
    if (!("frame" in entry)) continue;
    const frame = entry.frame as ReturnType<typeof piFrame>;
    if (frame.type === "message_end" && frame.message?.responseId) {
      // Pi uses the same message_end shape when the optional provider ID is absent.
      delete frame.message.responseId;
      assistant = frame.message;
    }
  }
  expect(assistant).toBeDefined();
  try {
    vi.spyOn(PanelHttpServer.prototype, "isControlConnected").mockReturnValue(true);
    vi.spyOn(PanelHttpServer.prototype, "requestSessionCheckpoint").mockImplementation(() => {
      if (!sessionFile) {
        nativeSession = readLifecycle(dir, "ws").find((mark) => mark.sessionId)?.sessionId;
        if (!nativeSession) return Promise.reject(new Error("Awaiting initial Pi lifecycle"));
        const folder = join(dir, "pi-sessions", "ws");
        mkdirSync(folder, { recursive: true });
        sessionFile = join(folder, `test_${nativeSession}.jsonl`);
        writeFileSync(
          sessionFile,
          line({ type: "session", version: 3, id: nativeSession }) +
            line({
              type: "message",
              id: result!.firstKeptEntryId,
              parentId: null,
              message: { role: "user", content: "Retry a sample." },
            }) +
            line({
              type: "compaction",
              id: "legacy",
              parentId: result!.firstKeptEntryId,
              firstKeptEntryId: result!.firstKeptEntryId,
              tokensBefore: 123,
              summary: "Earlier",
              timestamp: new Date(legacyTime).toISOString(),
            }) +
            line({
              ...result!,
              type: "compaction",
              id: "observed",
              parentId: "legacy",
              timestamp: new Date(nativeTime).toISOString(),
            }),
        );
      }
      return Promise.resolve({
        sessionId: nativeSession!,
        sessionFile,
        leafId: "observed",
        entryCount: 3,
        compaction: {
          id: "observed",
          index: 2,
          firstKeptEntryId: String(result!.firstKeptEntryId),
          tokensBefore: Number(result!.tokensBefore),
          summaryKey: createHash("sha256").update(String(result!.summary)).digest("hex"),
        },
      });
    });
    await replay("pi", rec, await loadFixture("pi", name), undefined, undefined, dir);
    const live = sessionStats(dir, query).turns.flatMap((turn) => turn.steps);
    expect(live.find((step) => step.trigger === "retry")).toMatchObject({ promptTokens: 1531 });
    expect(sessionFile).toBeDefined();
    appendFileSync(
      sessionFile!,
      line({ type: "message", id: "reply", parentId: "observed", message: assistant }),
    );
    expect(syncPi(dir)).toBe(0);
    const page = sessionStats(dir, query);
    const unplaced = page.turns.find((turn) => turn.trigger === "Unattributed history");
    expect(unplaced?.steps).toEqual([
      { stepId: "legacy", kind: "compaction", compaction: legacyTime },
    ]);
    const steps = page.turns.filter((turn) => turn !== unplaced).flatMap((turn) => turn.steps);
    const observedAt = live.find((step) => step.kind === "compaction")?.compaction;
    expect(observedAt).toBeLessThan(nativeTime);
    const compactions = steps.filter((step) => step.kind === "compaction");
    expect(compactions).toEqual([
      expect.objectContaining({
        compaction: nativeTime,
        compactionObservedAt: observedAt,
      }),
    ]);
    expect(steps.find((step) => step.trigger === "retry")).toMatchObject({
      boundary: "compaction",
      inferenceId: JSON.stringify(["entry", nativeSession, "reply"]),
      promptTokens: 1531,
    });
    // If the same complete message appears at another native ID, there is no exact one-to-one join.
    appendFileSync(
      sessionFile!,
      line({ type: "message", id: "ambiguous", parentId: "reply", message: assistant }),
    );
    expect(syncPi(dir)).toBe(0);
    const ambiguous = sessionStats(dir, query).turns;
    expect(
      ambiguous.flatMap((turn) => turn.steps).find((step) => step.trigger === "retry")?.inferenceId,
    ).toBeUndefined();
    expect(
      ambiguous
        .find((turn) => turn.trigger === "Unattributed history")
        ?.steps.filter((step) => step.kind === "model"),
    ).toHaveLength(2);
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  ["busy rejection", false, true],
  ["handled command", true, false],
] as const)(
  "attributes unsolicited Pi activity to auto after a %s",
  async (_, handled, modelBeforeReply) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-stats-wakeup-"));
    try {
      const name = "compaction-and-retry";
      const source = readRecording(recordingPath("pi", name));
      const base = await loadFixture("pi", name);
      const start = { t: 1, frame: piFrame("agent_start") };
      const model = {
        t: modelBeforeReply ? 1 : 3,
        frame: piFrame("message_start", { role: "assistant" }),
      };
      // Reorder captured frames to simulate an unsolicited wakeup while prompt is in flight.
      // Leave it running so a retryable rejection cannot also dispatch the waiting input.
      const reply = {
        t: 2,
        frame: {
          ...piFrame("response", { command: "prompt" }),
          success: handled,
          ...(handled
            ? { data: { disposition: "handled" } }
            : { error: "Pi is already processing a turn" }),
        },
      };
      await replay(
        "pi",
        {
          ...source,
          entries: [
            ...source.entries.slice(0, 2),
            start,
            ...(modelBeforeReply ? [model, reply] : [reply, model]),
          ],
        },
        { ...base, steps: base.steps.slice(0, 1) },
        undefined,
        undefined,
        dir,
      );
      expect(readLifecycle(dir, "ws")).toEqual([
        expect.objectContaining({ kind: "model", marker: "stepStart", trigger: "auto" }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
