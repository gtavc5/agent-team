import type { SubagentStatus } from "./subagent-status";

export const TRACE_MAX_EVENTS = 24;
export const TRACE_MAX_BYTES = 32 * 1024;
export const TRACE_MAX_DEPTH = 6;
// Space for the fixed response envelope even with maximum-width cursors.
const TRACE_MIN_BYTES = 256;
const TRACE_ID_CHARS = 512;
const TRACE_TEXT_CHARS = 4096;
const OMITTED_ROW = { kind: "omitted", content: "", truncated: true } as const;

export interface TraceWindow {
  /** The cursor is an exclusive end for older pages, an inclusive start for newer ones. */
  cursor?: number;
  direction?: "before" | "after";
  path?: readonly string[];
  limit?: number;
  maxBytes?: number;
}

export interface TraceTarget {
  workspaceId: string;
  messageId: string;
  taskId: string;
}

export interface TraceRow {
  kind: string;
  content: string;
  toolName?: string;
  toolUseId?: string;
  toolResult?: string;
  isMarkdown?: boolean;
  toolResultIsMarkdown?: boolean;
  failed?: boolean;
  durationMs?: number;
  child?: { taskId: string; description: string; status?: SubagentStatus; taskType?: string };
  truncated?: boolean;
}

export interface TracePage {
  type: "subagent_trace_page";
  requestId: number;
  events: TraceRow[];
  start: number;
  end: number;
  totalEvents: number;
  revision: number;
  hasMore: boolean;
  truncated: boolean;
  unavailable?: true;
  prompt?: string;
  result?: string;
  usage?: TraceUsage;
}

type TraceUsage = { totalTokens: number; toolUses: number; durationMs: number };

interface TraceRun {
  taskId: string;
  description: string;
  status?: SubagentStatus;
  taskType?: string;
  transcriptRevision?: number;
  summary?: string;
  prompt?: string;
  usage?: TraceUsage;
  events?: TraceEvent[];
}

interface TraceEvent {
  kind: string;
  content: string;
  toolName?: string;
  toolUseId?: string;
  toolResult?: string;
  isMarkdown?: boolean;
  toolResultIsMarkdown?: boolean;
  toolResultIsError?: boolean;
  isError?: boolean;
  durationMs?: number;
  subagent?: TraceRun;
}

const encoder = new TextEncoder();
export function traceBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function clip(s: string | undefined, chars: number): string | undefined {
  if (s == null || s.length <= chars) return s;
  return `${s.slice(0, chars - 1)}…`;
}

function boundedInt(n: unknown, min: number, max: number, fallback: number): number {
  return typeof n === "number" && Number.isSafeInteger(n)
    ? Math.min(max, Math.max(min, n))
    : fallback;
}

function findRun(events: TraceEvent[] | undefined, id: string): TraceRun | undefined {
  const start = events?.find(
    (e) => e.kind === "subagent_start" && e.subagent?.taskId === id,
  )?.subagent;
  const done = events?.find(
    (e) => e.kind === "subagent_done" && e.subagent?.taskId === id,
  )?.subagent;
  if (!start) return done;
  if (!done) return start;
  // Old histories may have attached the only trace to the terminal event.
  return {
    ...done,
    ...start,
    events: start.events ?? done.events,
    summary: start.summary ?? done.summary,
    prompt: start.prompt ?? done.prompt,
    usage: start.usage ?? done.usage,
    transcriptRevision: Math.max(start.transcriptRevision ?? 0, done.transcriptRevision ?? 0),
  };
}

function rowOf(event: TraceEvent, chars: number, includeChild: boolean): TraceRow {
  const child = event.subagent;
  const childId = child?.taskId;
  const showChild = includeChild && child && childId && childId.length <= TRACE_ID_CHARS;
  const content = showChild ? "" : child ? (child.summary ?? child.description) : event.content;
  const truncated =
    (!!child && !showChild) ||
    (showChild && child.description.length > Math.min(chars, 160)) ||
    (content?.length ?? 0) > chars ||
    (event.toolResult?.length ?? 0) > chars ||
    (event.toolName?.length ?? 0) > Math.min(chars, 80);
  return {
    kind: clip(event.kind, 40) ?? "event",
    content: clip(content, chars) ?? "",
    toolName: clip(event.toolName, Math.min(chars, 80)),
    toolUseId:
      (event.toolUseId?.length ?? 0) <= Math.min(chars, TRACE_ID_CHARS)
        ? event.toolUseId
        : undefined,
    toolResult: clip(event.toolResult, chars),
    ...(event.isMarkdown && { isMarkdown: true }),
    ...(event.toolResultIsMarkdown && { toolResultIsMarkdown: true }),
    ...((event.toolResultIsError || event.isError) && { failed: true }),
    durationMs: event.durationMs,
    ...(showChild && {
      child: {
        taskId: childId,
        status: child.status,
        taskType: clip(child.taskType, 80),
        description: clip(child.description, Math.min(chars, 160)) ?? "",
      },
    }),
    ...(truncated && { truncated: true }),
  };
}

/** Page the authoritative, persisted trace; never put it through the message reducer. */
export function readTracePage(
  requestId: number,
  events: TraceEvent[] | undefined,
  taskId: string,
  window: TraceWindow,
): TracePage {
  const limit = boundedInt(window.limit, 1, TRACE_MAX_EVENTS, TRACE_MAX_EVENTS);
  const maxBytes = boundedInt(window.maxBytes, TRACE_MIN_BYTES, TRACE_MAX_BYTES, TRACE_MAX_BYTES);
  const root = findRun(events, taskId);
  let run = root;
  const path = window.path;
  if (path !== undefined) {
    if (!Array.isArray(path) || path.length > TRACE_MAX_DEPTH) run = undefined;
    else
      for (const id of path) {
        if (typeof id !== "string" || id.length > TRACE_ID_CHARS) {
          run = undefined;
          break;
        }
        run = findRun(run?.events, id);
      }
  }
  const trace = run?.events;
  const totalEvents = trace?.length ?? 0;
  const backwards = window.direction !== "after";
  const cursor = boundedInt(window.cursor, 0, totalEvents, backwards ? totalEvents : 0);
  const page: TracePage = {
    type: "subagent_trace_page",
    requestId,
    events: [],
    start: cursor,
    end: cursor,
    totalEvents,
    revision: root?.transcriptRevision ?? 0,
    hasMore: false,
    truncated: false,
    ...(!run && { unavailable: true }),
  };
  // Reserve a row marker (plus a cursor digit) so metadata never blocks paging.
  const metadataBudget = maxBytes - (totalEvents ? traceBytes(OMITTED_ROW) + 1 : 0);
  if (run?.usage) {
    const { totalTokens, toolUses, durationMs } = run.usage;
    page.usage = { totalTokens, toolUses, durationMs };
    if (traceBytes(page) > metadataBudget) {
      delete page.usage;
      page.truncated = true;
    }
  }
  if (run?.prompt != null || run?.summary != null) {
    // Fit both fields fairly; use exact wire sizes for escaping and UTF-8.
    function withText(chars: number): TracePage {
      return {
        ...page,
        prompt: chars ? clip(run?.prompt, chars) : undefined,
        result: chars ? clip(run?.summary, chars) : undefined,
        truncated:
          page.truncated ||
          (run?.prompt?.length ?? 0) > chars ||
          (run?.summary?.length ?? 0) > chars,
      };
    }
    let low = 0;
    let high = Math.min(
      TRACE_TEXT_CHARS,
      Math.max(run?.prompt?.length ?? 0, run?.summary?.length ?? 0),
    );
    if (traceBytes(withText(high)) <= metadataBudget) low = high;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (traceBytes(withText(mid)) <= metadataBudget) low = mid;
      else high = mid - 1;
    }
    Object.assign(page, withText(low));
  }
  while (trace && page.events.length < limit) {
    const index = backwards ? page.start - 1 : page.end;
    if (index < 0 || index >= totalEvents) break;
    // A single oversized event should not block access to the rest of the trace.
    // Shrink only when it won't fit in an empty window, otherwise page before it.
    const previous = { start: page.start, end: page.end, truncated: page.truncated };
    const includeChild = (path?.length ?? 0) < TRACE_MAX_DEPTH;
    let accepted = false;
    for (const chars of [TRACE_TEXT_CHARS, 768, 192, 64, 16, 1]) {
      const row = rowOf(trace[index], chars, includeChild);
      page.events.push(row);
      if (backwards) page.start = index;
      else page.end = index + 1;
      page.truncated ||= !!row.truncated;
      if (traceBytes({ ...page, hasMore: false }) <= maxBytes) {
        accepted = true;
        break;
      }
      page.events.pop();
      Object.assign(page, previous);
      if (page.events.length) break;
    }
    if (!accepted) {
      if (page.events.length) break;
      // Pathological IDs or escaping can exhaust the budget even after clipping.
      page.events.push(OMITTED_ROW);
      page.truncated = true;
      if (backwards) page.start = index;
      else page.end = index + 1;
    }
  }
  if (backwards) page.events.reverse();
  page.hasMore = backwards ? page.start > 0 : page.end < totalEvents;
  return page;
}
