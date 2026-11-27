import { afterEach, expect, it, vi } from "vitest";
import {
  historyOf,
  readWorkspaceMetadata,
  saveIndex,
  saveWorkspace,
} from "../../src/workspace/state";
import { setupProjects, useRecoveryClock } from "./projectHarness";

async function waitingLead(backend: "pi" | "codex" = "codex") {
  useRecoveryClock();
  vi.setSystemTime(new Date("2026-02-01T02:00:00Z"));
  const save = () => saveWorkspace(h.base, lead.getState());
  const h = setupProjects(() => {
    save();
  });
  const { lead } = h.create("night shift");
  h.host.saveWorkspaceNow = (w) => {
    saveWorkspace(h.base, w.getState());
  };
  const session = h.session(lead);
  session.getState().config.backend = backend;
  const agentId = [...lead.agents.keys()][0];
  const send = vi.spyOn(session, "send");
  await lead.sendMessage("original request");
  session.isRunning = false;
  session.emit("event", { kind: "error", content: "connect ECONNREFUSED", networkFailure: true });
  const original = lead.messages.find((m) => m.kind === "user")!;
  const outage = lead.leadOutage!;
  expect(outage.phase).toBe("waiting");
  saveIndex(h.base, [lead.id]);
  return { ...h, lead, session, agentId, original, outage, send };
}

afterEach(() => vi.useRealTimers());

it("pairs a queued forward with outage context and dispatches it before the old timer", async () => {
  const h = await waitingLead();
  h.lead.pauseAgent(h.agentId, Date.now() + 1000);
  await h.lead.forwardMessage(h.original.id, h.agentId);
  const [panel, queued] = h.lead.messages.slice(-2);
  expect(panel.from?.role).toBe("panel");
  expect(queued.forwardRef?.messageId).toBe(h.original.id);
  expect(queued.status).toBe("queued");
  expect(h.lead.isNetworkWaiting(h.agentId)).toBe(false);
  expect(h.lead.leadOutage?.batch).toMatchObject({
    manual: true,
    id: queued.queuedEnvelope?.reportId,
  });
  await vi.advanceTimersByTimeAsync(1000);
  h.lead.endPause(h.agentId);
  await vi.advanceTimersByTimeAsync(0);
  const input = expect(h.send.mock.lastCall?.[0]);
  input.toHaveProperty("text", expect.stringContaining(h.original.content));
  input.toHaveProperty("panelContext", panel.content);
  h.endTurn(h.lead);
  await vi.advanceTimersByTimeAsync(h.outage.next - Date.now());
  expect(h.send).toHaveBeenCalledTimes(2);
  expect(h.lead.leadOutage).toBeUndefined();
});

it("releases a held outage on forward without pairing or suppressing inbox drain", async () => {
  const h = await waitingLead();
  h.manager.recovery.stop(h.lead);
  const drain = vi.spyOn(h.manager, "leadAgentsChanged");
  await h.lead.forwardMessage(h.original.id, h.agentId);
  expect(h.lead.leadOutage).toBeUndefined();
  const input = expect(h.send.mock.lastCall?.[0]);
  input.toHaveProperty("text", expect.stringContaining(h.original.content));
  input.not.toHaveProperty("panelContext");
  expect(drain).toHaveBeenCalledWith(h.lead);
});

it.each([
  ["pi", "/skill:example argument", "waiting"],
  ["pi", "/compact keep this", "waiting"],
  ["pi", "/custom-extension argument", "held"],
  ["codex", "/compact", "held"],
] as const)(
  "dispatches %s %s unchanged after releasing a %s outage",
  async (backend, command, phase) => {
    const h = await waitingLead(backend);
    if (phase === "held") h.manager.recovery.stop(h.lead);
    h.lead.pauseAgent(h.agentId, Date.now() + 1000);
    await h.lead.sendMessage(command);
    expect(h.lead.leadOutage).toBeUndefined();
    expect(h.lead.isNetworkWaiting(h.agentId)).toBe(false);
    expect(h.lead.messages.at(-1)).toMatchObject({ status: "queued" });
    await vi.advanceTimersByTimeAsync(1000);
    h.lead.endPause(h.agentId);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.send.mock.lastCall?.[0]).toMatchObject({ text: command });
    expect(h.send.mock.lastCall?.[0]).not.toHaveProperty("panelContext");
    expect(h.send.mock.lastCall?.[0]).not.toHaveProperty("recovery");
    await vi.advanceTimersByTimeAsync(h.outage.next - Date.now());
    expect(h.send).toHaveBeenCalledTimes(2);
  },
);

it("leaves local slash commands outside manual recovery admission", async () => {
  const h = await waitingLead("pi");
  await h.lead.sendMessage("/context");
  expect(h.lead.leadOutage).toBe(h.outage);
  expect(h.lead.isNetworkWaiting(h.agentId)).toBe(true);
  expect(h.send).toHaveBeenCalledTimes(1);
});

it.each(["send", "forward", "slash", "held slash"])(
  "rolls back %s after the queue history write fails",
  async (action) => {
    const h = await waitingLead("pi");
    const held = action === "held slash";
    if (held) h.manager.recovery.stop(h.lead);
    const before = h.lead.messages.map((m) => m.id);
    const outage = structuredClone(h.outage);
    const drain = vi.spyOn(h.manager, "leadAgentsChanged");
    const history = historyOf(h.base);
    const persist = vi.spyOn(history, "save").mockImplementationOnce(() => {
      expect([...readWorkspaceMetadata(h.base)][0].leadOutage?.phase).toBe(
        action.endsWith("slash") ? undefined : "sending",
      );
      throw new Error("history unavailable");
    });
    const sending =
      action === "forward"
        ? h.lead.forwardMessage(h.original.id, h.agentId)
        : h.lead.sendMessage(action.endsWith("slash") ? "/compact" : "new request");
    await expect(sending).rejects.toThrow("history unavailable");
    persist.mockRestore();
    expect(h.lead.leadOutage).toBe(h.outage);
    expect(h.lead.leadOutage).toEqual(outage);
    expect(h.lead.isNetworkWaiting(h.agentId)).toBe(!held);
    expect(h.lead.messages.map((m) => m.id)).toEqual(before);
    expect(history.load(h.lead.id).map((m) => m.id)).toEqual(before);
    expect([...readWorkspaceMetadata(h.base)][0].leadOutage).toEqual(outage);
    expect(drain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(outage.next - Date.now());
    expect(h.send).toHaveBeenCalledTimes(held ? 1 : 2);
    expect(h.lead.leadOutage?.phase).toBe(held ? "held" : "sending");
  },
);
