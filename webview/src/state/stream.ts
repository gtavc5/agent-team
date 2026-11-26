import type { StreamEvent, Message, SubAgentInfo } from "./useServer";
import {
  attachToolResult,
  findSubagentEvent,
  isSubagentEvent,
  isTerminalSubagent,
  mergeSubagentInfo,
  upsertSubagentProgress,
} from "../chat/events";

export interface PendingEvent {
  wsId: string;
  messageId: string;
  event: StreamEvent;
  agentId?: string;
  streamAt?: number;
  retryLabel?: string | null;
}

// Kinds that only carry streamed text and never land in `events`.
const DELTA_KINDS = new Set(["text_delta", "thinking_delta"]);
const RETRY_PROGRESS_KINDS = new Set([
  "text_delta",
  "thinking_delta",
  "thinking",
  "tool_use",
  "subagent_start",
]);

function clearsRetry(e: StreamEvent): boolean {
  return (
    RETRY_PROGRESS_KINDS.has(e.kind) ||
    e.kind === "error" ||
    e.kind === "result" ||
    (e.kind === "retry" && !e.content)
  );
}

// Fold a batch of stream events into a message. Mirrors the server-side
// aggregation in task.ts so the client view converges with what gets
// persisted: tool results attach to their tool_use, subagent lifecycles fold
// onto the start event, retries update in place.
export function applyEventsToMessage(m: Message, evts: StreamEvent[]): Message {
  if (evts.length === 0) return m;
  const deltas = evts.filter((e) => DELTA_KINDS.has(e.kind));
  const regular = evts.filter((e) => !DELTA_KINDS.has(e.kind));
  let events = [...(m.events ?? [])];

  let content = m.content;
  const textDelta = deltas
    .filter((e) => e.kind === "text_delta")
    .map((e) => e.content)
    .join("");
  if (textDelta) content = (content || "") + textDelta;
  const live = liveThinkingAfter(m, evts);
  const liveChanged =
    live.liveThinking !== m.liveThinking ||
    live.closingThinking !== m.closingThinking ||
    live.liveThinkingSince !== m.liveThinkingSince ||
    live.waitingSince !== m.waitingSince;
  if (regular.length === 0) {
    const retryCleared = evts.some(clearsRetry) && events.some((e) => e.kind === "retry");
    if (retryCleared) events = events.filter((e) => e.kind !== "retry");
    return textDelta || liveChanged || retryCleared
      ? { ...withoutLiveTiming(m), content, ...live, ...(retryCleared && { events }) }
      : m;
  }

  let context = m.context;

  for (const ev of evts) {
    if (clearsRetry(ev) && events.some((e) => e.kind === "retry")) {
      events = events.filter((e) => e.kind !== "retry");
    }
    if (DELTA_KINDS.has(ev.kind)) continue;
    const attached = attachToolResult(events, ev);
    if (attached) {
      events[attached.index] = attached.event;
      continue;
    }
    // Tokens of the latest thinking block (task.ts does the same).
    if (ev.kind === "thinking_tokens") {
      let idx = events.length - 1;
      while (idx >= 0 && events[idx].kind !== "thinking") idx--;
      if (idx >= 0 && events[idx].tokens == null) {
        events[idx] = { ...events[idx], tokens: ev.tokens };
      }
      continue;
    }
    if (ev.kind === "retry") {
      if (!ev.content) continue;
      const idx = events.findIndex((e) => e.kind === "retry");
      if (idx >= 0) {
        events[idx] = { ...ev, contentOffset: events[idx].contentOffset };
        continue;
      }
    }
    const taskId = ev.subagent?.taskId;
    if (ev.kind === "subagent_progress" && taskId) {
      const start = findSubagentEvent(events, "subagent_start", taskId);
      events = recordSubagentProgress(events, ev, taskId, start);
      continue;
    }
    if (ev.kind === "subagent_enrichment") {
      if (ev.subagent) enrichSubagent(events, ev.subagent);
      continue;
    }
    if (ev.kind === "subagent_done" && taskId) {
      finishSubagent(events, ev, taskId);
      continue;
    }
    if (ev.kind === "compact" && ev.context !== undefined) context = ev.context;
    events.push(ev);
  }
  const next: Message = { ...withoutLiveTiming(m), content, events, ...live };
  if (context !== undefined) next.context = context;
  return next;
}

type LiveTiming = Pick<
  Message,
  "liveThinking" | "closingThinking" | "liveThinkingSince" | "waitingSince"
>;

// The thinking block streaming in, in batch order: an empty delta opens a
// block, the next ones extend it, and the main loop moving on ends it — its
// "thinking" event, a delta carrying the block's duration (a block whose
// text is not returned gets no event), the reply's text, a tool call.
function liveThinkingAfter(m: Message, evts: StreamEvent[]): LiveTiming {
  if (m.status !== "streaming") return {};
  let text = m.liveThinking;
  let closing = m.closingThinking;
  let since = m.liveThinkingSince;
  let waitingSince = m.waitingSince;
  for (const e of evts) {
    if (e.waitingSince !== undefined) waitingSince = e.waitingSince ?? undefined;
    // A background task reporting on this message is not the main loop
    // moving on.
    if (isSubagentEvent(e)) continue;
    if (e.kind === "thinking_delta" && e.durationMs != null && e.thinkingFollows) {
      closing = since != null ? (text ?? "") : closing;
    } else {
      closing = undefined;
    }
    if (e.kind !== "thinking_delta" || e.durationMs != null) {
      text = undefined;
      since = undefined;
    } else if (e.startedAt != null) {
      text = (e.startedAt === since ? (text ?? "") : "") + e.content;
      since = e.startedAt;
    } else if (text == null || !e.content) {
      text = e.content ?? "";
      since = !e.content ? Date.now() : (since ?? Date.now());
    } else {
      text += e.content;
    }
  }
  return {
    ...(text != null && { liveThinking: text }),
    ...(closing != null && { closingThinking: closing }),
    ...(since != null && { liveThinkingSince: since }),
    ...(waitingSince != null && { waitingSince }),
  };
}

export function withoutLiveTiming(m: Message): Message {
  if (
    m.liveThinking == null &&
    m.closingThinking == null &&
    m.liveThinkingSince == null &&
    m.waitingSince == null
  )
    return m;
  const {
    liveThinking: _text,
    closingThinking: _closing,
    liveThinkingSince: _thinking,
    waitingSince: _waiting,
    ...rest
  } = m;
  return rest;
}

function mergeLifecycle(start: StreamEvent, update: StreamEvent): StreamEvent {
  if (update.kind === "subagent_progress" && isTerminalSubagent(start)) return start;
  return { ...start, subagent: mergeSubagentInfo(start.subagent, update.subagent!) };
}

function recordSubagentProgress(
  events: StreamEvent[],
  update: StreamEvent,
  taskId: string,
  start: number,
): StreamEvent[] {
  const next = upsertSubagentProgress(events, update, taskId);
  if (start >= 0) {
    next[start] = mergeLifecycle(next[start], update);
  }
  return next;
}

// Keep the terminal frame in wire order, and keep the original card's position.
// Both callers own their event array before changing it.
function finishSubagent(events: StreamEvent[], done: StreamEvent, taskId: string): void {
  const progress = findSubagentEvent(events, "subagent_progress", taskId);
  const fallback = progress >= 0 ? events.splice(progress, 1)[0] : undefined;
  const start = findSubagentEvent(events, "subagent_start", taskId);
  if (start >= 0) {
    const base = fallback
      ? {
          ...events[start],
          subagent: mergeSubagentInfo(fallback.subagent, events[start].subagent!),
        }
      : events[start];
    events[start] = mergeLifecycle(base, done);
  }
  events.push(
    start < 0 && fallback
      ? { ...done, subagent: mergeSubagentInfo(fallback.subagent, done.subagent!) }
      : done,
  );
}

function enrichSubagent(events: StreamEvent[], patch: SubAgentInfo): void {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const sa = e.subagent;
    if (sa?.taskId !== patch.taskId || (e.kind !== "subagent_start" && e.kind !== "subagent_done"))
      continue;
    const revision = patch.transcriptRevision;
    if (revision != null && revision <= (sa.transcriptRevision ?? 0)) continue;
    events[i] = {
      ...e,
      subagent: {
        ...sa,
        ...(revision != null && { transcriptRevision: revision }),
        ...(patch.model != null && { model: patch.model }),
        ...(patch.effort != null && { effort: patch.effort }),
        ...(patch.durationMs != null && { durationMs: patch.durationMs }),
        ...(patch.summary != null && { summary: patch.summary }),
        ...(patch.lastTool != null && { lastTool: patch.lastTool }),
        ...(patch.eventCount != null && { eventCount: patch.eventCount }),
      },
    };
  }
}

// Apply a batch of pending events to every workspace it touches.
export function applyStreamBatch<W extends { id: string; messages: Message[] }>(
  workspaces: W[],
  batch: PendingEvent[],
): W[] {
  const byWs = new Map<string, Map<string, StreamEvent[]>>();
  for (const { wsId, messageId, event } of batch) {
    let byMsg = byWs.get(wsId);
    if (!byMsg) byWs.set(wsId, (byMsg = new Map<string, StreamEvent[]>()));
    const list = byMsg.get(messageId);
    if (list) list.push(event);
    else byMsg.set(messageId, [event]);
  }
  return workspaces.map((w) => {
    const byMsg = byWs.get(w.id);
    if (!byMsg) return w;
    return {
      ...w,
      messages: w.messages.map((m) => {
        const evts = byMsg.get(m.id);
        return evts ? applyEventsToMessage(m, evts) : m;
      }),
    };
  });
}

// Reconcile a freshly fetched newest page with what the client already
// holds. Used after a reconnect: anything that finished, failed or was
// removed while the socket was down is only visible in the server's copy.
// Older pages the client scrolled back to are kept; the window covered by the
// incoming page is replaced by it, message by message.
export function mergeLatestPage(existing: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return incoming;
  const incomingIds = new Set(incoming.map((m) => m.id));
  const oldest = incoming[0].timestamp;
  const byId = new Map(existing.map((m) => [m.id, m]));
  // Older history the client paged to. A tie on the page's first timestamp
  // is still "older" when the id is not on the page (same-millisecond
  // neighbours), otherwise a reconnect would drop a loaded message. Unless
  // the page reaches back into what the client holds, more arrived while
  // away than fits on it: the two are not adjacent, and paging (which
  // continues from the oldest loaded message) would never fill the gap. A
  // message that came live before the reply must not count as reaching.
  const reaches = byId.has(incoming[0].id);
  const retained = reaches
    ? existing.filter((m) => !incomingIds.has(m.id) && m.timestamp <= oldest)
    : [];
  const page = incoming.map((next) => {
    const cur = byId.get(next.id);
    return cur ? reconcileMessage(cur, next) : next;
  });
  return [...retained, ...page];
}

// Messages whose bodies the client had (streamed live or expanded) but that
// came back from the resync as summaries. Their full events must be
// re-fetched, or what the user was reading turns back into a placeholder.
export function downgradedMessageIds(existing: Message[], merged: Message[]): string[] {
  const hadBodies = new Set(
    existing.filter((m) => m.detail !== "summary" && m.events?.length).map((m) => m.id),
  );
  return merged.filter((m) => m.detail === "summary" && hadBodies.has(m.id)).map((m) => m.id);
}

const SETTLED = new Set<Message["status"]>(["done", "error", "outcome_unknown"]);

// The server sends summaries; keep the client's full bodies only when the
// message is settled on both sides and its events did not move, so nothing
// the user expanded reloads. Anything still streaming when the socket dropped
// takes the server's copy — the client's events stop wherever the connection
// did — and so does a settled message whose background card finished, grew
// or was stopped by a server restart in the meantime.
function reconcileMessage(cur: Message, next: Message): Message {
  const unchanged =
    SETTLED.has(cur.status) && cur.status === next.status && sameEvents(cur.events, next.events);
  if (unchanged && cur.detail !== "summary" && cur.events?.length) {
    const { detail: _summary, ...rest } = next;
    return { ...rest, events: cur.events };
  }
  // Keep a locally received prefix only if the server is still on that block.
  if (
    next.status === "streaming" &&
    next.liveThinkingSince != null &&
    next.liveThinkingSince === cur.liveThinkingSince &&
    cur.liveThinking != null
  ) {
    return { ...next, liveThinking: cur.liveThinking };
  }
  return next;
}

function sameEvents(cur: StreamEvent[] = [], next: StreamEvent[] = []): boolean {
  return (
    cur.length === next.length &&
    next.every((n, i) => {
      const c = cur[i];
      if (c.kind !== n.kind) return false;
      // A result that came (or failed) while the socket was down.
      if (n.kind === "tool_use") {
        const had = c.toolResult != null || c.resultLength != null;
        const has = n.toolResult != null || n.resultLength != null;
        return had === has && !!c.toolResultIsError === !!n.toolResultIsError;
      }
      if (!n.subagent) return true;
      return (
        !!c.subagent &&
        c.subagent.taskId === n.subagent.taskId &&
        c.subagent.description === n.subagent.description &&
        c.subagent.status === n.subagent.status &&
        c.subagent.model === n.subagent.model &&
        c.subagent.effort === n.subagent.effort &&
        (c.subagent.transcriptRevision ?? 0) === (n.subagent.transcriptRevision ?? 0) &&
        (c.subagent.eventCount ?? 0) === (n.subagent.eventCount ?? 0) &&
        c.subagent.lastTool === n.subagent.lastTool &&
        c.subagent.summary === n.subagent.summary
      );
    })
  );
}

// Tool name of a tool_use event. New servers tag it explicitly; older
// persisted events only carry the "**Name** ..." markdown prefix.
export function toolNameOf(ev: StreamEvent): string | null {
  if (ev.toolName) return ev.toolName;
  const m = (ev.content ?? "").match(/^\*\*([^*]+)\*\*/);
  return m ? m[1] : null;
}

// One-line summary for a tool_use row: the first line with the bold name
// stripped, so "**Read** `a.ts`" shows as "a.ts".
export function toolSummary(ev: StreamEvent): string {
  const firstLine = (ev.content ?? "").split("\n", 1)[0] ?? "";
  if (/^(?: {4}| {0,3}\t)/.test(firstLine)) return "";
  return firstLine
    .replace(/^\*\*[^*]+\*\*\s*/, "")
    .replace(/`/g, "")
    .trim();
}
