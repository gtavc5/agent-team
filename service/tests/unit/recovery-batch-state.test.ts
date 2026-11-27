import { afterEach, describe, expect, it, vi } from "vitest";
import { setupProjects, useRecoveryClock } from "./projectHarness";
import { ProjectStore } from "../../src/project/store";
import { ReportJournalStore } from "../../src/project/report-journal";
import type { PromptEnvelope, SendHooks, SendReceipt } from "../../src/session/types";
import type { Workspace } from "../../src/workspace/workspace";

afterEach(() => vi.useRealTimers());

async function fixture() {
  useRecoveryClock();
  const h = setupProjects();
  const { project, lead } = h.create("recovery batch");
  const session = h.session(lead);
  const fail = () => {
    session.isRunning = false;
    session.emit("event", { kind: "error", content: "connect ECONNREFUSED", networkFailure: true });
  };
  await lead.sendMessage("original request");
  fail();
  expect(lead.leadOutage?.phase).toBe("waiting");
  await h.call(lead, "start_session", { title: "worker", cwd: "wt", task: "work" });
  await h.call(h.workers()[0], "report_progress", { text: "worker result" });
  const reportState = () =>
    new ReportJournalStore()
      .load(new ProjectStore(h.base).projectDir(project.id))
      .map((row) => row.leadDelivery.state);
  expect(reportState()).toEqual(["pending"]);
  const agentId = lead.resolveAgent()!.info.id;
  return { ...h, lead, leadSession: session, fail, reportState, agentId };
}

function unknownBanner(w: Workspace) {
  return w.messages.some((row) => row.kind === "system" && row.content.includes("outcome unknown"));
}

function claimWrite(envelope: PromptEnvelope, hooks: SendHooks) {
  hooks.onBeforeWrite?.({
    inputId: envelope.inputId,
    reportId: envelope.reportId,
    generation: 1,
    beforeLeafId: null,
    beforeEntryCount: 0,
    startedAt: Date.now(),
  });
}

describe("Lead recovery batch settlement", () => {
  it.each([
    { mode: "paired", result: "success" },
    { mode: "paired", result: "failure" },
    { mode: "queued paired", result: "success" },
    { mode: "automatic", result: "failure" },
  ])("queues M2 behind $mode M1 and settles M1's actual $result", async ({ mode, result }) => {
    const h = await fixture();
    if (mode === "queued paired") h.lead.pauseAgent(h.agentId, Date.now() + 10_000);
    if (mode !== "automatic") await h.lead.sendMessage("M1");
    else await vi.advanceTimersByTimeAsync(h.lead.leadOutage!.next - Date.now());
    const batchId = h.lead.leadOutage?.batch?.id;
    expect(batchId).toBeDefined();
    expect(!!h.lead.leadOutage?.batch?.admitted).toBe(mode !== "queued paired");
    const steer = vi.fn(() => Promise.resolve(true));
    Object.assign(h.leadSession, { steer });
    await h.lead.sendMessage("M2");
    const m2 = h.lead.messages.find((m) => m.content === "M2")!;
    expect(m2.status).toBe("queued");
    expect(m2.queuedEnvelope?.panelContext).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
    expect(h.lead.leadOutage?.batch?.id).toBe(batchId);
    expect(h.reportState()).toEqual(["pending"]);
    expect(unknownBanner(h.lead)).toBe(false);

    if (mode === "queued paired") {
      h.lead.endPause(h.agentId);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.leadSession.sent.at(-1)).toBe("M1");
      expect(h.lead.leadOutage?.batch?.admitted).toBe(true);
    }
    if (result === "success") h.endTurn(h.lead);
    else h.fail();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.leadSession.sent.at(-1)).toBe("M2");
    expect(m2.status).toBe("done");
    expect(h.reportState()).toEqual([result === "success" ? "sent_to_pi" : "outcome_unknown"]);
    expect(h.lead.leadOutage).toBeUndefined();
    expect(h.lead.isNetworkWaiting(h.agentId)).toBe(false);
    h.endTurn(h.lead);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(h.leadSession.sent).toHaveLength(3);
  });

  it("cancels a queued paired M1 without condemning reports or blocking queued M2", async () => {
    const h = await fixture();
    h.lead.pauseAgent(h.agentId, Date.now() + 10_000);
    await h.lead.sendMessage("M1");
    await h.lead.sendMessage("M2");
    const m1 = h.lead.messages.find((m) => m.content === "M1")!;
    expect(m1.status).toBe("queued");
    expect(h.lead.cancelQueued(m1.id)).toBe(true);
    expect(h.reportState()).toEqual(["pending"]);
    expect(unknownBanner(h.lead)).toBe(false);
    expect(h.lead.leadOutage).toBeUndefined();
    h.lead.endPause(h.agentId);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.leadSession.sent).toEqual(["original request", "M2"]);
    expect(h.reportState()).toEqual(["enqueued"]);
  });

  it("waits for definitive rejection after a Codex terminal error before condemning reports", async () => {
    const h = await fixture();
    const send = vi.fn((envelope: PromptEnvelope, hooks: SendHooks): Promise<SendReceipt> => {
      claimWrite(envelope, hooks);
      h.leadSession.emit("event", {
        kind: "error",
        content: "turn/start rejected: invalid request",
      });
      expect(h.reportState()).toEqual(["pending"]);
      return Promise.resolve({
        disposition: "rejected",
        error: "invalid request",
        retryable: true,
      });
    });
    Object.assign(h.leadSession, { send });
    await h.lead.sendMessage("M1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.lead.messages.find((m) => m.content === "M1")?.status).toBe("error");
    expect(h.reportState()).toEqual(["enqueued"]);
    expect(unknownBanner(h.lead)).toBe(false);
  });

  it("preserves an ambiguous write when M2 queues before M1's receipt", async () => {
    const h = await fixture();
    const send = h.leadSession.send.bind(h.leadSession);
    let loseReceipt!: (error: Error) => void;
    Object.assign(h.leadSession, {
      send: (envelope: PromptEnvelope, hooks: SendHooks) => {
        if (envelope.text !== "M1") return send(envelope);
        claimWrite(envelope, hooks);
        return new Promise<SendReceipt>((_resolve, reject) => {
          loseReceipt = reject;
        });
      },
    });
    const m1 = h.lead.sendMessage("M1");
    await h.lead.sendMessage("M2");
    expect(h.reportState()).toEqual(["pending"]);
    expect(unknownBanner(h.lead)).toBe(false);
    loseReceipt(new Error("connection lost after write claim"));
    await m1;
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reportState()).toEqual(["outcome_unknown"]);
    expect(unknownBanner(h.lead)).toBe(true);
    expect(h.leadSession.sent).toEqual(["original request", "M2"]);
    expect(h.lead.leadOutage).toBeUndefined();
  });

  it.each(["queued", "starting", "dispatching"] as const)(
    "restores %s M1 without replay, classifying only a write claim as ambiguous",
    async (status) => {
      const h = await fixture();
      if (status === "queued") h.lead.pauseAgent(h.agentId, Date.now() + 10_000);
      else {
        Object.assign(h.leadSession, {
          send: (envelope: PromptEnvelope, hooks: SendHooks) => {
            if (status === "dispatching") claimWrite(envelope, hooks);
            return new Promise<SendReceipt>(() => {});
          },
        });
      }
      const sending = h.lead.sendMessage("M1");
      if (status === "queued") await sending;
      const m1 = h.lead.messages.find((m) => m.content === "M1")!;
      expect(m1.status).toBe(status);
      // This harness reconstructs the workspace but keeps the manager alive.
      h.manager.recovery.cancel(h.lead);
      const lead = h.restart(h.lead);
      lead.settleStartingOnRestore();
      lead.settlePlainDispatchingOnRestore();
      h.manager.recovery.restore(lead);
      const ambiguous = status === "dispatching";
      expect(lead.findMessage(m1.id)?.status).toBe(ambiguous ? "outcome_unknown" : "error");
      expect(h.reportState()).toEqual([ambiguous ? "outcome_unknown" : "pending"]);
      expect(unknownBanner(lead)).toBe(ambiguous);
      expect(lead.leadOutage?.phase).toBe("held");
      expect(lead.leadOutage?.batch).toBeUndefined();
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(h.session(lead).sent).toEqual([]);
    },
  );
});
