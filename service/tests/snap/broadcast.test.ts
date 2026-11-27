// Replays Codex and Pi fixtures through the real session and workspace,
// captures broadcast frames, and folds them with the client's own functions.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { StreamEvent } from "../../src/session/types";
import { LocalHost, HostRegistry } from "../../src/session/host";
import {
  Workspace,
  type AgentRuntimeInfo,
  type WorkspaceCallbacks,
} from "../../src/workspace/workspace";
import {
  summarizeMessages,
  toWireEvent,
  toWireMessage,
  toWireStreamEvent,
} from "../../src/workspace/summary";
import { readTracePage } from "../../../shared/subagent-trace";
import { splitEvents } from "../../../webview/src/chat/events";
import {
  type Backend,
  readRecording,
  recordingPath,
  replay as replaySnap,
  loadFixture,
} from "./harness";
import {
  applyStreamBatch,
  withoutLiveTiming,
  type PendingEvent,
} from "../../../webview/src/state/stream";
import type { Message as ClientMessage } from "../../../webview/src/state/useServer";

type Frame = Record<string, unknown> & { type: string; t: number };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function replayBroadcast(backend: Backend, name: string) {
  const rec = readRecording(recordingPath(backend, name));
  const fixture = await loadFixture(backend, name);
  const frames: Frame[] = [];
  const liveAgents = new Map<string, AgentRuntimeInfo>();
  const at = () => Date.now();
  const cb: WorkspaceCallbacks = {
    onAgentUpdated: (_ws, agent) => void liveAgents.set(agent.id, clone(agent)),
    onNewMessage: (_ws, message) =>
      frames.push({ type: "new_message", t: at(), message: clone(toWireMessage(message)) }),
    onStreamEvent: (_ws, msg, event) =>
      frames.push({
        type: "stream_event",
        t: at(),
        messageId: msg.id,
        event: clone(toWireStreamEvent(event, msg)),
      }),
    onMessageDone: (_ws, messageId, status, content, events, patch) =>
      frames.push({
        type: "message_done",
        t: at(),
        messageId,
        status,
        content,
        events: events ? clone(events.map(toWireEvent)) : undefined,
        ...clone(patch ?? {}),
      }),
  };
  const replayed = await replaySnap(backend, rec, fixture, cb);
  return {
    frames,
    messages: replayed.messages,
    workspaceState: replayed.workspaceState,
    liveAgents,
  };
}

interface LiveSpan {
  messageId: string;
  openedAt: number;
  closedAt: number | null;
  closedBy: string | null;
}

// Mirrors useServer: stream events wait for a flush; message_done flushes
// first, then replaces status/content/events and applies the stats patch.
function clientFold(frames: Frame[], mode: "each" | "hidden") {
  let msgs: ClientMessage[] = [];
  let pending: PendingEvent[] = [];
  const spans: LiveSpan[] = [];
  const open = new Map<string, LiveSpan>();
  const observe = (t: number, by: string) => {
    for (const m of msgs) {
      const o = open.get(m.id);
      if (m.liveThinking != null && !o) {
        const s = { messageId: m.id, openedAt: t, closedAt: null, closedBy: null };
        open.set(m.id, s);
        spans.push(s);
      } else if (m.liveThinking == null && o) {
        o.closedAt = t;
        o.closedBy = by;
        open.delete(m.id);
      }
    }
  };
  const flushPending = (t: number, by: string) => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    msgs = applyStreamBatch([{ id: "ws", messages: msgs }], batch)[0].messages;
    observe(t, by);
  };
  for (const f of frames) {
    if (f.type === "new_message") {
      msgs = [...msgs, f.message as ClientMessage];
    } else if (f.type === "stream_event") {
      pending.push({ wsId: "ws", messageId: f.messageId as string, event: f.event as never });
      if (mode === "each") flushPending(f.t, (f.event as StreamEvent).kind);
    } else if (f.type === "message_done") {
      flushPending(f.t, "flush-before-done");
      msgs = msgs.map((m) => {
        if (m.id !== f.messageId) return m;
        const events = f.events as ClientMessage["events"];
        return {
          ...withoutLiveTiming(m),
          status: f.status as ClientMessage["status"],
          content: f.content as string,
          ...("queuedFor" in f ? { queuedFor: (f.queuedFor as string | null) ?? undefined } : {}),
          ...("steering" in f ? { steering: f.steering === true || undefined } : {}),
          ...(m.kind === "user" && {
            pendingDelivery: f.pendingDelivery as ClientMessage["pendingDelivery"],
          }),
          ...(events ? { events } : {}),
          ...("context" in f ? { context: f.context as ClientMessage["context"] } : {}),
          ...(f.effort ? { effort: f.effort as string } : {}),
          ...(f.thinking ? { thinking: f.thinking as ClientMessage["thinking"] } : {}),
        };
      });
      observe(f.t, "message_done");
    }
  }
  flushPending(Infinity, "end");
  return { msgs, spans };
}

const FIXTURES: Array<[Backend, string]> = [
  ["codex", "tools"],
  ["pi", "basic-turn"],
  ["pi", "antigravity-acp-turn"],
  ["pi", "tools-bash-edit"],
  ["pi", "crash-and-restore"],
  ["pi", "pi-subagents-foreground"],
  ["pi", "pi-subagents-async"],
  ["pi", "panel-tools-roundtrip"],
];

describe("broadcast parity", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["pi", "basic-turn"],
    ["codex", "commands"],
  ] as const)("%s/%s announces the reply before clearing dispatch", async (backend, name) => {
    const { frames, messages } = await replayBroadcast(backend, name);
    const input = messages.find((msg) => msg.kind === "user")!;
    const dispatching = frames.findIndex(
      (f) => f.type === "message_done" && f.messageId === input.id && f.status === "dispatching",
    );
    const opened = frames.findIndex(
      (f) =>
        f.type === "new_message" &&
        (f.message as ClientMessage).replyTo === input.id &&
        (f.message as ClientMessage).status === "streaming",
    );
    const cleared = frames.findIndex(
      (f) => f.type === "message_done" && f.messageId === input.id && f.status === "done",
    );
    expect(dispatching).toBeGreaterThanOrEqual(0);
    expect(opened).toBeGreaterThan(dispatching);
    expect(cleared).toBeGreaterThan(opened);
    expect(frames[cleared]).toMatchObject({ queuedFor: null, steering: false });
  });

  it.each([
    ["pi", "basic-turn", { tokens: 449, window: 272000, estimated: true }],
    ["pi", "antigravity-acp-turn", { tokens: 15444, window: 1000000, estimated: true }],
    ["pi", "compaction-and-retry", null],
    ["codex", "resume", { tokens: 53324, window: 258400, estimated: true }],
  ] as const)(
    "%s/%s keeps occupancy through broadcast and workspace reopen",
    async (backend, name, expected) => {
      const { frames, workspaceState, liveAgents } = await replayBroadcast(backend, name);
      const registry = new HostRegistry();
      registry.register(new LocalHost("local", "Local"));
      const reopened = Workspace.fromState(clone(workspaceState), registry).getInfo();
      expect(liveAgents.get(reopened.agents[0].id)?.context).toEqual(expected);
      expect(reopened.agents[0].context).toEqual(expected);
      const storedReply = reopened.messages.filter((m) => m.kind === "agent").at(-1)!;
      expect(storedReply.context).toEqual(expected);
      for (const mode of ["each", "hidden"] as const) {
        const { msgs } = clientFold(frames, mode);
        expect(msgs.find((m) => m.id === storedReply.id)?.context).toEqual(expected);
      }
    },
  );

  for (const [backend, name] of FIXTURES) {
    for (const mode of ["each", "hidden"] as const) {
      it(`${backend}/${name} (${mode} flush): client converges on the whole message, live view closed`, async () => {
        const { frames, messages } = await replayBroadcast(backend, name);
        // Thinking deltas are relayed, never persisted.
        const deltas = frames.filter(
          (f) => f.type === "stream_event" && (f.event as StreamEvent).kind === "thinking_delta",
        );
        const hasThinking =
          !name.startsWith("pi-subagents-") &&
          !["tools-bash-edit", "crash-and-restore", "panel-tools-roundtrip"].includes(name); // Tool-only turn, no reasoning block on wire.
        if (hasThinking) expect(deltas.length).toBeGreaterThan(0);
        else expect(deltas).toHaveLength(0);
        for (const m of messages) {
          expect(m.events?.some((e) => e.kind === "thinking_delta") ?? false).toBe(false);
        }
        const { msgs, spans } = clientFold(frames, mode);
        expect(msgs.map((m) => m.id)).toEqual(messages.map((m) => m.id));
        for (const m of msgs) expect(m.liveThinking, `${m.id} liveThinking`).toBeUndefined();
        messages.forEach((sm, i) => {
          const cm = msgs[i];
          expect(cm.status, `status ${i}`).toBe(sm.status);
          expect(cm.content, `content ${i}`).toBe(sm.content);
          expect(cm.queuedFor, `queuedFor ${i}`).toBe(sm.queuedFor);
          expect(cm.steering, `steering ${i}`).toBe(sm.steering);
          expect(cm.pendingDelivery, `pendingDelivery ${i}`).toBe(sm.pendingDelivery);
          expect(cm.replyTo, `replyTo ${i}`).toBe(sm.replyTo);
          expect(cm.thinking, `thinking ${i}`).toEqual(sm.thinking);
          expect(cm.context, `context ${i}`).toEqual(sm.context);
          expect(cm.effort, `effort ${i}`).toEqual(sm.effort);
          expect(clone(cm.events ?? []), `events ${i}`).toEqual(
            clone((sm.events ?? []).map(toWireEvent)),
          );
        });
        for (const span of spans) expect(span.closedAt, span.messageId).not.toBeNull();
        if (backend === "pi" && hasThinking) {
          expect(
            deltas.some((f) => {
              const event = f.event as StreamEvent;
              return event.content === "" && event.durationMs !== undefined;
            }),
          ).toBe(true);
          if (mode === "each") {
            expect(spans.length).toBeGreaterThan(0);
            expect(spans.every((span) => span.closedBy === "thinking_delta")).toBe(true);
          }
        }
        if (name.startsWith("pi-subagents-")) {
          const done = frames.filter(
            (f) => f.type === "stream_event" && (f.event as StreamEvent).kind === "subagent_done",
          );
          expect(done).toHaveLength(2);
          for (const frame of done) {
            const subagent = (frame.event as StreamEvent).subagent!;
            expect(subagent.eventCount).toBe(1);
            expect(subagent.events).toBeUndefined();
            const index = messages.findIndex((m) => m.id === frame.messageId);
            const taskId = subagent.taskId;
            const serverEvents = messages[index].events!;
            const page = readTracePage(1, serverEvents, taskId, { limit: 1 });
            expect(page).toMatchObject({
              events: [{ kind: "text", content: expect.stringMatching(/^x+$/) as unknown }],
              totalEvents: 1,
              revision: subagent.transcriptRevision,
              hasMore: false,
            });
            const cards = (events: ClientMessage["events"]) =>
              splitEvents(events ?? []).subagents.map((e) => e.subagent);
            expect(clone(cards(msgs[index].events))).toEqual(
              clone(cards(summarizeMessages([messages[index]])[0].events)),
            );
            const payload = JSON.stringify(frames);
            expect(payload).not.toContain('"_innerEvent"');
            expect(payload).not.toContain('"prompt":');
          }
        }
        // Summary pages keep the stats.
        const summary = summarizeMessages(messages);
        summary.forEach((m, i) => expect(m.thinking).toEqual(messages[i].thinking));
      });
    }
  }
});
