import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelHttpServer, type PanelReadyReport } from "../../src/session/panel-http";
import { PiRpcClient, type PiRpcSpawnOptions } from "../../src/session/pi-rpc";
import { HostRegistry, LocalHost } from "../../src/session/host";
import { Workspace, type WorkspaceCallbacks } from "../../src/workspace/workspace";
import { closeHistory, loadAll, saveIndex, saveWorkspace } from "../../src/workspace/state";
import { PiSession, type PiSessionOptions } from "../../src/session/pi";
import type {
  ActiveAsyncRunRecord,
  ExtensionUiEvent,
  SessionConfig,
  SessionState,
  StreamEvent,
} from "../../src/session/types";

type Frame = { id: string; type: string; [key: string]: unknown };
const dirs: string[] = [];
const cleanup: Array<() => Promise<void> | void> = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function config(dir: string): SessionConfig {
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ packages: [] }));
  return {
    cwd: dir,
    backend: "pi",
    uploadsDir: dir,
    piAgentDir: home,
    piSessionDir: path.join(dir, "sessions"),
    workspaceId: "workspace",
    agentId: "agent",
  };
}

function harness(
  override: {
    config?: Partial<SessionConfig>;
    options?: Partial<PiSessionOptions>;
    ready?: (ready: PanelReadyReport) => void;
    state?: (config: SessionConfig) => SessionState;
    disposition?: string;
    enabledModels?: string[];
    models?: Array<{
      provider: string;
      id: string;
      reasoning?: boolean;
      thinkingLevelMap?: Partial<Record<string, string | null>>;
    }>;
  } = {},
) {
  const dir = temp();
  const cfg = { ...config(dir), ...override.config };
  if (override.enabledModels)
    fs.writeFileSync(
      path.join(cfg.piAgentDir!, "settings.json"),
      JSON.stringify({ packages: [], enabledModels: override.enabledModels }),
    );
  const state = override.state?.(cfg);
  const panel = new PanelHttpServer();
  cleanup.push(() => panel.close());
  const register = vi.spyOn(panel, "registerSession");
  const clients: {
    rpc: PiRpcClient;
    wire: Frame[];
    event: (frame: object) => void;
    respond: (frame: Frame, data?: unknown, success?: boolean) => void;
    end: ReturnType<typeof vi.fn>;
  }[] = [];
  const order: string[] = [];
  let disposition = override.disposition ?? "started";
  const factory = vi.fn((opts: PiRpcSpawnOptions) => {
    expect(register).toHaveBeenCalledTimes(clients.length + 1);
    expect(opts.env?.YAAT_PANEL_TOKEN).toMatch(/^[a-f\d]{64}$/);
    const sessionFile = opts.args?.includes("--session")
      ? opts.args[opts.args.indexOf("--session") + 1]
      : path.join(dir, "session.jsonl");
    const sessionId = opts.args?.includes("--session-id")
      ? opts.args[opts.args.indexOf("--session-id") + 1]
      : (JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n")[0]) as { id: string }).id;
    const ready: PanelReadyReport = {
      sessionProof: {
        sessionId: sessionId ?? null,
        sessionFile: sessionFile ?? null,
        cwd: fs.realpathSync.native(dir),
        headerCwd: dir,
        entryCount: state?.minEntryCount ?? 0,
        leafId: state?.expectedLeafAnchorId ?? null,
        anchorOnActiveBranch: true,
        anchorExistsInFile: true,
      },
      ownerToolNames: ["write_note"],
      requiredExtensionsRegistered: true,
      subagentsRpcReady: true,
      subagentsSessionId: sessionId ?? null,
    };
    override.ready?.(ready);
    const headers = {
      authorization: `Bearer ${opts.env?.YAAT_PANEL_TOKEN ?? ""}`,
      "content-type": "application/json",
    };
    const endpoint = `${opts.env?.YAAT_PANEL_URL ?? ""}/v1/sessions/${opts.env?.YAAT_PANEL_KEY ?? ""}`;
    const bridgeReady = fetch(`${endpoint}/toolset`, { headers })
      .then(async (response) => {
        if (!response.ok) throw new Error(`bridge toolset fetch failed: ${response.status}`);
        await response.text();
        return fetch(`${endpoint}/ready`, { method: "POST", headers, body: JSON.stringify(ready) });
      })
      .then(async (response) => {
        if (!response.ok) throw new Error(`bridge ready failed: ${response.status}`);
        await response.text();
      });
    cleanup.push(() => bridgeReady);
    const stdout = new PassThrough();
    const wire: Frame[] = [];
    const event = (frame: object) => stdout.write(JSON.stringify(frame) + "\n");
    const respond = (frame: Frame, data?: unknown, success = true) =>
      event({
        type: "response",
        command: frame.type,
        id: frame.id,
        success,
        data,
        ...(!success && { error: "preflight denied" }),
      });
    const stdin = new Writable({
      write(chunk: Buffer, _, callback) {
        const frame = JSON.parse(chunk.toString()) as Frame;
        wire.push(frame);
        switch (frame.type) {
          case "get_state":
            respond(frame, {
              sessionId,
              sessionFile,
              thinkingLevel: "low",
              model: { provider: "mock", id: "test" },
            });
            break;
          case "get_available_models":
            respond(frame, {
              models: override.models ?? [{ provider: "mock", id: "test", contextWindow: 100 }],
            });
            break;
          case "get_available_thinking_levels":
            respond(frame, { levels: ["low", "high"] });
            break;
          case "get_commands":
            respond(frame, { commands: [{ name: "skill:test", source: "skill" }] });
            break;
          case "compact":
            break;
          case "prompt":
            order.push("write");
            respond(frame, { disposition }, disposition !== "rejected");
            break;
          case "get_session_stats":
            respond(frame, {
              tokens: { input: 99, output: 7 },
              cost: 3,
              contextUsage: { tokens: null, contextWindow: 100 },
            });
            break;
          default:
            respond(frame);
            break;
        }
        callback();
      },
    });
    const end = vi.fn(() => stdout.end());
    stdin.on("finish", end);
    const rpc = new PiRpcClient({ stdin, stdout }, { requestTimeoutMs: 800 });
    clients.push({ rpc, event, wire, respond, end });
    return rpc;
  });
  const options = {
    panelHttp: panel,
    rpcFactory: factory,
    readyTimeoutMs: 500,
    ...override.options,
  };
  const session = state ? PiSession.fromState(state, options) : new PiSession(cfg, options);
  cleanup.push(() => session.dispose());
  const events: StreamEvent[] = [];
  session.on("event", (event: StreamEvent) => events.push(event));
  const done = vi.fn();
  session.on("done", done);
  return {
    dir,
    cfg,
    state,
    session,
    panel,
    register,
    factory,
    clients,
    events,
    done,
    order,
    setDisposition: (value: string) => {
      disposition = value;
    },
  };
}

function saved(cfg: SessionConfig, runs: ActiveAsyncRunRecord[] = []): SessionState {
  const session = new PiSession(cfg);
  const state = { ...session.getState(), sessionId: "saved", activeAsyncRuns: runs };
  cleanup.push(() => session.dispose());
  return state;
}

function confirmed(cfg: SessionConfig): SessionState {
  const file = path.join(cfg.cwd, "saved.jsonl");
  fs.writeFileSync(file, '{"type":"session","id":"saved"}\n');
  return {
    ...saved(cfg),
    sessionFile: file,
    expectedLeafAnchorId: "anchor",
    minEntryCount: 4,
    hasConfirmedTurns: true,
  };
}

describe("PiSession dispatch and stream state", () => {
  it.each(["/compact", "/compact Keep\ndecisions"])(
    "runs %s as a standalone command and checkpoints the new leaf",
    async (command) => {
      const h = harness({ state: confirmed });
      vi.spyOn(h.panel, "isControlConnected").mockReturnValue(true);
      vi.spyOn(h.panel, "requestSessionCheckpoint").mockResolvedValue({
        sessionId: "saved",
        sessionFile: h.state!.sessionFile!,
        leafId: "compaction",
        entryCount: 5,
      });
      await h.session.ensureStarted();
      const c = h.clients[0];
      const pending = h.session.send(command);
      await vi.waitFor(() => expect(c.wire.at(-1)?.type).toBe("compact"));
      const frame = c.wire.at(-1)!;
      expect(frame.customInstructions).toBe(command === "/compact" ? undefined : "Keep\ndecisions");
      await expect(h.session.send("next")).rejects.toThrow(/busy/);
      c.event({ type: "compaction_start", reason: "manual" });
      const result = { summary: "Summary", firstKeptEntryId: "kept", tokensBefore: 1234 };
      c.event({
        type: "compaction_end",
        reason: "manual",
        result,
        aborted: false,
        willRetry: false,
      });
      c.respond(frame, result);
      await expect(pending).resolves.toEqual({ disposition: "handled" });
      expect(h.session.getState()).toMatchObject({
        expectedLeafAnchorId: "compaction",
        minEntryCount: 5,
      });
      expect(h.done).toHaveBeenCalledTimes(1);
      expect(h.events.map((e) => e.content)).toContain("Context compacted (manual): 1234 tokens");
      expect(h.session.isRunning).toBe(false);
    },
  );

  it("refuses compact with attachments before dispatch", async () => {
    const h = harness();
    fs.writeFileSync(path.join(h.dir, "a.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const before = vi.fn();
    await expect(
      h.session.send(
        { inputId: "img", text: "/compact", attachmentIds: ["a.png"] },
        { onBeforeWrite: before },
      ),
    ).rejects.toThrow(/attachments/);
    expect(before).not.toHaveBeenCalled();
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("settles an interrupted workspace command even when the compact RPC rejects after its end event", async () => {
    const h = harness();
    const { ws } = workspaceFor(h, {});
    const agent = ws.addAgent("Pi", "mock/test", "", "", { backend: "pi" });
    const pending = ws.sendMessage("/compact", agent.id);
    await vi.waitFor(() => expect(h.clients[0]?.wire.at(-1)?.type).toBe("compact"));
    const c = h.clients[0];
    const frame = c.wire.at(-1)!;
    c.event({ type: "compaction_start", reason: "manual" });
    const stop = h.session.interrupt();
    await vi.waitFor(() => expect(c.wire.at(-1)?.type).toBe("abort"));
    c.event({ type: "compaction_end", reason: "manual", aborted: true, willRetry: false });
    c.respond(frame, undefined, false);
    expect(await stop).toBe(true);
    await pending;
    expect(h.done).toHaveBeenCalledTimes(1);
    expect(
      ws
        .getMessages()
        .filter((m) => m.kind !== "system")
        .map((m) => m.status),
    ).toEqual(["done", "done"]);
    expect(
      ws
        .getMessages()
        .at(-1)
        ?.events?.map((e) => e.content),
    ).toContain("Compaction aborted (manual)");
  });

  it("replays the failed empty-session compact from Pi 1.6.0 without leaving a running turn", async () => {
    const h = harness();
    await h.session.ensureStarted();
    const c = h.clients[0];
    const pending = h.session.send("/compact");
    await vi.waitFor(() => expect(c.wire.at(-1)?.type).toBe("compact"));
    for (const line of fs
      .readFileSync(path.join(__dirname, "fixtures/pi-compact-empty.jsonl"), "utf8")
      .trim()
      .split("\n")) {
      const frame = JSON.parse(line) as Frame;
      c.event(frame.id ? { ...frame, id: c.wire.at(-1)!.id } : frame);
    }
    await expect(pending).resolves.toEqual({ disposition: "handled" });
    expect(h.events.filter((e) => e.kind === "error")).toEqual([
      { kind: "error", content: "Compaction failed: Nothing to compact (session too small)" },
    ]);
    expect(h.session.isRunning).toBe(false);
  });

  it("uses the post-compaction leaf for the next dispatch even when its checkpoint arrives late", async () => {
    const h = harness({ state: confirmed });
    await h.session.send("first");
    const c = h.clients[0];
    let release!: () => void;
    const checkpoint = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => ({
      sessionId: "saved",
      sessionFile: h.state!.sessionFile!,
      entryCount: 8,
      leafId: "compaction",
    }));
    vi.spyOn(h.panel, "isControlConnected").mockReturnValue(true);
    vi.spyOn(h.panel, "requestSessionCheckpoint").mockReturnValue(checkpoint);
    for (const line of fs
      .readFileSync(path.join(__dirname, "fixtures/pi-compact-overflow.jsonl"), "utf8")
      .trim()
      .split("\n")) {
      c.event(JSON.parse(line) as Frame);
    }
    expect(h.events.map((e) => e.content)).toContain(
      "Context compacted (overflow): 5002 → ~2209 tokens",
    );
    expect(h.done).toHaveBeenCalledTimes(1);
    const hook = vi.fn();
    const next = h.session.send("next", { onBeforeWrite: hook });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(hook).not.toHaveBeenCalled();
    release();
    await next;
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({ beforeLeafId: "compaction", beforeEntryCount: 8 }),
    );
  });

  it("does not write past an unverified compaction until the checkpoint succeeds", async () => {
    const h = harness({ state: confirmed });
    await h.session.ensureStarted();
    vi.spyOn(h.panel, "isControlConnected").mockReturnValue(true);
    const checkpoint = vi
      .spyOn(h.panel, "requestSessionCheckpoint")
      .mockRejectedValue(new Error("control unavailable"));
    h.clients[0].event({
      type: "compaction_end",
      reason: "manual",
      result: { tokensBefore: 500 },
      aborted: false,
      willRetry: false,
    });
    const hook = vi.fn();
    await expect(h.session.send("next", { onBeforeWrite: hook })).resolves.toMatchObject({
      disposition: "rejected",
      retryable: true,
    });
    expect(hook).not.toHaveBeenCalled();
    checkpoint.mockResolvedValue({
      sessionId: "saved",
      sessionFile: h.state!.sessionFile!,
      entryCount: 7,
      leafId: "compacted",
    });
    await expect(h.session.send("next", { onBeforeWrite: hook })).resolves.toEqual({
      disposition: "started",
    });
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ beforeLeafId: "compacted" }));
  });

  it("surfaces out-of-turn compactions without creating an agent turn", async () => {
    const h = harness();
    await h.session.ensureStarted();
    const c = h.clients[0];
    c.event({ type: "compaction_start", reason: "threshold" });
    await expect(h.session.send("/compact")).resolves.toMatchObject({
      disposition: "rejected",
      retryable: true,
    });
    c.event({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false });
    c.event({
      type: "compaction_end",
      reason: "overflow",
      errorMessage: "Overflow recovery failed",
      aborted: false,
      willRetry: false,
    });
    expect(h.events.map((e) => e.content)).toEqual([
      "Compacting context (threshold)",
      "Compaction aborted (threshold)",
      "Overflow recovery failed",
    ]);
    expect(h.done).not.toHaveBeenCalled();
    expect(h.session.isRunning).toBe(false);
  });
  it.each([["mock/model-*"], ["*"]])(
    "filters RPC models by enabledModels %j without conflating thinking levels",
    async (enabledModels) => {
      const h = harness({
        enabledModels: [enabledModels],
        models: [
          { provider: "mock", id: "model-x" },
          { provider: "other", id: "nested/name" },
        ],
      });
      await h.session.ensureStarted();
      expect(h.session.getAvailableModels().map((model) => model.id)).toEqual(
        enabledModels === "*" ? ["mock/model-x", "other/nested/name"] : ["mock/model-x"],
      );
      expect(h.session.getAvailableThinkingLevels()).toEqual(["low", "high"]);
    },
  );

  it("discovers levels from each model's metadata, not the catalog session level list", async () => {
    const models = [
      { id: "plain", reasoning: false },
      { id: "basic", reasoning: true },
      { id: "restricted", reasoning: true, thinkingLevelMap: { off: null, minimal: null } },
      {
        id: "extended",
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: "extra", max: "max" },
      },
    ];
    const h = harness({ models: models.map((model) => ({ ...model, provider: "mock" })) });
    await h.session.ensureStarted();
    expect(h.session.getAvailableModels().map((m) => m.effortLevels)).toEqual([
      ["off"],
      ["off", "minimal", "low", "medium", "high"],
      ["low", "medium", "high"],
      ["minimal", "low", "medium", "high", "xhigh", "max"],
    ]);
  });

  function workspaceFor(h: ReturnType<typeof harness>, callbacks: Partial<WorkspaceCallbacks>) {
    const registry = new HostRegistry();
    const host = new LocalHost("local", "Local");
    vi.spyOn(host, "createSession").mockReturnValue(h.session);
    registry.register(host);
    const ws = new Workspace("ws", "test", "project", "local", h.dir, registry, {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
      ...callbacks,
    });
    return { ws, registry };
  }

  it("discards the old preset before starting the first turn on the new model", async () => {
    const h = harness({ config: { model: "mock/extended" } });
    const { ws } = workspaceFor(h, {
      modelOptions: () => [
        { id: "mock/extended", label: "Extended", backend: "pi", effortLevels: ["high", "xhigh"] },
        { id: "mock/test", label: "Test", backend: "pi", effortLevels: ["low", "high"] },
      ],
    });
    const a = ws.addAgent("Pi", "mock/extended", "", "", { backend: "pi" });
    expect(ws.getInfo().agents[0].effortLevels).toEqual(["high", "xhigh"]);
    await ws.sendMessage("/effort", a.id);
    expect(ws.getMessages().at(-1)?.content).toContain("Available: `high` · `xhigh`");
    await ws.sendMessage("/effort xhigh", a.id);
    expect(ws.getInfo().agents[0].effort).toBe("xhigh");
    await ws.sendMessage("/model mock/test", a.id);
    expect(ws.getInfo().agents[0].effortLevels).toEqual(["low", "high"]);
    expect(h.factory).not.toHaveBeenCalled();
    expect(h.session.getState().config.effort).toBeUndefined();
    const levels = vi.fn();
    h.session.on("thinking_levels", levels);
    await h.session.send("hello");
    expect(levels).toHaveBeenCalledTimes(1);
    expect(h.session.getAvailableThinkingLevels("mock/extended")).toBeUndefined();
    expect(h.clients[0].wire.filter((f) => f.type === "set_thinking_level")).toEqual([]);
    expect(h.events.filter((e) => e.level === "warning")).toEqual([]);
  });

  it.each(["startup", "idle"])(
    "publishes and persists a rejected %s preset without a turn",
    async (when) => {
      const effort = when === "startup" ? "max" : undefined;
      const h = harness({ config: { model: "mock/test", effort } });
      const persisted = vi.fn();
      const { ws, registry } = workspaceFor(h, {
        onAgentUpdated: (_id, agent, transient) => {
          if (transient) return;
          persisted(agent.effort);
          saveWorkspace(h.dir, ws.getState());
        },
      });
      cleanup.push(() => closeHistory(h.dir));
      ws.addAgent("Pi", "mock/test", "", "", { backend: "pi", effort });
      saveIndex(h.dir, [ws.id]);
      saveWorkspace(h.dir, ws.getState());
      await h.session.ensureStarted();
      if (when === "idle") {
        expect(persisted).not.toHaveBeenCalled();
        h.session.setEffort("max");
      }
      await vi.waitFor(() => expect(persisted).toHaveBeenCalledExactlyOnceWith(null));
      const restored = Workspace.fromState(loadAll(h.dir)[0], registry);
      cleanup.push(() => restored.dispose());
      expect(restored.getInfo().agents[0].effort).toBeNull();
      expect(h.events).toContainEqual(
        expect.objectContaining({
          level: "warning",
          content: "mock/test has no effort max; using low.",
        }),
      );
      expect(h.session.getState().config.effort).toBeUndefined();
      expect(h.session.effectiveEffort).toBe("low");
      expect(h.clients[0].wire.filter((f) => f.type === "set_thinking_level")).toEqual([]);
    },
  );

  it("reports an unknown outcome when a started prompt loses its Pi process before acceptance", async () => {
    const h = harness();
    const unknown = vi.fn();
    h.session.on("prompt_outcome_unknown", unknown);
    await expect(h.session.send({ inputId: "started", text: "prompt" })).resolves.toMatchObject({
      disposition: "started",
    });
    h.clients[0].rpc.emit("exit", 1, null);
    expect(unknown).toHaveBeenCalledTimes(1);
    expect(unknown.mock.calls[0][0]).toMatchObject({
      inputId: "started",
      reason: "Pi process exited (1)",
    });
    expect(h.session.isRunning).toBe(false);
  });

  it("locks synchronously, captures before the real stdin write, and separates receipts from settlement", async () => {
    const h = harness({ disposition: "rejected", config: { model: "mock/test", effort: "high" } });
    const s = h.session;
    const accepted = vi.fn();
    s.on("user_message_accepted", accepted);
    const commands = vi.fn();
    s.on("commands", commands);
    const before = vi.fn(() => {
      h.order.push("hook");
      expect(s.sessionId).toBeTruthy();
    });
    expect(s.canSteer).toBe(false);
    const first = s.send({ text: "hello", inputId: "first" }, { onBeforeWrite: before });
    expect(s.isRunning).toBe(true);
    expect(s.runState).toBe("working");
    await expect(s.send("concurrent")).rejects.toThrow(/busy/);
    await expect(first).resolves.toEqual({ disposition: "rejected", error: "preflight denied" });
    expect(h.order).toEqual(["hook", "write"]);
    expect(before).toHaveBeenCalledWith(
      expect.objectContaining({
        inputId: "first",
        beforeLeafId: null,
        beforeEntryCount: 0,
        generation: 0,
      }),
    );
    expect(commands).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "skill:test" })]),
    );
    expect(s.getAvailableThinkingLevels()).toEqual(["low", "high"]);
    expect(s.effectiveEffort).toBe("high");
    expect(s.runState).toBe("idle");
    h.setDisposition("handled");
    await expect(s.send("/handled")).resolves.toEqual({ disposition: "handled" });
    expect(s.runState).toBe("idle");
    expect(s.getState().hasConfirmedTurns).toBe(false);
    h.setDisposition("started");
    await expect(
      s.send({ text: "started", inputId: "third", reportId: "report" }),
    ).resolves.toEqual({ disposition: "started" });
    const { event } = h.clients[0];
    event({ type: "agent_start" });
    for (let i = 0; i < 2; i++) event({ type: "message_end", message: { role: "user" } });
    expect(accepted.mock.calls).toEqual([
      [{ inputId: "third", reportId: "report", generation: 0 }],
    ]);
    event({ type: "agent_end", willRetry: true });
    expect(s.isRunning).toBe(true);
    expect(h.done).not.toHaveBeenCalled();
    event({ type: "agent_settled" });
    event({ type: "agent_settled" });
    expect(s.runState).toBe("idle");
    expect(s.getState().hasConfirmedTurns).toBe(true);
    expect(h.done).toHaveBeenCalledTimes(1);
    event({ type: "agent_start" });
    expect(s.isRunning).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ kind: "notice", level: "wakeup" });
    event({ type: "agent_settled" });
    expect(h.done).toHaveBeenCalledTimes(2);
  });

  it("formats Pi retry metadata and clears the banner on recovery", async () => {
    const h = harness();
    await h.session.send("work");
    const { event } = h.clients[0];
    event({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: "529 overloaded",
    });
    event({ type: "auto_retry_end", success: true, attempt: 2 });
    expect(h.events).toEqual([
      { kind: "retry", content: "Retrying (1/3 in 2s): 529 overloaded" },
      { kind: "retry", content: "" },
    ]);
    expect(h.done).not.toHaveBeenCalled();
  });

  it("clears a finally failed retry and emits its final error once", async () => {
    const h = harness();
    await h.session.send("work");
    const { event } = h.clients[0];
    event({
      type: "auto_retry_start",
      attempt: 3,
      maxAttempts: 3,
      delayMs: 4000,
      errorMessage: "529 overloaded",
    });
    event({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "previous attempt",
      },
    });
    event({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "final failure",
    });
    event({ type: "agent_settled" });
    expect(h.events).toEqual([
      { kind: "retry", content: "Retrying (3/3 in 4s): 529 overloaded" },
      { kind: "retry", content: "" },
      { kind: "error", content: "final failure" },
    ]);
    expect(h.done).toHaveBeenCalledTimes(1);
  });

  it("starts a top-level session with no Panel tools even from a nested Pi shell", async () => {
    const nested = [
      "PI_SUBAGENT_CHILD",
      "PI_SUBAGENT_PARENT_SESSION",
      "PI_SUBAGENT_RUNNER_PID",
      "PI_SESSION_ID",
      "PI_SESSION_FILE",
    ];
    for (const name of nested) vi.stubEnv(name, "inherited");
    const { session, factory } = harness();
    await session.ensureStarted();
    for (const name of nested) expect(factory.mock.calls[0][0].env).not.toHaveProperty(name);
    const spawn = factory.mock.calls[0][0];
    const headers = {
      authorization: `Bearer ${spawn.env?.YAAT_PANEL_TOKEN ?? ""}`,
      "content-type": "application/json",
    };
    const endpoint = `${spawn.env?.YAAT_PANEL_URL ?? ""}/v1/sessions/${spawn.env?.YAAT_PANEL_KEY ?? ""}`;
    const toolset = await fetch(`${endpoint}/toolset`, { headers });
    expect(toolset.status).toBe(200);
    expect(await toolset.json()).toMatchObject({ tools: [], instructions: "" });
    const call = await fetch(`${endpoint}/call`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "write_note", params: {} }),
    });
    expect(call.status).toBe(403);
    await call.text();
  });

  it.each([
    ["single", { agent: "A", task: "one" }, 1],
    ["parallel", { tasks: [{ agent: "A" }, { agent: "B" }] }, 2],
    ["chain", { chain: [{ agent: "A" }, { agent: "B" }] }, 2],
    ["workflow", { workflow: true }, 1],
    ["management", { action: "status" }, 0],
  ] as const)(
    "formats and tracks %s tool calls without inventing background runs",
    async (mode, args, count) => {
      const { session, clients, events } = harness();
      await session.send("work");
      const { event } = clients[0];
      event({ type: "agent_start" });
      event({ type: "tool_execution_start", toolName: "subagent", toolCallId: "call", args });
      event({
        type: "tool_execution_end",
        toolName: "subagent",
        toolCallId: "call",
        result: { details: { mode, results: [] } },
      });
      expect(events.filter((entry) => entry.kind === "subagent_start")).toHaveLength(count);
      expect(events.filter((entry) => entry.kind === "subagent_done")).toHaveLength(count);
      event({ type: "agent_settled" });
      expect(session.runState).toBe("idle");
    },
  );

  it("enforces MIME, missing files, and the aggregate 12 MiB raw budget before dispatch", async () => {
    const { dir, session, factory, clients } = harness();
    const before = vi.fn();
    const png = Buffer.alloc(6 * 1024 * 1024);
    Buffer.from("89504e470d0a1a0a", "hex").copy(png);
    fs.writeFileSync(path.join(dir, "a.png"), png);
    fs.writeFileSync(path.join(dir, "b.png"), Buffer.concat([png, Buffer.alloc(1)]));
    fs.writeFileSync(path.join(dir, "unsafe.svg"), "<svg/>");
    fs.writeFileSync(path.join(dir, "fake.png"), "not a PNG");
    const send = (attachmentIds: string[]) =>
      session.send({ inputId: "img", text: "", attachmentIds }, { onBeforeWrite: before });
    await expect(send(["unsafe.svg"])).rejects.toThrow(/MIME/);
    await expect(send(["fake.png"])).rejects.toThrow(/MIME/);
    await expect(send(["missing.png"])).rejects.toThrow(/ENOENT/);
    await expect(send(["a.png", "b.png"])).rejects.toThrow(/12 MiB/);
    expect(before).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(session.runState).toBe("idle");
    await expect(send(["uploads/a.png", "a.png"])).resolves.toEqual({ disposition: "started" });
    expect(before).toHaveBeenCalledTimes(1);
    expect(
      clients[0].wire.find((frame) => frame.type === "prompt")?.images as unknown[],
    ).toHaveLength(2);
  });

  it("closes thinking deltas before finalized thinking and retains authoritative text, tool formatting and usage columns", async () => {
    const { session, clients, events } = harness();
    await session.send("stream");
    const { event } = clients[0];
    event({ type: "agent_start" });
    for (const update of [
      { type: "thinking_delta", contentIndex: 2, delta: "dr" },
      { type: "thinking_end", contentIndex: 2, content: "draft" },
      { type: "text_delta", contentIndex: 0, delta: "he" },
    ]) {
      event({ type: "message_update", assistantMessageEvent: update });
    }
    event({
      type: "tool_execution_start",
      toolCallId: "tool",
      toolName: "write_note",
      args: { slug: "example", body: "indexed" },
    });
    event({
      type: "tool_execution_end",
      toolCallId: "tool",
      toolName: "write_note",
      result: { content: [{ type: "text", text: "saved" }] },
    });
    event({
      type: "tool_execution_end",
      toolCallId: "no-start",
      toolName: "read",
      result: { content: [] },
    });
    event({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        usage: { input: 5, output: 2, cacheRead: 1, cost: { total: 0.2 } },
      },
    });
    event({ type: "agent_settled" });
    expect(events.slice(0, 3)).toEqual([
      { kind: "thinking_delta", content: "dr" },
      { kind: "thinking_delta", content: "", durationMs: expect.any(Number) as unknown },
      { kind: "thinking", content: "draft", durationMs: expect.any(Number) as unknown },
    ]);
    expect(events.find((entry) => entry.kind === "tool_use")).toMatchObject({
      toolName: "mcp__panel__write_note",
      toolSource: "panel",
      content: expect.stringContaining('"body": "indexed"') as unknown,
    });
    expect(events.find((entry) => entry.toolUseId === "no-start")?.durationMs).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      kind: "result",
      content: "hello",
      context: { tokens: 6, window: 100 },
    });
    expect(session.usage.input_tokens).toBe(5);
    await vi.waitFor(() => expect(session.usage.input_tokens).toBe(99));
    expect(await session.getContextUsage()).toBeNull();
    expect(await session.getUsageInfo()).toMatchObject({ cost: 3, tokens: { output: 7 } });
  });

  it("decodes real Pi 1.6 session_start extension UI frames without opening or answering a dialog", async () => {
    const { session, clients } = harness();
    await session.send("extension UI");
    const events = vi.fn<(e: ExtensionUiEvent) => void>(),
      unhandled = vi.fn<(e: Frame) => void>();
    session.on("extension_ui", events);
    session.on("unhandled", unhandled);
    const frames = fs
      .readFileSync(path.join(__dirname, "fixtures/pi-1.6-extension-ui.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Frame);
    for (const frame of frames) clients[0].event(frame);
    expect(events.mock.calls.map(([event]) => event.change)).toEqual([
      { kind: "notify", level: "info", message: "hello", id: frames[0].id },
      { kind: "notify", level: "warning", message: "warning", id: frames[1].id },
      { kind: "status", key: "progress", text: "ready" },
      {
        kind: "widget",
        key: "panel",
        placement: "aboveEditor",
        lines: ["<b>not HTML</b>", "line two"],
      },
      { kind: "widget", key: "panel", placement: "belowEditor", lines: ["moved"] },
      { kind: "status", key: "progress" },
      { kind: "widget", key: "panel", placement: "aboveEditor" },
    ]);
    expect(events.mock.calls[0][0]).toMatchObject({
      workspaceId: "workspace",
      agentId: "agent",
      processGeneration: 0,
    });
    expect(unhandled.mock.calls.map(([frame]) => frame.method)).toEqual([
      "setTitle",
      "set_editor_text",
    ]);
    expect(session.pendingUiDialogs).toEqual([]);
    expect(clients[0].wire.some((frame) => frame.type === "extension_ui_response")).toBe(false);
  });

  it.each(["reset", "exit", "dispose"])(
    "bounds live state and releases the retired generation on %s",
    async (end) => {
      const h = harness();
      const unhandled = vi.fn();
      const { ws } = workspaceFor(h, { onUnhandled: unhandled });
      const agent = ws.addAgent("Pi", "mock/test", "", "", { backend: "pi" });
      await h.session.ensureStarted();
      const c = h.clients[0];
      const send = (method: string, fields: object) =>
        c.event({ type: "extension_ui_request", method, id: "ui", ...fields });
      for (let i = 0; i < 25; i++) {
        send("setStatus", { statusKey: `s${i}`, statusText: "x".repeat(255) + "🐈" });
        send("setWidget", {
          widgetKey: `w${i}`,
          widgetLines: Array<string>(20).fill("x".repeat(300)),
        });
      }
      send("setStatus", { statusKey: "s20", statusText: "" }); // Pi clears only on undefined.
      const [snapshot] = ws.getExtensionUi();
      expect(snapshot).toMatchObject({
        workspaceId: ws.id,
        agentId: agent.id,
        processGeneration: 0,
      });
      expect(snapshot.statuses).toHaveLength(16);
      expect(snapshot.statuses[0]).toEqual({ key: "s9", text: "x".repeat(255) });
      expect(snapshot.statuses.at(-1)).toEqual({ key: "s20", text: "" });
      expect(snapshot.widgets).toHaveLength(8);
      expect(snapshot.widgets[0]).toMatchObject({
        key: "w17",
        lines: Array<string>(12).fill("x".repeat(256)),
      });
      for (const [method, fields] of [
        ["futureMethod", {}],
        ["setStatus", { statusKey: "x".repeat(129) }],
        ["setStatus", { statusKey: "s20", statusText: null }],
        ["setWidget", { widgetKey: "w17", widgetLines: 42 }],
        ["setWidget", { widgetKey: "w17", widgetLines: [42] }],
        ["notify", { message: 42 }],
        ["select", { id: null }],
      ] as const)
        send(method, fields);
      expect(ws.getExtensionUi()).toEqual([snapshot]);
      expect(unhandled).toHaveBeenCalledTimes(7);
      send("setWidget", { widgetKey: "w17", widgetLines: [42, "valid"] });
      expect(ws.getExtensionUi()[0].widgets.at(-1)?.lines).toEqual(["valid"]);
      expect(unhandled).toHaveBeenCalledTimes(8);
      expect(c.wire.some((frame) => frame.type === "extension_ui_response")).toBe(false);
      if (end === "reset") h.session.resetContext();
      else if (end === "exit") c.rpc.emit("exit", 1, null);
      else await h.session.dispose();
      send("setStatus", { statusKey: "late", statusText: "obsolete" });
      expect(ws.getExtensionUi()).toEqual([
        { workspaceId: ws.id, agentId: agent.id, processGeneration: 1, statuses: [], widgets: [] },
      ]);
      ws.removeAgent(agent.id);
      expect(ws.getExtensionUi()).toEqual([]);
    },
  );

  it("services the RPC stream during dialogs, consumes valid answers once, and cancels on timeout and interrupt", async () => {
    const { session, clients } = harness({ options: { dialogFallbackTimeoutMs: 25 } });
    await session.send("dialog");
    const { event, wire } = clients[0];
    const resolved = vi.fn();
    session.on("ui_dialog_resolved", resolved);
    event({
      type: "extension_ui_request",
      id: "confirm",
      method: "confirm",
      title: "Permission",
      timeout: 1000,
    });
    event({ type: "extension_ui_request", id: "expires", method: "input", title: "Input" });
    expect(session.pendingUiDialogs).toHaveLength(2);
    await expect(clients[0].rpc.getState()).resolves.toMatchObject({
      sessionId: session.sessionId,
    });
    session.respondToUiDialog("confirm", { requestId: "confirm", confirmed: false });
    session.respondToUiDialog("confirm", { requestId: "confirm", confirmed: true });
    await vi.waitFor(() => expect(session.pendingUiDialogs).toHaveLength(0));
    expect(wire.filter((frame) => frame.type === "extension_ui_response")).toEqual([
      { type: "extension_ui_response", id: "confirm", confirmed: false },
      { type: "extension_ui_response", id: "expires", cancelled: true },
    ]);
    expect(resolved).toHaveBeenCalledTimes(2);
    event({ type: "extension_ui_request", id: "abort", method: "editor", timeout: 1000 });
    const interrupted = session.interrupt();
    event({ type: "agent_settled", aborted: true });
    await expect(interrupted).resolves.toBe(true);
    expect(wire).toContainEqual({ type: "extension_ui_response", id: "abort", cancelled: true });
    expect(wire.some((frame) => frame.type === "clear_queue")).toBe(false);
  });
});

describe("PiSession bounded recovery", () => {
  it.each([
    [
      "off-branch anchor",
      (report: PanelReadyReport) => {
        report.sessionProof.anchorOnActiveBranch = false;
      },
    ],
    [
      "wrong session ID",
      (report: PanelReadyReport) => {
        report.sessionProof.sessionId = "different";
      },
    ],
    [
      "short entry count",
      (report: PanelReadyReport) => {
        report.sessionProof.entryCount = 3;
      },
    ],
  ])("closes and refuses %s without replacing saved state", async (_, ready) => {
    const { session, clients, register, factory } = harness({ ready, state: confirmed });
    const before = session.getState();
    expect(factory).not.toHaveBeenCalled();
    const hook = vi.fn();
    await expect(session.send("never", { onBeforeWrite: hook })).rejects.toThrow(/restore proof/);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ restoreExpectation: { expectedAnchorId: "anchor" } }),
    );
    expect(factory.mock.calls[0][0].args).toEqual(
      expect.arrayContaining(["--session", before.sessionFile]),
    );
    expect(clients[0].wire.some((frame) => frame.type === "prompt")).toBe(false);
    expect(clients[0].rpc.stdin.writableEnded).toBe(true);
    expect(hook).not.toHaveBeenCalled();
    expect(session.getState()).toEqual(before);
  });

  it("checks the exact file header before spawning", async () => {
    const h = harness({ state: confirmed });
    fs.writeFileSync(h.state!.sessionFile!, '{"type":"session","id":"wrong"}\n');
    await expect(h.session.ensureStarted()).rejects.toThrow(/header/);
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("updates restore anchors asynchronously without holding the next prompt", async () => {
    const h = harness({ state: confirmed });
    let resolveCheckpoint!: (value: {
      sessionId: string;
      sessionFile: string;
      leafId: string;
      entryCount: number;
    }) => void;
    vi.spyOn(h.panel, "isControlConnected").mockReturnValue(true);
    vi.spyOn(h.panel, "requestSessionCheckpoint").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheckpoint = resolve;
        }),
    );
    const before = vi.fn();
    await h.session.send("first", { onBeforeWrite: before });
    expect(before).toHaveBeenCalledWith(
      expect.objectContaining({ beforeLeafId: "anchor", beforeEntryCount: 4 }),
    );
    h.clients[0].event({ type: "agent_settled" });
    await expect(h.session.send("next")).resolves.toEqual({ disposition: "started" });
    resolveCheckpoint({
      sessionId: "saved",
      sessionFile: h.state!.sessionFile!,
      leafId: "new",
      entryCount: 7,
    });
    await vi.waitFor(() =>
      expect(h.session.getState()).toMatchObject({ expectedLeafAnchorId: "new", minEntryCount: 7 }),
    );
  });

  it("promotes an unconfirmed session only after a positive report probe", async () => {
    const h = harness({
      state: saved,
      ready: (report) => {
        report.sessionProof.entryCount = 2;
        report.sessionProof.leafId = "found";
      },
    });
    const probe = vi
      .spyOn(h.panel, "probeDispatchedReport")
      .mockResolvedValueOnce({ found: false, anchorMissing: false })
      .mockResolvedValueOnce({ found: true, anchorMissing: false, matchedEntryId: "found" });
    await expect(h.session.probeDispatchedReport(null, "r")).resolves.toMatchObject({
      found: false,
    });
    expect(h.session.getState().hasConfirmedTurns).toBe(false);
    await expect(h.session.probeDispatchedReport(null, "r", 50)).resolves.toMatchObject({
      found: true,
      sessionProof: { entryCount: 2 },
    });
    expect(probe).toHaveBeenLastCalledWith(expect.any(String), null, "r", 50);
    expect(h.session.getState()).toMatchObject({
      hasConfirmedTurns: true,
      expectedLeafAnchorId: "found",
      minEntryCount: 2,
    });
  });
});

describe("PiSession interrupt recovery", () => {
  it("retires an unconfirmed interrupt generation and drops its late settled, exit and stats", async () => {
    const h = harness({ options: { interruptTimeoutMs: 25, statsTimeoutMs: 500 } });
    await h.session.send("previous");
    const old = h.clients[0];
    let lateStats!: (stats: Record<string, unknown>) => void;
    const stats = vi.spyOn(old.rpc, "getSessionStats").mockImplementation(
      () =>
        new Promise((resolve) => {
          lateStats = resolve;
        }),
    );
    fs.writeFileSync(
      path.join(h.dir, "session.jsonl"),
      JSON.stringify({ type: "session", id: h.session.sessionId }) + "\n",
    );
    old.event({ type: "agent_settled" });
    expect(stats).toHaveBeenCalledOnce();
    await h.session.send("timeout");
    await expect(h.session.interrupt()).resolves.toBe(false);
    await vi.waitFor(() => expect(old.end).toHaveBeenCalledOnce());
    expect(old.wire.filter((frame) => frame.type === "abort")).toHaveLength(1);
    expect(old.wire.some((frame) => frame.type === "clear_queue")).toBe(false);
    expect(h.session).toMatchObject({ tainted: true, processGeneration: 1 });
    // Inject late callbacks directly as queued emitter work even after stdin closes.
    old.rpc.emit("event", { type: "agent_settled" });
    old.rpc.emit("exit", 1, null);
    const before = vi.fn();
    await expect(h.session.send("replacement", { onBeforeWrite: before })).resolves.toEqual({
      disposition: "started",
    });
    expect(before).toHaveBeenCalledWith(expect.objectContaining({ generation: 1 }));
    expect(h.clients).toHaveLength(2);
    old.rpc.emit("event", { type: "agent_settled" });
    old.rpc.emit("exit", 1, null);
    lateStats({ tokens: { input: 500 }, contextUsage: { tokens: 42, window: 100 } });
    expect(await h.session.getContextUsage()).toBeNull();
    expect(h.session.isRunning).toBe(true);
    expect(h.session.usage.input_tokens).toBe(0);
    h.clients[1].event({ type: "agent_settled" });
    expect(h.session.runState).toBe("idle");
    expect(h.done).toHaveBeenCalledTimes(3);
  });

  it("routes a disconnected child stop to the exact on-disk index and nonempty ID and refuses workflow or paused stops", async () => {
    const pkg = temp();
    const bundle = path.join(pkg, "bundle");
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(pkg, "package.json"), '{"type":"module"}');
    fs.writeFileSync(
      path.join(bundle, "control-channel.js"),
      `
      import fs from 'node:fs';
      import path from 'node:path';
      export function requestAsyncStop(dir, payload) {
        const name = path.join(dir, 'control', 'stop-request.json');
        fs.mkdirSync(path.dirname(name), {recursive: true});
        fs.writeFileSync(name, JSON.stringify(payload));
        return name;
      }
    `,
    );
    const asyncDir = temp();
    const file = path.join(asyncDir, "status.json");
    const stopFile = path.join(asyncDir, "control", "stop-request.json");
    const h = harness({ config: { piSubagentsRoot: pkg }, options: { reconcileIntervalMs: 20 } });
    await h.session.send("background");
    const status = {
      runId: "run",
      sessionId: h.session.sessionId,
      mode: "parallel",
      state: "running",
      steps: [
        { childId: "", workflowKey: "actual-A", status: "running" },
        { childId: "actual-B", workflowKey: "ignore-B", status: "running" },
      ],
    };
    const write = () => fs.writeFileSync(file, JSON.stringify(status));
    write();
    const { event } = h.clients[0];
    event({
      type: "tool_execution_start",
      toolName: "subagent",
      toolCallId: "batch",
      args: { async: true, tasks: [{ agent: "A" }, { agent: "B" }] },
    });
    event({
      type: "tool_execution_end",
      toolName: "subagent",
      toolCallId: "batch",
      result: { details: { runId: "run", asyncDir, mode: "parallel" } },
    });
    event({ type: "agent_settled" });
    expect(h.session.runState).toBe("waiting");
    expect(h.session.backgroundTaskList.map((task) => task.id)).toEqual(["batch:0", "batch:1"]);
    for (const [mode, state] of [
      ["workflow", "running"],
      ["parallel", "paused"],
    ]) {
      status.mode = mode;
      status.state = state;
      write();
      await expect(h.session.stopTask("batch:0")).rejects.toThrow(
        "child_stop_unavailable_bridge_disconnected",
      );
      expect(fs.existsSync(stopFile)).toBe(false);
    }
    status.mode = "parallel";
    status.state = "running";
    write();
    const finishB = path.join(asyncDir, "finish-B");
    const pairedRunner = path.join(asyncDir, "fixture.cjs");
    fs.writeFileSync(
      pairedRunner,
      `
      const fs = require('node:fs');
      const [file, stopFile, finishB] = process.argv.slice(2);
      const status = JSON.parse(fs.readFileSync(file, 'utf8'));
      const write = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(status)); fs.renameSync(file + '.tmp', file); };
      const timer = setInterval(() => {
        if (status.steps[0].status === 'running' && fs.existsSync(stopFile)) {
          const stop = JSON.parse(fs.readFileSync(stopFile, 'utf8'));
          if (stop.targetIndex !== 0 || stop.childId !== 'actual-A') process.exit(2);
          status.steps[0].status = 'stopped';
          write();
        }
        if (fs.existsSync(finishB)) {
          status.steps[1].status = 'completed';
          status.state = 'completed';
          write();
          clearInterval(timer);
        }
      }, 10);
    `,
    );
    const runner = spawn(process.execPath, [pairedRunner, file, stopFile, finishB], {
      stdio: "ignore",
    });
    const exited = once(runner, "exit");
    cleanup.push(async () => {
      runner.kill();
      await exited;
    });
    await h.session.stopTask("batch:0");
    expect(JSON.parse(fs.readFileSync(stopFile, "utf8")) as unknown).toEqual({
      targetIndex: 0,
      childId: "actual-A",
      source: "panel-host-fallback",
    });
    await vi.waitFor(() =>
      expect(h.session.backgroundTaskList.map((task) => task.id)).toEqual(["batch:1"]),
    );
    expect(
      h.events
        .filter((event) => event.kind === "subagent_done")
        .map((event) => event.subagent?.status),
    ).toEqual(["stopped"]);
    fs.writeFileSync(finishB, "");
    await expect(exited).resolves.toEqual([0, null]);
    await vi.waitFor(() => expect(h.session.runState).toBe("idle"));
    expect(
      h.events
        .filter((event) => event.kind === "subagent_done")
        .map((event) => event.subagent?.status),
    ).toEqual(["stopped", "completed"]);
  });
});

describe("PiSession detached runner cleanup", () => {
  it("reaps a registered cross-PGID runner after its Pi parent has already exited and frees its port", async () => {
    const dir = temp();
    const cfg = config(dir);
    const asyncDir = path.join(dir, "run");
    fs.mkdirSync(asyncDir);
    const runnerFile = path.join(asyncDir, "async-runner.cjs");
    const launcherFile = path.join(dir, "fake-pi.cjs");
    const pidFile = path.join(asyncDir, "status.json");
    fs.writeFileSync(
      runnerFile,
      `
      const fs = require('node:fs');
      const net = require('node:net');
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], JSON.stringify({
        runId: 'detached', sessionId: 'saved', mode: 'single', state: 'running', pid: process.pid, port: server.address().port
      })));
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
    `,
    );
    fs.writeFileSync(
      launcherFile,
      `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, [process.argv[2], process.argv[3]], { detached: true, stdio: 'ignore' });
      child.unref();
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const command = JSON.parse(line);
        const data = { get_state: { sessionId: 'saved' }, get_available_models: { models: [] }, get_commands: { commands: [] }, get_available_thinking_levels: { levels: [] }}[command.type];
        process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: true, data })+'\\n');
      });
      const timer = setInterval(() => { if (fs.existsSync(process.argv[4])) { clearInterval(timer); process.exit(0); } }, 10);
    `,
    );
    let rpc: PiRpcClient | undefined;
    let runner: { pid: number; port: number } | undefined;
    cleanup.push(() => {
      if (runner) {
        try {
          process.kill(runner.pid, "SIGKILL");
        } catch {
          /* exited */
        }
      }
    });
    const panel = new PanelHttpServer();
    cleanup.push(() => panel.close());
    vi.spyOn(panel, "waitForReady").mockResolvedValue({
      sessionProof: {
        sessionId: "saved",
        sessionFile: null,
        cwd: dir,
        headerCwd: dir,
        entryCount: 0,
        leafId: null,
        anchorOnActiveBranch: true,
        anchorExistsInFile: false,
      },
      ownerToolNames: [],
      requiredExtensionsRegistered: false,
      subagentsRpcReady: false,
      subagentsSessionId: null,
    });
    const exitFile = path.join(dir, "exit");
    const state = saved(cfg, [
      {
        runId: "detached",
        asyncDir,
        mode: "single",
        startedAt: Date.now(),
        ownerMessageId: "input",
        toolCallId: "tool",
        children: [{ taskId: "tool:0", stepIndex: 0, canonicalChildId: "child" }],
      },
    ]);
    const session = PiSession.fromState(state, {
      panelHttp: panel,
      rpcFactory: (opts) =>
        (rpc = PiRpcClient.spawn({
          ...opts,
          binary: process.execPath,
          args: [launcherFile, runnerFile, pidFile, exitFile],
        })),
    });
    cleanup.push(() => session.dispose());
    await session.ensureStarted();
    await vi.waitFor(() => {
      runner = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { pid: number; port: number };
    });
    expect(runner?.pid).not.toBe(rpc!.pid);
    const pgid = (pid: number) =>
      execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    expect(pgid(runner!.pid)).toBe(String(runner!.pid));
    expect(pgid(runner!.pid)).not.toBe(pgid(rpc!.pid!));
    const exited = once(rpc!, "exit");
    fs.writeFileSync(exitFile, "");
    await exited;
    const startedAt = Date.now();
    await session.dispose(10_000);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const server = net.createServer().listen(runner!.port, "127.0.0.1");
    await once(server, "listening");
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(() => process.kill(runner!.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    runner = undefined;
  }, 12_000);
});
