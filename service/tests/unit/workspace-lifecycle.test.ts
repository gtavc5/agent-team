import { describe, it, expect, vi } from "vitest";
import { summarizeMessage } from "../../src/workspace/summary";
import { EventEmitter } from "events";
import {
  Workspace,
  type WorkspaceCallbacks,
  type WorkspaceState,
} from "../../src/workspace/workspace";
import { HostRegistry, Host, HostSessionHandle, HostInfo, LocalHost } from "../../src/session/host";
import {
  PromptEnvelope,
  SessionConfig,
  SessionState,
  StreamEvent,
  UsageStats,
} from "../../src/session/types";

const emptyUsage: UsageStats = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  turns: 0,
  duration_ms: 0,
};

// Like ClaudeSession: abort() clears the running flag synchronously.
class FakeSession extends EventEmitter implements HostSessionHandle {
  sessionId: string | null = null;
  usage: UsageStats = { ...emptyUsage };
  isRunning = false;
  sent: string[] = [];
  constructor(private config: SessionConfig) {
    super();
  }
  send(prompt: string | PromptEnvelope): Promise<void> {
    this.sent.push(typeof prompt === "string" ? prompt : prompt.text);
    this.isRunning = true;
    return Promise.resolve();
  }
  abort(): void {
    this.isRunning = false;
  }
  // As ClaudeSession's: never while a turn runs.
  due = false;
  get wakeDue(): boolean {
    return this.due && !this.isRunning;
  }
  pendingWake: { prompt: string; reason: string } | null = null;
  takeWake(): { prompt: string; reason: string } | null {
    const w = this.pendingWake;
    this.pendingWake = null;
    this.due = false;
    return w;
  }
  getState(): SessionState {
    return { sessionId: this.sessionId, config: this.config, usage: this.usage };
  }
}

class FakeHost implements Host {
  readonly id = "local";
  readonly label = "Local";
  readonly type = "local" as const;
  readonly connected = true;
  sessions = new Map<string, FakeSession>();
  getInfo(): HostInfo {
    return { id: this.id, label: this.label, type: this.type, connected: this.connected };
  }
  createSession(agentId: string, config: SessionConfig): HostSessionHandle {
    const s = new FakeSession(config);
    this.sessions.set(agentId, s);
    return s;
  }
  replaceSession(agentId: string, config: SessionConfig): HostSessionHandle {
    const old = this.sessions.get(agentId);
    old?.removeAllListeners();
    void this.destroySession(agentId);
    return this.createSession(agentId, config);
  }
  destroySession(agentId: string): Promise<void> {
    this.sessions.get(agentId)?.abort();
    this.sessions.delete(agentId);
    return Promise.resolve();
  }
  restoreSession(agentId: string, state: SessionState): HostSessionHandle {
    return this.createSession(agentId, state.config);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function finish(session: FakeSession, text: string, interrupted = false) {
  if (text) session.emit("event", { kind: "text_delta", content: text });
  session.isRunning = false;
  session.emit("event", { kind: "result", content: "", interrupted });
}

function addPeer(ws: Workspace, host: FakeHost, name = "B") {
  const agent = ws.addAgent(name, "gpt-5.6-terra", "b", "#888", { backend: "codex" });
  return { agent, session: host.sessions.get(agent.id)! };
}

function makeWorkspace(cb: Partial<WorkspaceCallbacks> = {}) {
  const host = new FakeHost();
  const registry = new HostRegistry();
  registry.register(host);
  const ws = new Workspace("ws-1", "t", "p", "local", "/tmp", registry, {
    onNewMessage: () => {},
    onStreamEvent: () => {},
    onMessageDone: () => {},
    ...cb,
  });
  const agent = ws.addAgent("A", "gpt-5.6-terra", "a", "#888", {
    backend: "codex",
  });
  const session = host.sessions.get(agent.id)!;
  return { ws, host, agent, session };
}

describe("Same-room peer discussion", () => {
  it("persists one visible prompt and queues only the busy target", async () => {
    const { ws, host, session: a } = makeWorkspace();
    const { agent: bob, session: b } = addPeer(ws, host);
    await ws.sendMessage("busy", bob.id);
    const admitted = vi.fn();
    await ws.sendMessage("@A @B @A shared", undefined, undefined, undefined, admitted);
    expect(admitted).toHaveBeenCalledTimes(1);
    expect(
      ws
        .getMessages()
        .filter((m) => m.kind === "user")
        .map((m) => m.content),
    ).toEqual(["busy", "@A @B @A shared"]);
    expect(a.sent.at(-1)).toContain("shared");
    expect(b.sent).toEqual(["busy"]);
    expect(ws.getMessages().at(-2)).toMatchObject({ status: "queued", queuedFor: bob.id });
    finish(b, "busy reply");
    await tick();
    expect(b.sent.at(-1)).toContain("shared");
    expect(ws.hasQueuedInput).toBe(false);
    await ws.dispose();
  });

  it("consumes room updates in finalization order without injecting tool or thinking text", async () => {
    const { ws, host, session: a } = makeWorkspace();
    const { session: b } = addPeer(ws, host);
    const { session: c } = addPeer(ws, host, "C");
    await ws.sendMessage("@A @B drafts");
    a.emit("event", { kind: "text_delta", content: "Step preamble" });
    a.emit("event", { kind: "tool_use", content: "private tool", toolUseId: "t" });
    a.emit("event", { kind: "thinking", content: "private thinking" });
    finish(b, "early peer reply");
    await ws.sendMessage("@C first");
    expect(c.sent.at(-1)).toContain("B: early peer reply");
    expect(c.sent.at(-1)).not.toMatch(/private|preamble/);
    finish(c, "first C reply");
    finish(a, "late peer reply");
    await tick();
    await ws.sendMessage("@C second");
    expect(c.sent.at(-1)).toContain("A: late peer reply");
    expect(c.sent.at(-1)).not.toMatch(/early peer|private|preamble/);
    finish(c, "second C reply");
    await tick();
    await ws.sendMessage("@C third");
    expect(c.sent.at(-1)).toBe("third");
    await ws.dispose();
  });

  it.each([1, 2] as const)(
    "completes %i cross-review rounds and synthesizes on the first explicit target",
    async (rounds) => {
      const { ws, host, session: a } = makeWorkspace();
      const { session: b } = addPeer(ws, host);
      await ws.sendMessage("@B @A proposal", undefined, undefined, undefined, undefined, rounds);
      finish(a, "draft A");
      await tick();
      expect(a.sent).toEqual(["proposal"]);
      finish(b, "draft B");
      await tick();
      for (let i = 1; i <= rounds; i++) {
        expect(a.sent.at(-1)).toContain(`Cross-review ${i}/${rounds}`);
        expect(a.sent.at(-1)).toContain(i === 1 ? "draft B" : `review B${i - 1}`);
        expect(b.sent.at(-1)).toContain("Do not modify files");
        finish(a, `review A${i}`);
        finish(b, `review B${i}`);
        await tick();
      }
      expect(b.sent.at(-1)).toContain("Consensus / Remaining trade-offs / Recommended plan");
      expect(a.sent).toHaveLength(rounds + 1);
      finish(b, "Final answer @A");
      await tick();
      expect(a.sent).toHaveLength(rounds + 1);
      expect(ws.getMessages().filter((m) => m.kind === "user")).toHaveLength(1);
      expect(ws.getMessages().at(-1)?.discussion).toEqual({ kind: "synthesis" });
      await ws.dispose();
    },
  );

  it.each(["stop", "manual", "removed", "failed"])(
    "does not leave orphan cross-reviews after %s",
    async (action) => {
      const { ws, host, session: a } = makeWorkspace();
      const { agent: bob, session: b } = addPeer(ws, host);
      await ws.sendMessage("@全体 proposal", undefined, undefined, undefined, undefined, 2);
      finish(a, "draft A");
      if (action === "stop") ws.abortAgent(bob.id);
      if (action === "manual") await ws.sendMessage("new request");
      if (action === "removed") ws.removeAgent(bob.id);
      if (action === "failed") {
        b.isRunning = false;
        b.emit("event", { kind: "error", content: "failed" });
      }
      if (action === "manual" || action === "stop") finish(b, "draft B");
      await tick();
      expect([...a.sent, ...b.sent].join("\n")).not.toContain("Peer discussion turn");
      await ws.dispose();
    },
  );

  it("only relays standalone prose mentions and stops at hop two", async () => {
    const { ws, host, session: a } = makeWorkspace();
    const { session: b } = addPeer(ws, host);
    await ws.sendMessage("proposal");
    finish(a, "mail@B https://example.test/@B ` @B ` @A\n```md\n@B\n```\n@B, please review.");
    await tick();
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0]).toContain("Peer discussion turn");
    finish(b, "@A check my finding");
    await tick();
    expect(a.sent).toHaveLength(2);
    finish(a, "@B another question");
    await tick();
    expect(b.sent).toHaveLength(1);
    expect(ws.getMessages().at(-1)).toMatchObject({
      discussion: { kind: "relay", from: "B", hop: 2, limitReached: true },
    });
    await ws.dispose();
  });

  it("cancels automatic turns already running when a new draft is sent", async () => {
    const { ws, host, session: a } = makeWorkspace();
    const { session: b } = addPeer(ws, host);
    const { session: c } = addPeer(ws, host, "C");
    await ws.sendMessage("@all proposal", undefined, undefined, undefined, undefined, 2);
    finish(a, "A draft");
    finish(b, "B draft");
    finish(c, "C draft");
    await tick();
    expect(a.sent.at(-1)).toContain("Cross-review 1/2");
    expect(b.isRunning).toBe(true);
    expect(c.isRunning).toBe(true);
    await ws.sendMessage("@A new manual request");
    expect(a.sent.at(-1)).toContain("new manual request");
    expect(b.isRunning).toBe(false);
    expect(c.isRunning).toBe(false);
    expect(
      ws
        .getMessages()
        .filter((m) => m.status === "streaming")
        .map((m) => m.discussion),
    ).toEqual([undefined]);
    expect(ws.hasQueuedInput).toBe(false);
    await ws.dispose();
  });

  it("drops a relay waiting behind a busy peer when a new manual message arrives", async () => {
    const { ws, host, session: a } = makeWorkspace();
    const { agent: bob, session: b } = addPeer(ws, host);
    await ws.sendMessage("busy", bob.id);
    await ws.sendMessage("proposal");
    finish(a, "@B review this");
    await tick();
    expect(b.sent).toEqual(["busy"]);
    await ws.sendMessage("new manual message");
    finish(b, "done");
    await tick();
    expect(b.sent).toEqual(["busy"]);
    await ws.dispose();
  });

  it("cancels a queued structured draft on Stop, but leaves ordinary user queues alone", async () => {
    const { ws, host, agent, session: a } = makeWorkspace();
    const { agent: peer, session: b } = addPeer(ws, host);
    await ws.sendMessage("busy", peer.id);
    await ws.sendMessage("normal queued", peer.id);
    await ws.sendMessage("@all proposal", undefined, undefined, undefined, undefined, 1);
    ws.abortAgent(agent.id);
    finish(b, "busy done");
    await tick();
    expect(b.sent.at(-1)).toContain("normal queued");
    finish(b, "normal done");
    await tick();
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(2);
    expect(ws.hasQueuedInput).toBe(false);
    await ws.dispose();
  });

  it("restores queued room slots and read cursors without restarting automatic reviews", async () => {
    const { ws, host, agent, session: a } = makeWorkspace();
    const { agent: bob, session: b } = addPeer(ws, host);
    await ws.sendMessage("first", bob.id);
    finish(b, "already seen reply");
    await ws.sendMessage("busy", bob.id);
    await ws.sendMessage("@all proposal", undefined, undefined, undefined, undefined, 1);
    expect(a.sent.at(-1)).toContain("already seen reply");
    finish(a, "first draft finished");
    const state = JSON.parse(JSON.stringify(ws.getState())) as WorkspaceState;
    await ws.dispose();
    const registry = new HostRegistry();
    registry.register(host);
    const restored = Workspace.fromState(state, registry);
    try {
      restored.settleStartingOnRestore();
      restored.settlePlainDispatchingOnRestore();
      expect(restored.hasQueuedFor(bob.id)).toBe(true);
      restored.dequeueNext(bob.id);
      await tick();
      const restoredB = host.sessions.get(bob.id)!;
      expect(restoredB.sent).toEqual(["proposal"]);
      finish(restoredB, "resumed draft");
      await tick();
      const restoredA = host.sessions.get(agent.id)!;
      await restored.sendMessage("next");
      expect(restoredA.sent.at(-1)).toContain("resumed draft");
      expect(restoredA.sent.at(-1)).not.toContain("already seen reply");
      expect(restored.getMessages().filter((m) => m.content === "@all proposal")).toHaveLength(1);
    } finally {
      await restored.dispose();
    }
  });

  it("ignores quoted code mentions and never broadcasts slash commands", async () => {
    const { ws, host, session: a } = makeWorkspace();
    const { session: b } = addPeer(ws, host);
    const snippet = "inspect ` @all `\n```text\n@全体\n```";
    await ws.sendMessage(`@A ${snippet}`);
    expect(a.sent).toEqual([snippet]);
    expect(b.sent).toEqual([]);
    finish(a, "OK");
    await ws.sendMessage("@all /usage");
    expect(ws.getMessages().at(-1)).toMatchObject({ localCommand: true });
    await ws.sendMessage("@B @A /compact");
    expect(a.sent).toEqual([snippet]);
    expect(b.sent).toEqual(["/compact"]);
    await ws.dispose();
  });

  it("retains a surviving peer's admitted draft and tracks its visible input", async () => {
    const { ws, host, agent, session: a } = makeWorkspace();
    const { agent: peer, session: b } = addPeer(ws, host);
    await ws.sendMessage("busy", peer.id);
    await ws.sendMessage("@all proposal", undefined, undefined, undefined, undefined, 1);
    expect(a.sent.at(-1)).toContain("proposal");
    ws.removeAgent(agent.id);
    finish(b, "busy result");
    await tick();
    expect(b.sent).toEqual(["busy", "proposal"]);
    finish(b, "surviving draft");
    expect(ws.lastTurns()[0]).toMatchObject({
      input: { content: "@all proposal" },
      replies: [expect.objectContaining({ content: "surviving draft" })],
    });
    await ws.dispose();
  });

  it("queues project delivery behind a structured draft instead of letting it steal that turn", async () => {
    const { ws, host, session: a } = makeWorkspace();
    const { session: b } = addPeer(ws, host);
    const steer = vi.fn().mockResolvedValue(true);
    Object.defineProperty(a, "steer", { value: steer });
    await ws.sendMessage("@all proposal", undefined, undefined, undefined, undefined, 1);
    expect(
      ws.deliver(
        "report",
        { role: "worker", workspaceId: "other", name: "Worker" },
        "Project report",
      ),
    ).toBe("queued");
    expect(steer).not.toHaveBeenCalled();
    finish(a, "A draft");
    finish(b, "B draft");
    await tick();
    expect(a.sent.at(-1)).toBe("Project report");
    expect(b.sent.at(-1)).toContain("Cross-review 1/1");
    finish(a, "Report response");
    await tick();
    expect(a.sent.at(-1)).toContain("Cross-review 1/1");
    await ws.dispose();
  });

  it("does not invoke persistent lead recovery for failed automatic turns", async () => {
    const onLeadTerminal = vi.fn<NonNullable<WorkspaceCallbacks["onLeadTerminal"]>>();
    const { ws, host, session: a } = makeWorkspace({ onLeadTerminal });
    const { session: b } = addPeer(ws, host);
    await ws.sendMessage("proposal");
    finish(a, "@B please verify");
    await tick();
    expect(b.sent).toHaveLength(1);
    b.isRunning = false;
    b.emit("event", { kind: "error", content: "connection failed", networkFailure: true });
    expect(onLeadTerminal).toHaveBeenCalledTimes(1);
    await ws.dispose();
  });

  it("keeps a confirmed context cursor when a later Codex steer returns unread", async () => {
    const { ws, host, session: a } = makeWorkspace();
    const { agent: peer, session: b } = addPeer(ws, host);
    const steer = vi.fn<(text: string, id: string) => Promise<boolean>>().mockResolvedValue(true);
    Object.defineProperty(a, "steer", { value: steer });
    await ws.sendMessage("A running");
    await ws.sendMessage("B independent", peer.id);
    finish(b, "B peer reply");
    await ws.sendMessage("steer one");
    await ws.sendMessage("steer two");
    expect(steer).toHaveBeenCalledTimes(2);
    expect(steer.mock.calls[0][0]).toContain("B peer reply");
    a.emit("steered", steer.mock.calls[0][1]);
    a.emit("unread", [steer.mock.calls[1][1]]);
    finish(a, "after first steer");
    await tick();
    expect(a.sent.at(-1)).toBe("steer two");
    await ws.dispose();
  });

  it("leaves single-agent prompts and persisted state free of room context", async () => {
    const { ws, session } = makeWorkspace();
    await ws.sendMessage("@全体 first");
    finish(session, "reply");
    await ws.sendMessage("second");
    expect(session.sent).toEqual(["first", "second"]);
    expect(ws.getState()).not.toHaveProperty("roomClock");
    expect(ws.getState().agents[0]).not.toHaveProperty("roomCursor");
    await ws.dispose();
  });

  it("does not relay code, URL, email, or self mentions alone", async () => {
    const { ws, host, session: a } = makeWorkspace();
    const { session: b } = addPeer(ws, host);
    await ws.sendMessage("proposal");
    finish(
      a,
      "```md\n@B\n```\n> ```md\n> @B\n> ```\n` @B ` mail@B https://example.test/@B @B.example @A",
    );
    await tick();
    expect(b.sent).toEqual([]);
    await ws.dispose();
  });
});

describe("Workspace network waiting", () => {
  it("publishes transient recovery state live and in fresh snapshots without holding Send", async () => {
    const onAgentUpdated = vi.fn<NonNullable<WorkspaceCallbacks["onAgentUpdated"]>>();
    const { ws, agent, session } = makeWorkspace({ onAgentUpdated });
    ws.projectLink = { projectId: "p1", role: "lead" };
    try {
      onAgentUpdated.mockClear();
      expect(ws.isNetworkWaiting(agent.id)).toBe(false);
      ws.setNetworkWaiting(agent.id, true);
      ws.setNetworkWaiting(agent.id, true);
      expect(ws.isNetworkWaiting(agent.id)).toBe(true);
      const fresh = ws.getInfo(false).agents[0];
      expect(fresh).toMatchObject({ networkWaiting: true, busy: false, state: "idle" });
      expect(onAgentUpdated.mock.calls).toEqual([[ws.id, fresh, true]]);
      expect(ws.getState().agents[0]).not.toHaveProperty("networkWaiting");

      await ws.sendMessage("Manual message");
      expect(session.sent).toEqual(["Manual message"]);
      expect(ws.isNetworkWaiting(agent.id)).toBe(true);
      ws.setNetworkWaiting(agent.id, false);
      expect(ws.isNetworkWaiting(agent.id)).toBe(false);
      const cleared = ws.getInfo(false).agents[0];
      expect(cleared.networkWaiting).toBe(false);
      expect(onAgentUpdated).toHaveBeenLastCalledWith(ws.id, cleared, true);
    } finally {
      await ws.dispose();
    }
  });
});

describe("Workspace teardown", () => {
  it("dispose does not start a queued prompt and releases the sessions", async () => {
    const { ws, host, session } = makeWorkspace();
    await ws.sendMessage("running");
    await ws.sendMessage("queued");
    await ws.dispose();
    await tick();
    expect(session.sent).toEqual(["running"]);
    expect(host.sessions.size).toBe(0);
    expect(session.listenerCount("event")).toBe(0);
  });

  it("a real LocalHost forgets the sessions of a disposed workspace", async () => {
    const host = new LocalHost("local", "Local");
    const registry = new HostRegistry();
    registry.register(host);
    const ws = new Workspace("ws-d", "d", "p", "local", "/tmp", registry);
    ws.addAgent("A", "gpt-5.6-terra", "a", "#888", { backend: "codex" });
    await ws.dispose();
    expect((host as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
  });

  it("removing an agent mid-turn finishes its reply and drops its queue", async () => {
    const done: string[] = [];
    const { ws, agent } = makeWorkspace({
      onMessageDone: (_ws, id, status) => done.push(`${id}:${status}`),
    });
    await ws.sendMessage("go");
    await ws.sendMessage("later");
    const reply = ws.messages.find((m) => m.kind === "agent")!;
    const queued = ws.messages.find((m) => m.status === "queued")!;

    expect(ws.removeAgent(agent.id)).toEqual([queued.id]);
    expect(reply.status).toBe("done");
    expect(done).toContain(`${reply.id}:done`);
    expect(ws.messages.some((m) => m.id === queued.id)).toBe(false);
    expect(ws.isIdle).toBe(true);
    expect(ws.removeAgent(agent.id)).toBeNull();
  });
});

describe("Tool result aggregation invariant", () => {
  it.each(["turn", "subagent"])(
    "folds matched %s tool results without leaving standalone rows",
    async (scope) => {
      const { ws, session } = makeWorkspace();
      try {
        await ws.sendMessage("go");
        const reply = ws.messages.find((m) => m.kind === "agent")!;
        if (scope === "subagent") {
          session.emit("event", {
            kind: "subagent_start",
            content: "",
            subagent: { taskId: "child", status: "running", events: [] },
          });
        }
        const emit = (event: StreamEvent) =>
          session.emit(
            "event",
            scope === "turn"
              ? event
              : {
                  kind: "subagent_progress",
                  content: "",
                  subagent: { taskId: "child", _innerEvent: event },
                },
          );
        for (const id of ["first", "second"]) {
          emit({ kind: "tool_use", content: "**Read** `file.ts`", toolUseId: id });
        }
        for (const id of ["second", "first"]) {
          emit({
            kind: "tool_result",
            content: id,
            toolUseId: id,
            isError: true,
            isMarkdown: true,
            durationMs: 17,
          });
        }
        const events =
          scope === "turn"
            ? reply.events
            : reply.events?.find((e) => e.kind === "subagent_start")?.subagent?.events;
        expect(events).toMatchObject(
          ["first", "second"].map((id) => ({
            kind: "tool_use",
            toolUseId: id,
            toolResult: id,
            toolResultIsError: true,
            toolResultIsMarkdown: true,
            durationMs: 17,
          })),
        );
      } finally {
        await ws.dispose();
      }
    },
  );
});

describe("Streaming timers", () => {
  it("snapshots the active timer but never the live thinking text", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const { ws, session } = makeWorkspace();
      await ws.sendMessage("go");
      const reply = ws.messages.find((m) => m.kind === "agent")!;
      expect(summarizeMessage(reply).waitingSince).toBe(1_000);

      clock.mockReturnValue(8_000);
      session.emit("event", { kind: "thinking_delta", content: "draft", startedAt: 7_500 });
      session.emit("event", { kind: "thinking_delta", content: " more" });
      const midThinking = summarizeMessage(reply);
      expect(midThinking.liveThinkingSince).toBe(7_500);
      expect(midThinking.waitingSince).toBeUndefined();
      expect(JSON.stringify(midThinking)).not.toContain("draft");
      expect(JSON.stringify(ws.getState())).not.toContain("liveThinkingSince");

      session.emit("event", { kind: "thinking", content: "finished", durationMs: 500 });
      session.emit("event", { kind: "tool_use", content: "Read", toolUseId: "read" });
      expect(reply.liveThinkingSince).toBeUndefined();
      expect(reply.waitingSince).toBeUndefined();
      clock.mockReturnValue(10_000);
      session.emit("event", { kind: "tool_result", content: "OK", toolUseId: "read" });
      expect(summarizeMessage(reply).waitingSince).toBe(10_000);
      expect(JSON.stringify(ws.getState())).not.toContain("waitingSince");

      session.emit("event", { kind: "result", content: "" });
      expect(reply.liveThinkingSince).toBeUndefined();
      expect(reply.waitingSince).toBeUndefined();
      expect(reply.events).toContainEqual(
        expect.objectContaining({ kind: "thinking", durationMs: 500 }),
      );
    } finally {
      clock.mockRestore();
    }
  });
});

describe("Workspace model switching", () => {
  const models = [
    {
      id: "gpt-5.6-terra",
      label: "Terra",
      backend: "codex" as const,
      effortLevels: ["high", "low"],
    },
    { id: "demo/model", label: "Demo", backend: "pi" as const, effortLevels: ["low"] },
  ];

  it("lists both backends and replaces the session in place before the first turn", async () => {
    const onAgentUpdated = vi.fn();
    const { ws, host, agent, session } = makeWorkspace({
      modelOptions: () => models,
      onAgentUpdated,
    });
    expect(ws.getInfo().agents[0].canSwitchBackend).toBe(true);
    await ws.sendMessage("/model");
    expect(ws.messages.at(-1)?.content).toContain("`demo/model`");

    await ws.sendMessage("/model demo/model");
    const replacement = host.sessions.get(agent.id)!;
    expect(replacement).not.toBe(session);
    expect(session.listenerCount("event")).toBe(0);
    expect(replacement.getState().config).toMatchObject({
      cwd: "/tmp",
      model: "demo/model",
      backend: "pi",
    });
    expect(onAgentUpdated).toHaveBeenLastCalledWith(
      ws.id,
      expect.objectContaining({
        id: agent.id,
        model: "demo/model",
        name: "A",
        avatar: "a",
        color: "#888",
        isDefault: true,
        canSwitchBackend: true,
      }),
    );
    await ws.sendMessage("/model gpt-5.6-terra");
    expect(host.sessions.get(agent.id)?.getState().config.backend).toBe("codex");
  });

  it("does not let a model switch overtake the first prompt", async () => {
    const { ws, agent, session, host } = makeWorkspace({ modelOptions: () => models });
    const sending = ws.sendMessage("first prompt");
    const switching = ws.sendMessage("/model demo/model");
    await Promise.all([sending, switching]);
    expect(session.sent).toEqual(["first prompt"]);
    expect(host.sessions.get(agent.id)).toBe(session);
    expect(ws.messages.find((msg) => msg.localCommand)?.content).toContain("cannot move");
  });

  it.each([
    {
      prompt: "/model",
      reply: "**A** runs on **Terra** (`gpt-5.6-terra`).\nAvailable: **gpt-5.6-terra**",
      empty: true,
    },
    { prompt: "hello", reply: "Hi there.", empty: false },
  ])("recognizes pre-upgrade history after '$prompt'", async ({ prompt, reply, empty }) => {
    const { ws, host, agent } = makeWorkspace();
    const state = ws.getState();
    state.messages!.push(
      { id: "user", kind: "user", agentId: null, content: prompt, status: "done", timestamp: 1 },
      {
        id: "reply",
        kind: "agent",
        agentId: agent.id,
        turnId: "turn-legacy",
        content: reply,
        status: "done",
        timestamp: 2,
        events: [],
      },
    );
    const registry = new HostRegistry();
    registry.register(host);
    const restored = Workspace.fromState(state, registry, {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
      modelOptions: () => models,
    });
    expect(restored.getInfo().agents[0].canSwitchBackend).toBe(empty);
    await restored.sendMessage("/model demo/model");
    expect(host.sessions.get(agent.id)?.getState().config.backend).toBe(empty ? "pi" : "codex");
  });

  it("rebinds panel tools on a replacement managed by LocalHost", async () => {
    const host = new LocalHost("local", "Local");
    const registry = new HostRegistry();
    registry.register(host);
    const tools = { instructions: "Project instructions", tools: [] };
    const onSessionReplaced = vi.fn((_ws: Workspace, session: HostSessionHandle) => {
      session.setPanelTools?.(tools);
    });
    const ws = new Workspace("ws-p", "p", "p", "local", "/tmp", registry, {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
      modelOptions: () => models,
      onSessionReplaced,
    });
    ws.projectLink = { projectId: "proj", role: "lead" };
    const agent = ws.addAgent(
      "A",
      "gpt-5.6-terra",
      "a",
      "#888",
      {
        backend: "codex",
        effort: "low",
      },
      "account",
    );
    const original = ws.agents.get(agent.id)!.session;
    const disposed = vi.spyOn(original, "dispose");
    try {
      await ws.sendMessage("/model demo/model");
      const replacement = ws.agents.get(agent.id)!.session;
      expect(disposed).toHaveBeenCalledOnce();
      expect(original.listenerCount("event")).toBe(0);
      expect(replacement.getState().config.effort).toBe("low");
      expect(ws.agents.get(agent.id)?.info.account).toBe("account");
      expect(ws.projectLink).toEqual({ projectId: "proj", role: "lead" });
      expect(onSessionReplaced).toHaveBeenCalledWith(ws, replacement);
      const replacementDisposed = vi.spyOn(replacement, "dispose");
      await ws.dispose();
      expect(replacementDisposed).toHaveBeenCalledOnce();
    } finally {
      await host.close();
    }
  });

  it("does not leave the backend while busy, with a persisted session ID, or after a turn", async () => {
    const { ws, host, agent, session } = makeWorkspace({ modelOptions: () => models });
    const refuses = async () => {
      expect(ws.getInfo().agents[0].canSwitchBackend).toBe(false);
      await ws.sendMessage("/model demo/model");
      expect(ws.messages.at(-1)?.content).toContain("cannot move");
      expect(host.sessions.get(agent.id)).toBe(session);
    };
    session.isRunning = true;
    await refuses();
    session.isRunning = false;
    session.sessionId = "existing";
    await refuses();
    session.sessionId = null;
    await ws.sendMessage("go");
    session.emit("event", { kind: "text_delta", content: "done" });
    session.emit("event", { kind: "result", content: "" });
    session.isRunning = false;
    ws.clearContext(agent.id);
    await refuses();
  });
});

describe("Workspace persistence", () => {
  it("never writes account tokens into the state", () => {
    const { ws } = makeWorkspace();
    expect(JSON.stringify(ws.getState())).not.toContain("sk-secret");
  });

  it("background-task churn is reported as transient", () => {
    const updates: Array<boolean | undefined> = [];
    const { session } = makeWorkspace({
      onAgentUpdated: (_ws, _agent, transient) => updates.push(transient),
    });
    session.emit("backgroundTasks", []);
    expect(updates).toEqual([true]);
  });

  it("a reply cut off by a restart is marked interrupted, and orphaned queue entries go", () => {
    const registry = new HostRegistry();
    registry.register(new FakeHost());
    const agent = {
      id: "agent-1",
      name: "A",
      model: "gpt-5.6-terra",
      avatar: "a",
      color: "#888",
      isDefault: true,
      session: {
        sessionId: null,
        config: { cwd: "/tmp", backend: "codex" as const },
        usage: emptyUsage,
      },
    };
    const ws = Workspace.fromState(
      {
        id: "ws-r",
        name: "r",
        project: "p",
        hostId: "local",
        cwd: "/tmp",
        createdAt: 1,
        agents: [agent],
        messages: [
          { id: "u", kind: "user", agentId: null, content: "go", timestamp: 2, status: "done" },
          {
            id: "r",
            kind: "agent",
            agentId: "agent-1",
            content: "half",
            timestamp: 3,
            status: "streaming",
          },
          {
            id: "q1",
            kind: "user",
            agentId: null,
            content: "next",
            timestamp: 4,
            status: "queued",
            queuedFor: "agent-1",
          },
          {
            id: "q2",
            kind: "user",
            agentId: null,
            content: "lost",
            timestamp: 5,
            status: "queued",
            queuedFor: "agent-gone",
          },
        ],
      },
      registry,
    );
    const reply = ws.messages.find((m) => m.id === "r")!;
    expect(reply.status).toBe("done");
    expect(reply.content).toBe("half\n\n*\\[interrupted\\]*");
    expect(ws.messages.map((m) => m.id)).toEqual(["u", "r", "q1"]);
  });
});

describe("Workspace wake-ups", () => {
  it("sends a wake-up the backend let pass once the agent is free, after its queue", async () => {
    const { ws, session } = makeWorkspace();
    const finish = async () => {
      session.isRunning = false;
      session.emit("event", { kind: "result", content: "" });
      await tick();
    };
    await ws.sendMessage("first");
    await ws.sendMessage("queued");
    session.pendingWake = { prompt: "Check the runs.", reason: "runs" };
    session.due = true;
    session.emit("wakeDue");
    await tick();
    expect(session.sent).toEqual(["first"]);
    await finish();
    expect(session.sent).toEqual(["first", "queued"]);
    await finish();
    expect(session.sent).toEqual(["first", "queued", "Check the runs."]);
    const reply = ws.messages.at(-1)!;
    expect(reply.kind).toBe("agent");
    expect(reply.events?.[0]).toMatchObject({ kind: "notice", level: "wakeup" });
    expect(ws.messages.filter((m) => m.kind === "user").map((m) => m.content)).toEqual([
      "first",
      "queued",
    ]);
  });

  it("holds a due wake-up while the queue is paused, and sends it once the pause ends", async () => {
    const { ws, agent, session } = makeWorkspace();
    ws.pauseAgent(agent.id, Date.now() + 60_000);
    session.pendingWake = { prompt: "Check the runs.", reason: "runs" };
    session.due = true;
    session.emit("wakeDue");
    await tick();
    expect(session.sent).toEqual([]);
    ws.endPause(agent.id);
    await tick();
    expect(session.sent).toEqual(["Check the runs."]);
  });

  it("a pending rate-limit retry goes before a due wake-up", async () => {
    const { ws, agent, session } = makeWorkspace();
    await ws.sendMessage("first");
    session.isRunning = false;
    session.emit("event", { kind: "error", content: "Usage limit reached (session)." });
    await tick();
    ws.pauseAgent(agent.id, Date.now() - 1, true);
    session.pendingWake = { prompt: "Check the runs.", reason: "runs" };
    session.due = true;
    session.emit("wakeDue");
    await tick();
    expect(session.sent).toEqual(["first"]);
    expect(ws.retryLast(agent.id)).toBe(true);
    expect(session.sent).toEqual(["first", "first"]);
    session.isRunning = false;
    session.emit("event", { kind: "result", content: "" });
    await tick();
    expect(session.sent).toEqual(["first", "first", "Check the runs."]);
  });
});
