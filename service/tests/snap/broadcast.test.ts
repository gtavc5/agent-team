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
import { summarizeMessages } from "../../src/workspace/summary";
import {
  type Backend,
  readRecording,
  recordingPath,
  replay as replaySnap,
  loadFixture,
  stripChildTranscript,
} from "./harness";
import {
  applyStreamBatch,
  mergeDetailEvents,
  withoutLiveTiming,
  type PendingEvent,
} from "../../../webview/src/state/stream";
import type { Message as ClientMessage } from "../../../webview/src/state/useServer";

function stripEventsInnerEvents(events: StreamEvent[]): StreamEvent[] {
  return events.map((e) => {
    if (!e.subagent?.events?.length) return e;
    return {
      ...e,
      subagent: { ...e.subagent, eventCount: e.subagent.events.length, events: undefined },
    };
  });
}

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
      frames.push({ type: "new_message", t: at(), message: clone(message) }),
    onStreamEvent: (_ws, msg, event) =>
      frames.push({
        type: "stream_event",
        t: at(),
        messageId: msg.id,
        event: clone(
          backend === "pi" && event.kind === "subagent_done" ? stripChildTranscript(event) : event,
        ),
      }),
    onMessageDone: (_ws, messageId, status, content, events, patch) =>
      frames.push({
        type: "message_done",
        t: at(),
        messageId,
        status,
        content,
        events: events ? clone(stripEventsInnerEvents(events)) : undefined,
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
        const merged = events ? mergeDetailEvents(m.events, events) : undefined;
        return {
          ...withoutLiveTiming(m),
          status: f.status as ClientMessage["status"],
          content: f.content as string,
          ...(merged ? { events: merged } : {}),
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

const norm = (m: unknown) =>
  JSON.parse(
    JSON.stringify(m, (k: string, v: unknown) =>
      k === "_innerEvent" || k === "eventCount" || k === "transcriptRevision" ? undefined : v,
    ),
  ) as unknown;

const FIXTURES: Array<[Backend, string]> = [
  ["codex", "tools"],
  ["pi", "basic-turn"],
  ["pi", "antigravity-acp-turn"],
  ["pi", "tools-bash-edit"],
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
          !["tools-bash-edit", "panel-tools-roundtrip"].includes(name); // Tool-only turn, no reasoning block on wire.
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
          expect(cm.thinking, `thinking ${i}`).toEqual(sm.thinking);
          expect(cm.context, `context ${i}`).toEqual(sm.context);
          expect(cm.effort, `effort ${i}`).toEqual(sm.effort);
          expect(
            norm(stripEventsInnerEvents((cm.events ?? []) as StreamEvent[])),
            `events ${i}`,
          ).toEqual(norm(stripEventsInnerEvents(sm.events ?? [])));
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
            // Same payload selection as load_subagent_events, then the client's
            // detail update followed by a later summary refresh.
            const detail = serverEvents.find((e) => e.subagent?.taskId === taskId)!.subagent!
              .events!;
            const clientEvents = msgs[index].events!;
            expect(clientEvents.find((e) => e.subagent?.taskId === taskId)?.subagent).toMatchObject(
              {
                eventCount: detail.length,
              },
            );
            const hydrated = clientEvents.map((e) =>
              e.subagent?.taskId === taskId
                ? { ...e, subagent: { ...e.subagent, events: detail, eventCount: detail.length } }
                : e,
            );
            const refreshed = mergeDetailEvents(hydrated, stripEventsInnerEvents(serverEvents));
            expect(refreshed.find((e) => e.subagent?.taskId === taskId)?.subagent?.events).toEqual(
              detail,
            );
            expect(detail).toEqual([
              { kind: "text", content: expect.stringMatching(/^x+$/) as unknown },
            ]);
          }
        }
        // Summary pages keep the stats.
        const summary = summarizeMessages(messages);
        summary.forEach((m, i) => expect(m.thinking).toEqual(messages[i].thinking));
      });
    }
  }
});
