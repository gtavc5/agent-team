import { afterEach, expect, it, vi } from "vitest";
import { START_SPACING_MS } from "../../src/project/manager";
import { Server } from "../../src/server/server";
import { setupProjects, useRecoveryClock } from "./projectHarness";

async function waitingLead() {
  useRecoveryClock();
  const h = setupProjects();
  const { lead, project } = h.create("recovery lifecycle");
  const session = h.session(lead);
  await lead.sendMessage("start work");
  session.isRunning = false;
  session.emit("event", { kind: "error", content: "connect ECONNREFUSED", networkFailure: true });
  const outage = lead.leadOutage!;
  expect(outage.phase).toBe("waiting");
  return { ...h, project, lead, outage, session };
}

afterEach(() => vi.useRealTimers());

it.each(["dispatch seal", "spacing pause", "busy agent"])(
  "defers a due recovery during a %s without shortening its window",
  async (hold) => {
    const { lead, host, outage, session } = await waitingLead();
    const { deadline, next, agentId } = outage;
    if (hold === "dispatch seal") host.dispatchAllowed = () => false;
    if (hold === "spacing pause") lead.pauseAgent(agentId, next + 5000);
    if (hold === "busy agent") session.isRunning = true;

    await vi.advanceTimersByTimeAsync(next - Date.now() + 1);
    expect(outage).toMatchObject({ phase: "waiting", attempts: 0, deadline, next });
    expect(lead.isNetworkWaiting(agentId)).toBe(true);
    expect(session.sent).toEqual(["start work"]);

    if (hold === "dispatch seal") host.dispatchAllowed = () => true;
    if (hold === "spacing pause") lead.endPause(agentId);
    if (hold === "busy agent") session.isRunning = false;
    await vi.advanceTimersByTimeAsync(START_SPACING_MS + 1000);
    expect(outage).toMatchObject({ phase: "sending", attempts: 1, deadline });
    expect(session.sent.at(-1)).toContain("Lead network interruption");
  },
);

it("still reaches the original cutoff when dispatch never reopens", async () => {
  const { host, outage, session } = await waitingLead();
  host.dispatchAllowed = () => false;
  vi.advanceTimersByTime(outage.deadline - Date.now());
  expect(outage).toMatchObject({ phase: "held", attempts: 0 });
  expect(session.sent).toEqual(["start work"]);
});

it("server close cancels recovery before waiting for deploy retirement", async () => {
  const { base, host, lead, manager, outage, saved, session, workspaces } = await waitingLead();
  const count = saved.length;
  let finishRetirement!: () => void;
  const retiring = new Promise<void>((resolve) => (finishRetirement = resolve));
  const socket = { close: (done: () => void) => done() };
  const server = {
    baseDir: base,
    closing: false,
    deploy: { close: () => retiring },
    history: { close: () => {} },
    hostRegistry: { getAll: () => [] },
    httpServer: socket,
    projects: manager,
    quota: { stop: () => {} },
    restored: true,
    retryTimers: new Map(),
    telemetry: { close: () => {} },
    uiClients: new Set(),
    workspaces,
    wss: socket,
  };
  host.dispatchAllowed = () => !server.closing;
  const closing = (Server.prototype as unknown as { closeOnce(): Promise<void> }).closeOnce.call(
    server,
  );
  try {
    manager.recovery.restore(lead);
    await vi.advanceTimersByTimeAsync(outage.deadline - Date.now());
    expect(outage).toMatchObject({ phase: "waiting", attempts: 0 });
    expect(saved).toHaveLength(count);
    expect(session.sent).toEqual(["start work"]);
  } finally {
    finishRetirement();
    await closing;
  }
});

it("deleting the project cancels recovery and never saves the removed lead", async () => {
  const { lead, manager, outage, project, saved, session, workspaces } = await waitingLead();
  manager.delete(project.id);
  expect(workspaces.has(lead.id)).toBe(false);
  const count = saved.length;
  await vi.advanceTimersByTimeAsync(outage.deadline - Date.now());
  expect(outage).toMatchObject({ phase: "waiting", attempts: 0 });
  expect(saved).toHaveLength(count);
  expect(session.sent).toEqual(["start work"]);
});

it("sealing the project holds recovery before sealing its workspace, not at the next wake", async () => {
  const { lead, manager, outage, project, saved, session } = await waitingLead();
  const seal = lead.seal.bind(lead);
  lead.seal = async () => {
    expect(outage).toMatchObject({ phase: "held", attempts: 0 });
    expect(lead.isNetworkWaiting(outage.agentId)).toBe(false);
    await seal();
  };
  await manager.sealProject(project.id);
  const count = saved.length;
  await vi.advanceTimersByTimeAsync(outage.deadline - Date.now());
  expect(saved).toHaveLength(count);
  expect(session.sent).toEqual(["start work"]);
});

it("does not arm an overdue restored wake until the server finishes inbox restoration", async () => {
  const { host, lead, manager, outage, restart, workspaces } = await waitingLead();
  manager.recovery.cancel(lead);
  vi.setSystemTime(outage.next + 1);
  const restored = restart(lead);
  const dispatch = vi.spyOn(restored, "startRecovery");
  let finishInbox!: () => void;
  const inbox = new Promise<void>((resolve) => (finishInbox = resolve));
  const drain = vi.spyOn(manager, "drainInbox").mockReturnValueOnce(inbox);
  const restore = vi.spyOn(manager.recovery, "restore");
  const server = {
    closing: false,
    recoveryReady: false,
    projects: manager,
    workspaces,
    isProjectSealed: () => false,
  };
  host.recoveryReady = () => server.recoveryReady;
  const startup = (
    Server.prototype as unknown as { resumeRestoredWork(): Promise<void> }
  ).resumeRestoredWork.call(server);

  expect(drain).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(restore).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  finishInbox();
  await startup;
  expect(restore).toHaveBeenCalledWith(restored);
  await vi.advanceTimersByTimeAsync(restored.leadOutage!.next - Date.now() + 1);
  expect(dispatch).toHaveBeenCalledOnce();
});
