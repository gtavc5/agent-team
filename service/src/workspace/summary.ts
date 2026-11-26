import type { Message } from "./workspace";
import type { StreamEvent } from "../session/types";
import { panelActionOf } from "../../../shared/panel-actions";

// History pages carry only what the collapsed view needs: kinds, chips,
// counts, banners. Bodies (thinking text, tool output, subagent transcripts)
// are fetched per message when the user expands something. This keeps a
// 50-message page in the tens of KB instead of megabytes.

const FIRST_LINE_MAX = 200;
const BANNER_MAX = 600;

// Cut to BANNER_MAX with the ellipsis inside it, so a cut text is always
// shorter than its recorded length.
function capped(s: string): string {
  return s.length > BANNER_MAX ? s.slice(0, BANNER_MAX - 1) + "…" : s;
}

function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? "";
  return line.length > FIRST_LINE_MAX ? line.slice(0, FIRST_LINE_MAX) + "…" : line;
}

function shortSummary(text: string): string {
  return firstLine(text.slice(0, FIRST_LINE_MAX + 1));
}

export function toWireEvent(e: StreamEvent): StreamEvent {
  if (!e.subagent) return e;
  const sa = e.subagent;
  return {
    kind: e.kind,
    content: "",
    toolUseId: e.toolUseId,
    contentOffset: e.contentOffset,
    waitingSince: e.waitingSince,
    subagent: {
      taskId: sa.taskId,
      description: shortSummary(sa.description ?? ""),
      ...(sa.summary != null && { summary: shortSummary(sa.summary) }),
      ...(sa.lastTool != null && { lastTool: shortSummary(sa.lastTool) }),
      ...(sa.status != null && { status: sa.status }),
      ...(sa.agentType && { agentType: shortSummary(sa.agentType) }),
      ...(sa.taskType && { taskType: shortSummary(sa.taskType) }),
      ...(sa.model && { model: shortSummary(sa.model) }),
      ...(sa.effort && { effort: shortSummary(sa.effort) }),
      ...(sa.durationMs != null && { durationMs: sa.durationMs }),
      ...(sa.usage && { usage: sa.usage }),
      ...(sa.cancellable != null && { cancellable: sa.cancellable }),
      ...(sa.transcriptRevision != null && { transcriptRevision: sa.transcriptRevision }),
      ...(sa.events != null || sa.eventCount != null
        ? { eventCount: sa.events?.length ?? sa.eventCount }
        : {}),
    },
  };
}

export function toWireStreamEvent(e: StreamEvent, message: Message): StreamEvent {
  if (!e.subagent?._innerEvent) return toWireEvent(e);
  const owner = message.events?.find(
    (start) => start.kind === "subagent_start" && start.subagent?.taskId === e.subagent?.taskId,
  )?.subagent;
  return toWireEvent({
    kind: "subagent_enrichment",
    content: "",
    subagent: {
      taskId: e.subagent.taskId,
      description: "",
      lastTool: owner?.lastTool,
      eventCount: owner?.events?.length ?? owner?.eventCount,
      transcriptRevision: owner?.transcriptRevision,
    },
  });
}

export function summarizeEvent(e: StreamEvent): StreamEvent {
  const base: StreamEvent = { kind: e.kind, content: "" };
  if (e.toolName) base.toolName = e.toolName;
  if (e.level) base.level = e.level;
  if (e.toolUseId) base.toolUseId = e.toolUseId;
  if (e.contentOffset != null) base.contentOffset = e.contentOffset;
  if (e.step != null) base.step = e.step;
  if (e.isMarkdown) base.isMarkdown = true;
  if (e.toolResultIsMarkdown) base.toolResultIsMarkdown = true;
  if (e.toolResultIsError) base.toolResultIsError = true;
  if (e.durationMs != null) base.durationMs = e.durationMs;
  if (e.startedAt != null) base.startedAt = e.startedAt;
  if (e.tokens != null) base.tokens = e.tokens;

  switch (e.kind) {
    case "tool_use":
      // The panel's calls show as lines of their own (a session started, a
      // message sent): what was sent and answered, like a banner's text.
      if (panelActionOf(e)) {
        base.content = capped(e.content ?? "");
        base.bodyLength = (e.content ?? "").length;
        if (e.toolResult != null) {
          base.toolResult = capped(e.toolResult);
          base.resultLength = e.toolResult.length;
        }
        break;
      }
      const viewImage =
        e.toolName === "ViewImage" ||
        (!e.toolName && (e.content ?? "").startsWith("**ViewImage**"));
      base.content = firstLine(e.content ?? "");
      // A multiline filename is cut even when its first line is short.
      if (viewImage && (e.content ?? "").includes("\n") && !base.content.endsWith("…")) {
        base.content += "…";
      }
      base.bodyLength = (e.content ?? "").length;
      if (e.toolResult != null) {
        base.resultLength = e.toolResult.length;
        // A length-only summary cannot tell legacy "done" from real
        // four-character output. Keep just the placeholders the row hides.
        if (viewImage && (e.toolResult === "" || e.toolResult === "done")) {
          base.toolResult = e.toolResult;
        }
      }
      break;
    case "compact":
    case "notice":
    case "retry":
    case "error": {
      const text = e.content ?? "";
      base.content = capped(text);
      if (text.length > BANNER_MAX) base.contentLength = text.length;
      break;
    }
    case "subagent_start":
    case "subagent_progress":
    case "subagent_done":
      base.subagent = toWireEvent(e).subagent;
      break;
    default:
      // thinking, text, tool_result and anything else: body on demand.
      base.contentLength = (e.content ?? "").length;
      break;
  }
  return base;
}

/** Strip persistence-only dispatch fields before broadcasting a message over WS. */
export function toWireMessage(m: Message): Message {
  const hasSubagent = m.events?.some((e) => e.subagent) ?? false;
  if (!hasSubagent && m.queuedEnvelope === undefined && m.dispatchAttempt === undefined) return m;
  const copy = { ...m, ...(hasSubagent && { events: m.events?.map(toWireEvent) }) };
  delete copy.queuedEnvelope;
  delete copy.dispatchAttempt;
  return copy;
}

export function summarizeMessage(m: Message): Message {
  if (!m.events?.length) return toWireMessage(m);
  const { queuedEnvelope: _queued, dispatchAttempt: _attempt, ...wire } = m;
  return { ...wire, events: m.events.map(summarizeEvent), detail: "summary" };
}

export function summarizeMessages(messages: Message[]): Message[] {
  return messages.map(summarizeMessage);
}
