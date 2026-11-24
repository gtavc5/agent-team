import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelHttpServer, type PanelReadyReport } from "../../src/session/panel-http";
import { PiSession, type PiSessionOptions } from "../../src/session/pi";
import { PiRpcClient, type PiRpcSpawnOptions } from "../../src/session/pi-rpc";
import {
  consumedJsonlOffset,
  createIncrementalJsonlCursor,
  createSubagentProjectionState,
  isSafeChildRunId,
  projectAsyncEventRecord,
  projectSessionV3Record,
  projectTranscriptArtifactRecord,
  readIncrementalJsonlRecords,
  resolveWorkflowStepIndex,
} from "../../src/session/pi-subagents";
import { HostRegistry } from "../../src/session/host";
import type { SessionConfig, StreamEvent } from "../../src/session/types";
import { Workspace } from "../../src/workspace/workspace";
import { piReply } from "../snap/pi-wire";

type Frame = { id: string; type: string; [key: string]: unknown };
const dirs: string[] = [];
const cleanup: Array<() => Promise<void> | void> = [];

function tempDir(prefix = "pi-subagents-live-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function createSessionHarness(
  dir: string,
  opts?: { piSubagentsTempRoot?: string; options?: Partial<PiSessionOptions> },
) {
  const agentDir = path.join(dir, "home");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  const sessionDir = path.join(dir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const env = opts?.piSubagentsTempRoot
    ? { ...process.env, PI_SUBAGENTS_TEMP_ROOT: opts.piSubagentsTempRoot }
    : undefined;
  const cfg: SessionConfig = {
    cwd: dir,
    backend: "pi",
    uploadsDir: dir,
    piAgentDir: agentDir,
    piSessionDir: sessionDir,
    workspaceId: "ws-live",
    agentId: "agent-live",
  };
  const panel = new PanelHttpServer();
  cleanup.push(() => panel.close());
  let emitter!: (frame: object) => void;

  const factory = (spawnOpts: PiRpcSpawnOptions) => {
    const sessionFile = spawnOpts.args?.includes("--session")
      ? spawnOpts.args[spawnOpts.args.indexOf("--session") + 1]
      : path.join(sessionDir, "session.jsonl");
    const sessionId = spawnOpts.args?.includes("--session-id")
      ? spawnOpts.args[spawnOpts.args.indexOf("--session-id") + 1]
      : "sess-live-1";
    const ready: PanelReadyReport = {
      sessionProof: {
        sessionId: sessionId ?? null,
        sessionFile: sessionFile ?? null,
        cwd: fs.realpathSync.native(dir),
        headerCwd: dir,
        entryCount: 0,
        leafId: null,
        anchorOnActiveBranch: true,
        anchorExistsInFile: true,
      },
      ownerToolNames: ["write_note"],
      requiredExtensionsRegistered: true,
      subagentsRpcReady: true,
      subagentsSessionId: sessionId ?? null,
    };
    const headers = {
      authorization: `Bearer ${spawnOpts.env?.YAAT_PANEL_TOKEN ?? ""}`,
      "content-type": "application/json",
    };
    const endpoint = `${spawnOpts.env?.YAAT_PANEL_URL ?? ""}/v1/sessions/${spawnOpts.env?.YAAT_PANEL_KEY ?? ""}`;
    void fetch(`${endpoint}/toolset`, { headers })
      .then((res) => res.text())
      .then(() =>
        fetch(`${endpoint}/ready`, { method: "POST", headers, body: JSON.stringify(ready) }),
      );

    const stdout = new PassThrough();
    const emit = (frame: object) => stdout.write(JSON.stringify(frame) + "\n");
    emitter = emit;
    const respond = (frame: Frame, data?: unknown) =>
      emit({
        ...piReply(frame.type),
        command: frame.type,
        id: frame.id,
        success: true,
        data,
      });

    const stdin = new Writable({
      write(chunk: Buffer, _, cb) {
        const frame = JSON.parse(chunk.toString()) as Frame;
        switch (frame.type) {
          case "get_state":
            respond(frame, {
              sessionId,
              sessionFile,
              thinkingLevel: "low",
              isStreaming: false,
              isCompacting: false,
              pendingMessageCount: 0,
              model: { provider: "mock", id: "test" },
            });
            break;
          case "get_available_models":
            respond(frame, { models: [{ provider: "mock", id: "test", contextWindow: 100_000 }] });
            break;
          case "get_available_thinking_levels":
            respond(frame, { levels: ["low", "high"] });
            break;
          case "get_commands":
            respond(frame, { commands: [] });
            break;
          case "prompt":
            respond(frame, { disposition: "started" });
            break;
          case "get_session_stats":
            respond(frame, {
              tokens: { input: 10, output: 5 },
              cost: 0,
              contextUsage: { tokens: 15, contextWindow: 100_000 },
            });
            break;
          default:
            respond(frame);
            break;
        }
        cb();
      },
    });
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
    });
    stdin.on("finish", () => stdout.end());
    return new PiRpcClient({ stdin, stdout, child: child as never }, { requestTimeoutMs: 5_000 });
  };

  const session = new PiSession(cfg, {
    panelHttp: panel,
    rpcFactory: factory,
    env,
    livePollIntervalMs: 20,
    ...opts?.options,
  });
  cleanup.push(() => session.dispose(500));
  return {
    cfg,
    panel,
    session,
    get emitter() {
      return emitter;
    },
  };
}

describe("incremental JSONL cursor reader", () => {
  it("handles ENOENT, partial lines, multi-byte UTF-8, malformed lines, and truncation", () => {
    const dir = tempDir();
    const file = path.join(dir, "events.jsonl");
    const cursor = createIncrementalJsonlCursor(file);

    expect(readIncrementalJsonlRecords(cursor)).toEqual([]);
    expect(consumedJsonlOffset(cursor)).toBe(0);

    // Partial line including multi-byte UTF-8 character split before newline
    const line1 = JSON.stringify({ type: "text", content: "你好世界" }) + "\n";
    const line2 = JSON.stringify({ type: "tool_execution_start", toolName: "bash" });
    const partialBytes = Buffer.from(line1 + line2, "utf8");
    const splitPoint = Buffer.from('{"type":"text","content":"你', "utf8").length;

    fs.writeFileSync(file, partialBytes.subarray(0, splitPoint));
    expect(readIncrementalJsonlRecords(cursor)).toEqual([]);
    expect(consumedJsonlOffset(cursor)).toBe(0);

    fs.appendFileSync(file, partialBytes.subarray(splitPoint));
    expect(readIncrementalJsonlRecords(cursor)).toEqual([{ type: "text", content: "你好世界" }]);
    expect(consumedJsonlOffset(cursor)).toBe(Buffer.byteLength(line1, "utf8"));

    // Complete line2 + blank line + malformed complete line + line3
    const tail =
      "\nnot-valid-json\n" +
      JSON.stringify({ type: "tool_execution_end", toolCallId: "t1" }) +
      "\n";
    fs.appendFileSync(file, tail);
    expect(readIncrementalJsonlRecords(cursor)).toEqual([
      { type: "tool_execution_start", toolName: "bash" },
      { type: "tool_execution_end", toolCallId: "t1" },
    ]);

    // File truncation / replacement shrinks file size -> cursor resets cleanly
    const replacement = JSON.stringify({ type: "reset_line" }) + "\n";
    fs.writeFileSync(file, replacement);
    expect(readIncrementalJsonlRecords(cursor)).toEqual([{ type: "reset_line" }]);
    expect(consumedJsonlOffset(cursor)).toBe(Buffer.byteLength(replacement, "utf8"));
  });
});

describe("incremental subagent record projection & dedup", () => {
  it("deduplicates async events across tool_execution_* and message_end and ignores noisy frames", () => {
    const state = createSubagentProjectionState();
    const bridge = new Set<string>(["read_note"]);

    expect(projectAsyncEventRecord({ type: "message_start" }, state, bridge).events).toEqual([]);
    expect(projectAsyncEventRecord({ type: "turn_end" }, state, bridge).events).toEqual([]);
    expect(projectAsyncEventRecord({ type: "agent_end" }, state, bridge).events).toEqual([]);
    expect(
      projectAsyncEventRecord({ type: "subagent.child-status", childId: "task-1" }, state, bridge)
        .events,
    ).toEqual([]);

    const startBatch = projectAsyncEventRecord(
      {
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "read",
        args: { path: "README.md" },
      },
      state,
      bridge,
    );
    expect(startBatch.events).toHaveLength(1);
    expect(startBatch.events[0]).toMatchObject({ kind: "tool_use", toolUseId: "tc-1" });

    // Assistant message_end carrying the same toolCall plus thinking & text must NOT duplicate tc-1
    const msgEndBatch = projectAsyncEventRecord(
      {
        type: "message_end",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4",
          content: [
            { type: "thinking", thinking: "checking" },
            { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "README.md" } },
            { type: "toolCall", id: "tc-2", name: "read_note", arguments: { slug: "plan" } },
            { type: "text", text: "summary" },
          ],
        },
      },
      state,
      bridge,
    );
    expect(msgEndBatch.executionChanged).toBe(true);
    expect(state.execution.model).toBe("anthropic/claude-sonnet-4");
    expect(msgEndBatch.events.map((e) => [e.kind, e.toolUseId])).toEqual([
      ["thinking", undefined],
      ["tool_use", "tc-2"],
      ["text", undefined],
    ]);

    // Subsequent tool_execution_start for tc-2 is ignored because message_end already emitted it
    expect(
      projectAsyncEventRecord(
        { type: "tool_execution_start", toolCallId: "tc-2", toolName: "read_note", args: {} },
        state,
        bridge,
      ).events,
    ).toEqual([]);

    // tool_execution_end emits tool_result once; subsequent message_end(toolResult) for same tc-1 is deduped
    const endBatch = projectAsyncEventRecord(
      {
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "ok" }] },
        durationMs: 12,
      },
      state,
      bridge,
    );
    expect(endBatch.events).toEqual([
      expect.objectContaining({
        kind: "tool_result",
        toolUseId: "tc-1",
        content: "ok",
        durationMs: 12,
      }),
    ]);
    expect(
      projectAsyncEventRecord(
        {
          type: "message_end",
          message: {
            role: "toolResult",
            toolCallId: "tc-1",
            content: [{ type: "text", text: "ok" }],
          },
        },
        state,
        bridge,
      ).events,
    ).toEqual([]);
  });

  it("projects transcript artifacts and session v3 entries without duplicating tool calls", () => {
    const tState = createSubagentProjectionState();
    expect(
      projectTranscriptArtifactRecord(
        { recordType: "tool_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
        tState,
      ).events,
    ).toEqual([expect.objectContaining({ kind: "tool_use", toolUseId: "t1", toolName: "bash" })]);

    const tMsg = projectTranscriptArtifactRecord(
      {
        recordType: "message",
        role: "assistant",
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
            { type: "text", text: "done" },
          ],
        },
      },
      tState,
    );
    expect(tMsg.executionChanged).toBe(true);
    expect(tMsg.events).toEqual([{ kind: "text", content: "done" }]);

    const sState = createSubagentProjectionState();
    expect(
      projectSessionV3Record(
        { type: "model_change", provider: "anthropic", modelId: "claude-opus-4" },
        sState,
      ).executionChanged,
    ).toBe(true);
    expect(
      projectSessionV3Record({ type: "thinking_level_change", thinkingLevel: "high" }, sState)
        .executionChanged,
    ).toBe(true);
    expect(sState.execution).toEqual({ model: "anthropic/claude-opus-4", effort: "high" });
  });

  it("parses workflow keys and validates childRunId segments", () => {
    expect(resolveWorkflowStepIndex({ stepIndex: 1 }, 3)).toBe(1);
    expect(resolveWorkflowStepIndex({ childId: "task-2" }, 3)).toBe(1);
    expect(resolveWorkflowStepIndex({ workflowKey: "step-1" }, 3)).toBe(0);
    expect(resolveWorkflowStepIndex({ childId: "task-9" }, 2)).toBeUndefined();
    expect(isSafeChildRunId("run-123")).toBe(true);
    expect(isSafeChildRunId("../escape")).toBe(false);
    expect(isSafeChildRunId("a/b")).toBe(false);
  });
});

describe("PiSession live subagent streaming", () => {
  it("streams foreground single subagent transcriptPath events before tool_execution_end", async () => {
    const dir = tempDir();
    const h = createSessionHarness(dir);
    const events: StreamEvent[] = [];
    h.session.on("event", (e: StreamEvent) => events.push(e));

    const sendPromise = h.session.send("run foreground");
    await vi.waitFor(() => expect(h.emitter).toBeDefined());
    h.emitter({ type: "agent_start" });
    h.emitter({ type: "turn_start" });

    const transcriptPath = path.join(dir, "child_transcript.jsonl");
    h.emitter({
      type: "tool_execution_start",
      toolCallId: "fg-call-1",
      toolName: "subagent",
      args: { agent: "scout", task: "inspect code", async: false },
    });

    h.emitter({
      type: "tool_execution_update",
      toolCallId: "fg-call-1",
      toolName: "subagent",
      partialResult: {
        content: [],
        details: {
          mode: "single",
          progress: [{ index: 0, currentTool: "Bash", model: "openai/gpt-5.4" }],
          results: [{ index: 0, transcriptPath }],
        },
      },
    });

    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        recordType: "tool_start",
        toolCallId: "child-bash-1",
        toolName: "bash",
        args: { command: "pwd" },
      }) + "\n",
    );

    await vi.waitFor(() =>
      expect(
        events.some(
          (e) =>
            e.kind === "subagent_progress" &&
            e.subagent?.taskId === "fg-call-1:0" &&
            e.subagent._innerEvent?.kind === "tool_use" &&
            e.subagent._innerEvent.toolUseId === "child-bash-1",
        ),
      ).toBe(true),
    );

    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({
        recordType: "message",
        role: "toolResult",
        message: {
          role: "toolResult",
          toolCallId: "child-bash-1",
          content: [{ type: "text", text: "/repo" }],
        },
      }) +
        "\n" +
        JSON.stringify({
          recordType: "message",
          role: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "live-fg-marker" }] },
        }) +
        "\n",
    );

    await vi.waitFor(() =>
      expect(
        events.some(
          (e) =>
            e.kind === "subagent_progress" &&
            e.subagent?._innerEvent?.kind === "text" &&
            e.subagent._innerEvent.content === "live-fg-marker",
        ),
      ).toBe(true),
    );
    // Must not have emitted subagent_done yet
    expect(events.some((e) => e.kind === "subagent_done")).toBe(false);

    h.emitter({
      type: "tool_execution_end",
      toolCallId: "fg-call-1",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "single",
          results: [{ index: 0, status: "completed", transcriptPath, summary: "done" }],
        },
      },
      isError: false,
    });
    h.emitter({ type: "agent_end" });
    await sendPromise;

    const done = events.find((e) => e.kind === "subagent_done");
    expect(done?.subagent?.status).toBe("completed");
    expect(done?.subagent?.events?.some((e) => e.content === "live-fg-marker")).toBe(true);

    // Writes after completion/close must not trigger new progress events
    const countAfterDone = events.length;
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({
        recordType: "message",
        role: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "after-done" }] },
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(events).toHaveLength(countAfterDone);
  });

  it("streams foreground workflowChildren via async events.jsonl and supports dynamic child expansion", async () => {
    const dir = tempDir();
    const tempRoot = path.join(dir, "sub-temp");
    const runsRoot = path.join(tempRoot, "async-subagent-runs");
    fs.mkdirSync(runsRoot, { recursive: true });
    const h = createSessionHarness(dir, { piSubagentsTempRoot: tempRoot });
    const events: StreamEvent[] = [];
    h.session.on("event", (e: StreamEvent) => events.push(e));

    const sendPromise = h.session.send("run tasks");
    await vi.waitFor(() => expect(h.emitter).toBeDefined());
    h.emitter({ type: "agent_start" });
    h.emitter({ type: "turn_start" });
    h.emitter({
      type: "tool_execution_start",
      toolCallId: "wf-call-1",
      toolName: "subagent",
      args: { workflow: "review-and-fix", async: false },
    });

    const child1Dir = path.join(runsRoot, "child-run-1");
    const child2Dir = path.join(runsRoot, "child-run-2");
    fs.mkdirSync(child1Dir, { recursive: true });
    fs.mkdirSync(child2Dir, { recursive: true });

    h.emitter({
      type: "tool_execution_update",
      toolCallId: "wf-call-1",
      toolName: "subagent",
      partialResult: {
        content: [],
        details: {
          mode: "workflow",
          workflowChildren: {
            children: [
              {
                childId: "task-1",
                state: "running",
                runId: "child-run-1",
                agent: "worker-a",
                activity: { currentTool: "Read" },
              },
              {
                childId: "task-2",
                state: "running",
                runId: "child-run-2",
                agent: "worker-b",
              },
            ],
          },
        },
      },
    });

    fs.writeFileSync(
      path.join(child1Dir, "events.jsonl"),
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "c1-read",
        toolName: "read",
        args: { path: "a.ts" },
      }) + "\n",
    );
    fs.writeFileSync(
      path.join(child2Dir, "events.jsonl"),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "child-2-step" }] },
      }) + "\n",
    );

    await vi.waitFor(() => {
      expect(
        events.some(
          (e) =>
            e.kind === "subagent_progress" &&
            e.subagent?.taskId === "wf-call-1:0" &&
            e.subagent._innerEvent?.kind === "tool_use",
        ),
      ).toBe(true);
      expect(
        events.some(
          (e) =>
            e.kind === "subagent_progress" &&
            e.subagent?.taskId === "wf-call-1:1" &&
            e.subagent._innerEvent?.content === "child-2-step",
        ),
      ).toBe(true);
    });

    h.emitter({
      type: "tool_execution_end",
      toolCallId: "wf-call-1",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "wf ok" }],
        details: {
          mode: "workflow",
          results: [
            { index: 0, status: "completed", summary: "ok-1" },
            { index: 1, status: "completed", summary: "ok-2" },
          ],
        },
      },
      isError: false,
    });
    h.emitter({ type: "agent_end" });
    await sendPromise;
    expect(events.filter((e) => e.kind === "subagent_done")).toHaveLength(2);
  });

  it("streams detached async parallel and workflow events and resumes from tailCursors without duplicates", async () => {
    const dir = tempDir();
    const runsRoot = path.join(dir, "async-subagent-runs");
    const parallelDir = path.join(runsRoot, "run-parallel");
    const wfDir = path.join(runsRoot, "run-wf");
    const wfChildDir = path.join(runsRoot, "wf-child-1");
    fs.mkdirSync(parallelDir, { recursive: true });
    fs.mkdirSync(wfDir, { recursive: true });
    fs.mkdirSync(wfChildDir, { recursive: true });

    const h = createSessionHarness(dir);
    const events: StreamEvent[] = [];
    h.session.on("event", (e: StreamEvent) => events.push(e));

    const sendPromise = h.session.send("launch async");
    await vi.waitFor(() => expect(h.emitter).toBeDefined());
    h.emitter({ type: "agent_start" });
    h.emitter({ type: "turn_start" });

    // Launch parallel async run
    h.emitter({
      type: "tool_execution_start",
      toolCallId: "async-par",
      toolName: "subagent",
      args: {
        async: true,
        tasks: [
          { agent: "a", task: "one" },
          { agent: "b", task: "two" },
        ],
      },
    });
    h.emitter({
      type: "tool_execution_end",
      toolCallId: "async-par",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "launched" }],
        details: { mode: "parallel", asyncDir: parallelDir, asyncId: "run-parallel" },
      },
      isError: false,
    });

    // Launch workflow async run
    h.emitter({
      type: "tool_execution_start",
      toolCallId: "async-wf",
      toolName: "subagent",
      args: { async: true, workflow: "pipeline" },
    });
    h.emitter({
      type: "tool_execution_end",
      toolCallId: "async-wf",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "wf launched" }],
        details: { mode: "workflow", asyncDir: wfDir, asyncId: "run-wf" },
      },
      isError: false,
    });
    h.emitter({ type: "agent_end" });
    await sendPromise;

    // Emit pre-restart records into both parallel parent events.jsonl and workflow child events.jsonl
    fs.writeFileSync(
      path.join(parallelDir, "events.jsonl"),
      JSON.stringify({
        type: "tool_execution_start",
        subagentStepIndex: 0,
        toolCallId: "par0-t1",
        toolName: "bash",
        args: { command: "echo 0" },
      }) +
        "\n" +
        JSON.stringify({
          type: "tool_execution_start",
          subagentStepIndex: 1,
          toolCallId: "par1-t1",
          toolName: "read",
          args: { path: "x.ts" },
        }) +
        "\n",
    );

    fs.writeFileSync(
      path.join(wfDir, "events.jsonl"),
      JSON.stringify({
        type: "subagent.child-status",
        childId: "task-1",
        stepIndex: 0,
        childRunId: "wf-child-1",
      }) + "\n",
    );
    fs.writeFileSync(
      path.join(wfChildDir, "events.jsonl"),
      JSON.stringify({
        type: "message_end",
        subagentStepIndex: 0,
        message: { role: "assistant", content: [{ type: "text", text: "wf-before-restart" }] },
      }) + "\n",
    );

    await vi.waitFor(() => {
      expect(
        events.some(
          (e) =>
            e.kind === "subagent_progress" &&
            e.subagent?.taskId === "async-par:0" &&
            e.subagent._innerEvent?.toolUseId === "par0-t1",
        ),
      ).toBe(true);
      expect(
        events.some(
          (e) =>
            e.kind === "subagent_progress" &&
            e.subagent?.taskId === "async-par:1" &&
            e.subagent._innerEvent?.toolUseId === "par1-t1",
        ),
      ).toBe(true);
      expect(
        events.some(
          (e) =>
            e.kind === "subagent_progress" &&
            e.subagent?.taskId === "async-wf:0" &&
            e.subagent._innerEvent?.content === "wf-before-restart",
        ),
      ).toBe(true);
    });

    const savedState = h.session.getState();
    expect(
      savedState.activeAsyncRuns?.find((r) => r.runId === "run-parallel")?.tailCursors?.parent,
    ).toBeGreaterThan(0);
    expect(
      savedState.activeAsyncRuns?.find((r) => r.runId === "run-wf")?.tailCursors?.[
        "child:wf-child-1"
      ],
    ).toBeGreaterThan(0);

    await h.session.dispose(500);

    // Restore session and append new lines: pre-restart lines must NOT replay
    const restored = PiSession.fromState(savedState, {
      panelHttp: h.panel,
      livePollIntervalMs: 20,
    });
    cleanup.push(() => restored.dispose(500));
    const resumedEvents: StreamEvent[] = [];
    restored.on("event", (e: StreamEvent) => resumedEvents.push(e));

    fs.appendFileSync(
      path.join(parallelDir, "events.jsonl"),
      JSON.stringify({
        type: "message_end",
        subagentStepIndex: 0,
        message: { role: "assistant", content: [{ type: "text", text: "par-after-restart" }] },
      }) + "\n",
    );
    fs.appendFileSync(
      path.join(wfChildDir, "events.jsonl"),
      JSON.stringify({
        type: "message_end",
        subagentStepIndex: 0,
        message: { role: "assistant", content: [{ type: "text", text: "wf-after-restart" }] },
      }) + "\n",
    );

    await vi.waitFor(() => {
      expect(
        resumedEvents.some(
          (e) =>
            e.subagent?.taskId === "async-par:0" &&
            e.subagent._innerEvent?.content === "par-after-restart",
        ),
      ).toBe(true);
      expect(
        resumedEvents.some(
          (e) =>
            e.subagent?.taskId === "async-wf:0" &&
            e.subagent._innerEvent?.content === "wf-after-restart",
        ),
      ).toBe(true);
    });

    // Ensure pre-restart events were not replayed
    expect(resumedEvents.some((e) => e.subagent?._innerEvent?.toolUseId === "par0-t1")).toBe(false);
    expect(
      resumedEvents.some((e) => e.subagent?._innerEvent?.content === "wf-before-restart"),
    ).toBe(false);

    // Dispose stops watches; subsequent appends do not emit
    await restored.dispose(500);
    const countAfterDispose = resumedEvents.length;
    fs.appendFileSync(
      path.join(parallelDir, "events.jsonl"),
      JSON.stringify({
        type: "message_end",
        subagentStepIndex: 0,
        message: { role: "assistant", content: [{ type: "text", text: "after-dispose" }] },
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(resumedEvents).toHaveLength(countAfterDispose);
  });

  it("does not misbind partial out-of-order parallel progress or results across children", async () => {
    const dir = tempDir();
    const h = createSessionHarness(dir);
    const events: StreamEvent[] = [];
    h.session.on("event", (e: StreamEvent) => events.push(e));

    const sendPromise = h.session.send("run parallel");
    await vi.waitFor(() => expect(h.emitter).toBeDefined());
    h.emitter({ type: "agent_start" });
    h.emitter({ type: "turn_start" });

    const pathA = path.join(dir, "child-a.jsonl");
    const pathB = path.join(dir, "child-b.jsonl");
    fs.writeFileSync(
      pathB,
      JSON.stringify({
        recordType: "message",
        role: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "marker-b" }] },
      }) + "\n",
    );

    h.emitter({
      type: "tool_execution_start",
      toolCallId: "par-call",
      toolName: "subagent",
      args: {
        async: false,
        tasks: [
          { agent: "a", task: "one" },
          { agent: "b", task: "two" },
        ],
      },
    });

    // Partial update containing only index 1 at array position 0
    h.emitter({
      type: "tool_execution_update",
      toolCallId: "par-call",
      toolName: "subagent",
      partialResult: {
        content: [],
        details: {
          mode: "parallel",
          progress: [{ index: 1, currentTool: "Read", model: "openai/gpt-5.4" }],
          results: [{ index: 1, transcriptPath: pathB }],
        },
      },
    });

    await vi.waitFor(() =>
      expect(
        events.some(
          (e) =>
            e.kind === "subagent_progress" &&
            e.subagent?.taskId === "par-call:1" &&
            e.subagent._innerEvent?.content === "marker-b",
        ),
      ).toBe(true),
    );
    expect(
      events.some((e) => e.kind === "subagent_progress" && e.subagent?.taskId === "par-call:0"),
    ).toBe(false);

    fs.writeFileSync(
      pathA,
      JSON.stringify({
        recordType: "message",
        role: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "marker-a" }] },
      }) + "\n",
    );
    h.emitter({
      type: "tool_execution_update",
      toolCallId: "par-call",
      toolName: "subagent",
      partialResult: {
        content: [],
        details: {
          mode: "parallel",
          progress: [
            { index: 0, currentTool: "Bash", model: "anthropic/claude-sonnet-4" },
            { index: 1, currentTool: "Read", model: "openai/gpt-5.4" },
          ],
          results: [
            { index: 0, transcriptPath: pathA },
            { index: 1, transcriptPath: pathB },
          ],
        },
      },
    });

    await vi.waitFor(() =>
      expect(
        events.some(
          (e) =>
            e.kind === "subagent_progress" &&
            e.subagent?.taskId === "par-call:0" &&
            e.subagent._innerEvent?.content === "marker-a",
        ),
      ).toBe(true),
    );

    h.emitter({
      type: "tool_execution_end",
      toolCallId: "par-call",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "ok" }],
        details: {
          mode: "parallel",
          results: [
            { index: 0, status: "completed", transcriptPath: pathA },
            { index: 1, status: "completed", transcriptPath: pathB },
          ],
        },
      },
      isError: false,
    });
    h.emitter({ type: "agent_end" });
    await sendPromise;
  });

  it("emits start and done for dynamic workflow children discovered already terminal", async () => {
    const dir = tempDir();
    const runsRoot = path.join(dir, "async-subagent-runs");
    const wfDir = path.join(runsRoot, "run-dyn-term");
    fs.mkdirSync(wfDir, { recursive: true });

    const h = createSessionHarness(dir);
    const events: StreamEvent[] = [];
    h.session.on("event", (e: StreamEvent) => events.push(e));

    const sendPromise = h.session.send("launch wf");
    await vi.waitFor(() => expect(h.emitter).toBeDefined());
    h.emitter({ type: "agent_start" });
    h.emitter({ type: "turn_start" });
    h.emitter({
      type: "tool_execution_start",
      toolCallId: "wf-term",
      toolName: "subagent",
      args: { async: true, workflow: "pipeline" },
    });
    h.emitter({
      type: "tool_execution_end",
      toolCallId: "wf-term",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "wf launched" }],
        details: { mode: "workflow", asyncDir: wfDir, asyncId: "run-dyn-term" },
      },
      isError: false,
    });
    h.emitter({ type: "agent_end" });
    await sendPromise;

    fs.writeFileSync(
      path.join(wfDir, "status.json"),
      JSON.stringify({
        runId: "run-dyn-term",
        sessionId: h.session.getState().sessionId,
        mode: "workflow",
        state: "running",
        steps: [
          { childId: "task-1", agent: "planner", status: "running" },
          {
            childId: "task-2",
            agent: "finisher",
            status: "completed",
            summary: "already done",
          },
        ],
      }),
    );

    await vi.waitFor(() =>
      expect(
        events.some((e) => e.kind === "subagent_start" && e.subagent?.taskId === "wf-term:1"),
      ).toBe(true),
    );

    await h.session.reconcileAsyncRuns();
    const done = events.find(
      (e) => e.kind === "subagent_done" && e.subagent?.taskId === "wf-term:1",
    );
    expect(done?.subagent).toMatchObject({
      taskId: "wf-term:1",
      status: "completed",
      summary: "already done",
    });
  });

  it("handles out-of-order subagent.child-status without hijacking step:0", async () => {
    const dir = tempDir();
    const runsRoot = path.join(dir, "async-subagent-runs");
    const wfDir = path.join(runsRoot, "run-oof");
    const c1Dir = path.join(runsRoot, "oof-c1");
    const c2Dir = path.join(runsRoot, "oof-c2");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.mkdirSync(c1Dir, { recursive: true });
    fs.mkdirSync(c2Dir, { recursive: true });

    const h = createSessionHarness(dir);
    const events: StreamEvent[] = [];
    h.session.on("event", (e: StreamEvent) => events.push(e));

    const sendPromise = h.session.send("launch oof");
    await vi.waitFor(() => expect(h.emitter).toBeDefined());
    h.emitter({ type: "agent_start" });
    h.emitter({ type: "turn_start" });
    h.emitter({
      type: "tool_execution_start",
      toolCallId: "wf-oof",
      toolName: "subagent",
      args: { async: true, workflow: "pipeline" },
    });
    h.emitter({
      type: "tool_execution_end",
      toolCallId: "wf-oof",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "launched" }],
        details: { mode: "workflow", asyncDir: wfDir, asyncId: "run-oof" },
      },
      isError: false,
    });
    h.emitter({ type: "agent_end" });
    await sendPromise;

    fs.writeFileSync(
      path.join(c2Dir, "events.jsonl"),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "from-step-2" }] },
      }) + "\n",
    );
    fs.writeFileSync(
      path.join(wfDir, "events.jsonl"),
      JSON.stringify({
        type: "subagent.child-status",
        childId: "task-2",
        stepIndex: 1,
        childRunId: "oof-c2",
      }) + "\n",
    );

    await vi.waitFor(() =>
      expect(
        events.some(
          (e) =>
            e.kind === "subagent_progress" &&
            e.subagent?.taskId === "wf-oof:1" &&
            e.subagent._innerEvent?.content === "from-step-2",
        ),
      ).toBe(true),
    );

    fs.writeFileSync(
      path.join(c1Dir, "events.jsonl"),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "from-step-1" }] },
      }) + "\n",
    );
    fs.appendFileSync(
      path.join(wfDir, "events.jsonl"),
      JSON.stringify({
        type: "subagent.child-status",
        childId: "task-1",
        stepIndex: 0,
        childRunId: "oof-c1",
      }) + "\n",
    );

    await vi.waitFor(() =>
      expect(
        events.some(
          (e) =>
            e.kind === "subagent_progress" &&
            e.subagent?.taskId === "wf-oof:0" &&
            e.subagent._innerEvent?.content === "from-step-1",
        ),
      ).toBe(true),
    );
  });

  it("emits async execution metadata once across poll, reconcile, and restore", async () => {
    const dir = tempDir();
    const runsRoot = path.join(dir, "async-subagent-runs");
    const parDir = path.join(runsRoot, "run-meta-once");
    fs.mkdirSync(parDir, { recursive: true });

    const h = createSessionHarness(dir);
    const events: StreamEvent[] = [];
    h.session.on("event", (e: StreamEvent) => events.push(e));

    const sendPromise = h.session.send("launch meta");
    await vi.waitFor(() => expect(h.emitter).toBeDefined());
    h.emitter({ type: "agent_start" });
    h.emitter({ type: "turn_start" });
    h.emitter({
      type: "tool_execution_start",
      toolCallId: "meta-1",
      toolName: "subagent",
      args: { async: true, tasks: [{ agent: "a", task: "one" }] },
    });
    h.emitter({
      type: "tool_execution_end",
      toolCallId: "meta-1",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "launched" }],
        details: { mode: "parallel", asyncDir: parDir, asyncId: "run-meta-once" },
      },
      isError: false,
    });
    h.emitter({ type: "agent_end" });
    await sendPromise;

    fs.writeFileSync(
      path.join(parDir, "status.json"),
      JSON.stringify({
        runId: "run-meta-once",
        sessionId: h.session.getState().sessionId,
        mode: "parallel",
        state: "running",
        steps: [
          {
            childId: "task-1",
            status: "running",
            resolvedModel: { provider: "openai", model: "gpt-5.4" },
            thinking: "high",
          },
        ],
      }),
    );

    await vi.waitFor(() =>
      expect(
        events.some(
          (e) =>
            e.kind === "subagent_progress" &&
            e.subagent?.taskId === "meta-1:0" &&
            e.subagent.model === "openai/gpt-5.4",
        ),
      ).toBe(true),
    );

    await h.session.reconcileAsyncRuns();
    const modelProgress = events.filter(
      (e) =>
        e.kind === "subagent_progress" &&
        e.subagent?.taskId === "meta-1:0" &&
        e.subagent.model === "openai/gpt-5.4",
    );
    expect(modelProgress).toHaveLength(1);

    const saved = h.session.getState();
    expect(saved.activeAsyncRuns?.[0]?.children[0]?.execution).toEqual({
      model: "openai/gpt-5.4",
      effort: "high",
    });

    await h.session.dispose(500);
    const restored = PiSession.fromState(saved, { panelHttp: h.panel, livePollIntervalMs: 20 });
    cleanup.push(() => restored.dispose(500));
    const resumedEvents: StreamEvent[] = [];
    restored.on("event", (e: StreamEvent) => resumedEvents.push(e));
    await restored.reconcileAsyncRuns();
    expect(resumedEvents.filter((e) => e.kind === "subagent_progress")).toHaveLength(0);
  });
});

describe("Workspace persistence of Pi subagent live inner events", () => {
  it("persists Pi _innerEvent, skips duplicate tool_use WS broadcasts, and preserves live events on abort", async () => {
    const dir = tempDir();
    const h = createSessionHarness(dir);
    const registry = new HostRegistry();
    registry.register({
      id: "local",
      label: "Local",
      type: "local",
      connected: true,
      getInfo: () => ({ id: "local", label: "Local", type: "local", connected: true }),
      createSession: () => h.session,
      destroySession: () => Promise.resolve(),
      restoreSession: () => h.session,
    });
    const streamedEvents: StreamEvent[] = [];
    const ws = new Workspace("ws-pi-live", "Pi Live", "test", "local", dir, registry, {
      onNewMessage: () => undefined,
      onStreamEvent: (_wsId, _msgId, ev) => streamedEvents.push(ev),
      onMessageDone: () => undefined,
    });
    ws.addAgent("Pi", "mock/test", "", "#000", { backend: "pi", cwd: dir });

    await ws.sendMessage("start subagent");
    await vi.waitFor(() => expect(h.emitter).toBeDefined());
    h.emitter({ type: "agent_start" });
    h.emitter({ type: "turn_start" });

    const transcriptPath = path.join(dir, "live-abort.jsonl");
    h.emitter({
      type: "tool_execution_start",
      toolCallId: "sa-call",
      toolName: "subagent",
      args: { agent: "scout", task: "inspect", async: false },
    });
    h.emitter({
      type: "tool_execution_update",
      toolCallId: "sa-call",
      toolName: "subagent",
      partialResult: {
        content: [],
        details: { mode: "single", results: [{ index: 0, transcriptPath }] },
      },
    });

    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        recordType: "tool_start",
        toolCallId: "tu-1",
        toolName: "bash",
        args: { command: "pwd" },
      }) +
        "\n" +
        JSON.stringify({
          recordType: "message",
          role: "toolResult",
          message: {
            role: "toolResult",
            toolCallId: "tu-1",
            content: [{ type: "text", text: "/repo" }],
          },
        }) +
        "\n",
    );

    await vi.waitFor(() =>
      expect(
        streamedEvents.some(
          (e) =>
            e.kind === "subagent_progress" &&
            e.subagent?.taskId === "sa-call:0" &&
            e.subagent._innerEvent?.kind === "tool_result",
        ),
      ).toBe(true),
    );

    // Emit duplicate tool_use with same toolUseId directly from session: Workspace must drop it and NOT broadcast it
    const beforeDupBroadcasts = streamedEvents.length;
    h.session.emit("event", {
      kind: "subagent_progress",
      content: "",
      subagent: {
        taskId: "sa-call:0",
        description: "",
        status: "running",
        _innerEvent: { kind: "tool_use", content: "`pwd`", toolName: "bash", toolUseId: "tu-1" },
      },
    });
    expect(streamedEvents).toHaveLength(beforeDupBroadcasts);

    // End turn before tool_execution_end (simulating abort/interruption): closes running subagent without sessionFile/transcriptPath and must keep live events
    h.emitter({ type: "agent_settled", aborted: true });
    await vi.waitFor(() =>
      expect(
        streamedEvents.some(
          (e) => e.kind === "subagent_done" && e.subagent?.taskId === "sa-call:0",
        ),
      ).toBe(true),
    );

    const msg = ws.getMessages().at(-1)!;
    const startEv = msg.events?.find(
      (e) => e.kind === "subagent_start" && e.subagent?.taskId === "sa-call:0",
    );
    expect(startEv?.subagent?.status).toBe("stopped");
    expect(startEv?.subagent?.events).toHaveLength(1);
    expect(startEv?.subagent?.events?.[0]).toMatchObject({
      kind: "tool_use",
      toolUseId: "tu-1",
      toolResult: "/repo",
    });
  });

  it("preserves pre-restart async live events in Workspace when reconciled dead without paths", async () => {
    const dir = tempDir();
    const runsRoot = path.join(dir, "async-subagent-runs");
    const asyncDir = path.join(runsRoot, "run-restore-live");
    fs.mkdirSync(asyncDir, { recursive: true });

    const h = createSessionHarness(dir);
    let activeSession = h.session;
    const registry = new HostRegistry();
    registry.register({
      id: "local",
      label: "Local",
      type: "local",
      connected: true,
      getInfo: () => ({ id: "local", label: "Local", type: "local", connected: true }),
      createSession: () => activeSession,
      destroySession: () => Promise.resolve(),
      restoreSession: (_id, state) => {
        activeSession = PiSession.fromState(state, { panelHttp: h.panel, livePollIntervalMs: 20 });
        cleanup.push(() => activeSession.dispose(500));
        return activeSession;
      },
    });
    const ws = new Workspace("ws-pi-restore-live", "Pi Restore", "test", "local", dir, registry, {
      onNewMessage: () => undefined,
      onStreamEvent: () => undefined,
      onMessageDone: () => undefined,
    });
    ws.addAgent("Pi", "mock/test", "", "#000", { backend: "pi", cwd: dir });

    await ws.sendMessage("launch async");
    await vi.waitFor(() => expect(h.emitter).toBeDefined());
    h.emitter({ type: "agent_start" });
    h.emitter({ type: "turn_start" });
    h.emitter({
      type: "tool_execution_start",
      toolCallId: "async-keep",
      toolName: "subagent",
      args: { async: true, tasks: [{ agent: "scout", task: "watch" }] },
    });
    h.emitter({
      type: "tool_execution_end",
      toolCallId: "async-keep",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "launched" }],
        details: { mode: "parallel", asyncDir, asyncId: "run-restore-live" },
      },
      isError: false,
    });
    h.emitter({ type: "agent_settled", aborted: false });

    fs.writeFileSync(
      path.join(asyncDir, "events.jsonl"),
      JSON.stringify({
        type: "message_end",
        subagentStepIndex: 0,
        message: { role: "assistant", content: [{ type: "text", text: "live-before-restart" }] },
      }) + "\n",
    );

    await vi.waitFor(() => {
      const m = ws.getMessages().at(-1);
      const start = m?.events?.find(
        (e) => e.kind === "subagent_start" && e.subagent?.taskId === "async-keep:0",
      );
      expect(start?.subagent?.events?.some((e) => e.content === "live-before-restart")).toBe(true);
    });

    const savedWs = ws.getState();
    await h.session.dispose(500);

    // Dead PID + no sessionFile/transcriptPath
    const exited = spawnSync(process.execPath, ["-e", ""]);
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: "run-restore-live",
        sessionId: activeSession.getState().sessionId,
        mode: "parallel",
        state: "running",
        pid: exited.pid,
        steps: [{ childId: "task-1", status: "running" }],
      }),
    );

    const restoredWs = Workspace.fromState(savedWs, registry, {
      onNewMessage: () => undefined,
      onStreamEvent: () => undefined,
      onMessageDone: () => undefined,
    });
    const restoredEvents: StreamEvent[] = [];
    activeSession.on("event", (e: StreamEvent) => restoredEvents.push(e));

    await activeSession.reconcileAsyncRuns();
    const done = restoredEvents.find(
      (e) => e.kind === "subagent_done" && e.subagent?.taskId === "async-keep:0",
    );
    expect(done?.subagent?.status).toBe("failed");
    expect(done?.subagent?.events).toBeUndefined();
    expect(done?.subagent?.eventCount).toBeUndefined();

    const msgAfter = restoredWs.getMessages().at(-1)!;
    const startAfter = msgAfter.events?.find(
      (e) => e.kind === "subagent_start" && e.subagent?.taskId === "async-keep:0",
    );
    expect(startAfter?.subagent?.status).toBe("failed");
    expect(startAfter?.subagent?.events?.some((e) => e.content === "live-before-restart")).toBe(
      true,
    );
  });
});
