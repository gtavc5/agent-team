import {
  useState,
  useCallback,
  useMemo,
  memo,
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  createContext,
  useContext,
} from "react";
import { telemetryTarget } from "../telemetryEvents";
import type { ReactNode } from "react";
import type { Message, MessageOrigin, AgentInfo, StreamEvent } from "../state/useServer";
import { hasOutstandingSubagents, timelineBlocks, type TimelineBlock } from "./events";
import { isOutstandingSubagentStatus, type SubagentStatus } from "../../../shared/subagent-status";
import { toolNameOf, toolSummary } from "../state/stream";
import { copySelectionAsMarkdown } from "./clipboard";
import { CodeBlock, CopyButton, FileRefCode, MdBlock, StreamingMdBlock } from "./markdown";
import { FileOpenContext } from "./fileRef";
import { LocalDayContext, parseLocalDayKey } from "./localDay";
import { DEFAULT_USER } from "../state/useServer";
import { AgentAvatar, Avatar, isImageAvatar } from "../workspace/avatar";
import {
  formatTokens,
  formatDuration,
  formatRunTime,
  formatMessageTime,
  formatFullDateTime,
} from "../format";
import { shortModel } from "../workspace/models";
import { t, useT, type ChatKey } from "../i18n/chat";
import { agentNameColor } from "../workspace/agents";

function renderMentionContent(content: string, agents: AgentInfo[]) {
  const match = content.match(/^@(\S+)(\s+|$)/);
  if (!match) {
    return <MdBlock>{content}</MdBlock>;
  }
  const mentionName = match[1];
  const rest = content.slice(match[0].length);
  const mentioned = agents.find((a) => a.name === mentionName);
  return (
    <>
      <span
        className="mention-pill"
        style={
          mentioned
            ? { background: `color-mix(in srgb, ${mentioned.color} 12%, transparent)` }
            : undefined
        }
      >
        @{mentionName}
      </span>
      {rest && <MdBlock>{rest}</MdBlock>}
    </>
  );
}

// The sender of a message another session delivered (the server names it
// the same way in quotes and forwards).
const ORIGIN_GLYPH: Record<MessageOrigin["role"], string> = {
  lead: "◆",
  peer: "◆",
  worker: "◇",
  panel: "▣",
};

export function originLabel(from: MessageOrigin): string {
  if (from.role === "lead") return t("originLead");
  if (from.role === "panel") return t("originPanel", { name: from.name });
  return from.role === "peer" ? t("originPeer", { name: from.name }) : from.name;
}

// Banners that carry a whole prompt (a wake-up's text, a scheduled
// wake-up's instructions, a skill's body) start folded to their first line.
const FOLDING_LEVELS = new Set(["wakeup", "schedule", "skill"]);
const FOLD_OVER_CHARS = 160;
const BANNER_LABEL_KEY: Record<string, ChatKey> = {
  wakeup: "wokeUp",
  schedule: "scheduled",
  skill: "skill",
  error: "error",
};

export function bannerFirstLine(content: string): string {
  const line = (content ?? "").split("\n").find((l) => l.trim()) ?? "";
  const plain = line.replace(/[*_`#>]/g, "").trim();
  return plain.length > FOLD_OVER_CHARS ? plain.slice(0, FOLD_OVER_CHARS - 1) + "…" : plain;
}

export function bannerFolds(level: string, content: string): boolean {
  if (!FOLDING_LEVELS.has(level)) return false;
  const text = content ?? "";
  return text.trim().includes("\n") || text.length > FOLD_OVER_CHARS;
}

// Inline status line: compaction, CLI notices, API retries. Rendered as a
// sibling of the step box so it is visible without expanding anything.
export const BannerItem = memo(function BannerItem({
  ev,
  onLoadDetails,
}: {
  ev: StreamEvent;
  // Summary pages cap banner bodies; opening one fetches the full message.
  onLoadDetails?: () => void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const level =
    ev.kind === "compact"
      ? "compact"
      : ev.kind === "retry"
        ? "retry"
        : ev.kind === "error"
          ? "error"
          : (ev.level ?? "notice");
  const truncated = (ev.contentLength ?? 0) > (ev.content ?? "").length;
  const icon =
    ev.kind === "compact"
      ? "⇢"
      : ev.kind === "retry"
        ? "↻"
        : level === "wakeup" || level === "schedule"
          ? "⏰"
          : level === "skill"
            ? "✦"
            : level === "warning" || level === "error"
              ? "!"
              : "i";
  const folds = bannerFolds(level, ev.content);
  const labelKey = BANNER_LABEL_KEY[level];
  const label = labelKey ? tr(labelKey) : undefined;
  return (
    <div
      className={`banner banner-${level}${folds && !open ? " banner-folded" : ""}`}
      data-kind={ev.kind}
    >
      <span className="banner-icon">{icon}</span>
      <div className="banner-text">
        {label && <span className="banner-label">{label}</span>}
        {folds && !open ? (
          <span className="banner-first-line">{bannerFirstLine(ev.content)}</span>
        ) : ev.kind === "notice" || ev.kind === "error" ? (
          <MdBlock>{ev.content}</MdBlock>
        ) : (
          ev.content
        )}
      </div>
      {(folds || truncated) && (
        <button
          className="btn-inline banner-toggle"
          onClick={() => {
            if (truncated) onLoadDetails?.();
            setOpen((v) => !v);
          }}
        >
          {open ? tr("less") : tr("more")}
        </button>
      )}
    </div>
  );
});

// Sessions and projects named in the chat (a panel action's target): their
// names as they are now, and a session opened on a click.
export interface SessionLinks {
  open?: (workspaceId: string) => void;
  nameOf?: (id: string) => string | undefined;
}
export const SessionLinkContext = createContext<SessionLinks>({});

// The message's turn is still running: a call left without a result by a
// stopped one (a restart) is not counted up for ever.
const TurnRunningContext = createContext(false);

const ACTION_LABEL_KEY: Record<string, ChatKey> = {
  start_session: "newSession",
  message_session: "message",
  message_project: "messageProject",
  stop_session: "stopped",
  archive_session: "archivedLabel",
  report_progress: "progressLead",
  finish_task: "taskFinished",
};

// A panel call as the panel renders it (claude.ts formatPanelTool): the
// line after the tool's name (a title, an id), then the quoted text (a
// task, a message, a report).
function actionParts(content: string): { head: string; quote: string } {
  const lines = (content ?? "").split("\n");
  const head = lines[0]
    .replace(/^\*\*[^*]+\*\*\s*/, "")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
  const quote = lines
    .filter((l) => l.startsWith(">"))
    .map((l) => l.replace(/^> ?/, ""))
    .join("\n");
  return { head, quote };
}

// A panel call that changed something elsewhere, as a line of its own:
// what was done, to whom (the session opens on a click), the first line of
// what was sent, and whether it failed.
export const PanelActionItem = memo(function PanelActionItem({
  ev,
  action,
  onLoadDetails,
}: {
  ev: StreamEvent;
  action: string;
  onLoadDetails?: () => void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const links = useContext(SessionLinkContext);
  const { head, quote } = actionParts(ev.content);
  const failed = !!ev.toolResultIsError;
  const result = ev.toolResult ?? "";
  const pending = ev.toolResult == null && ev.resultLength == null;
  // A summary page cut the text or the answer: expanding fetches them.
  const partial =
    (ev.resultLength ?? 0) > result.length || (ev.bodyLength ?? 0) > (ev.content ?? "").length;
  const session = /\b(ws-[\w-]+)/.exec(failed ? head : `${head} ${result}`)?.[1];
  const project = /\b(proj-[\w-]+)/.exec(head)?.[1];
  // The name as it is now; else as the answer quotes it ('Sent to
  // "modules".'); else a new session's title ("title in folder").
  const cut = head.lastIndexOf(" in ");
  const target =
    links.nameOf?.(session ?? project ?? "") ??
    ((!failed && /"([^"]+)"/.exec(result)?.[1]) ||
      (action === "start_session" && cut > 0 ? head.slice(0, cut) : head));
  const preview = bannerFirstLine(quote);
  const actionKey = ACTION_LABEL_KEY[action];
  return (
    <div
      className={`banner banner-action${open ? "" : " banner-folded"}${failed ? " banner-failed" : ""}${pending ? " banner-pending" : ""}`}
      data-action={action}
    >
      <span className="banner-icon">{failed ? "!" : "◆"}</span>
      <div className="banner-text">
        <span className="banner-label">{actionKey ? tr(actionKey) : action}</span>
        {target &&
          (session && links.open ? (
            <button
              className="action-target"
              title={tr("openThatSession")}
              onClick={() => links.open!(session)}
            >
              {target}
            </button>
          ) : (
            <span className="action-target">{target}</span>
          ))}
        {failed ? (
          <span className="action-error">{bannerFirstLine(result)}</span>
        ) : (
          !open && preview && <span className="banner-first-line">{preview}</span>
        )}
        {open && (
          <>
            {quote && <MdBlock>{quote}</MdBlock>}
            {result && <div className="action-result">{result}</div>}
          </>
        )}
      </div>
      {(quote || result || partial) && (
        <button
          className="btn-inline banner-toggle"
          onClick={() => {
            if (partial) onLoadDetails?.();
            setOpen((v) => !v);
          }}
        >
          {open ? tr("less") : tr("more")}
        </button>
      )}
    </div>
  );
});

// Tools that schedule the session's own future (ScheduleWakeup, cron) get a
// distinct chip so a "sleeping until X" step reads differently from work.
const SCHEDULE_TOOLS = new Set(["ScheduleWakeup", "CronCreate", "CronDelete"]);

function chipClassFor(toolName: string | null, kind: string): string {
  if (toolName && SCHEDULE_TOOLS.has(toolName)) return "chip-schedule";
  if (toolName?.startsWith("mcp__panel__")) return "chip-panel";
  return kind === "tool_use" ? "chip-tool" : `chip-${kind}`;
}

// MCP tools arrive as mcp__<server>__<tool>; the panel's own read as plain
// names.
export function chipLabelFor(toolName: string): string {
  if (toolName === "ScheduleWakeup") return t("wakeupChip");
  const mcp = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return mcp[1] === "panel" ? mcp[2] : `${mcp[1]} · ${mcp[2]}`;
  return toolName;
}

// Effort, fast mode and context occupancy line under an agent message
// header. Thinking time and tokens show on the blocks in the steps.
export function MessageStatus({ msg }: { msg: Message }) {
  const tr = useT();
  if (!msg.effort && !msg.fast && msg.context === undefined) return null;
  const ctx = msg.context;
  const pct =
    ctx && ctx.window > 0 ? Math.min(100, Math.round((ctx.tokens / ctx.window) * 100)) : null;
  const tone = pct == null ? "" : pct >= 90 ? " ctx-high" : pct >= 70 ? " ctx-warn" : "";
  return (
    <div className="message-status">
      {msg.effort && (
        <span className="status-chip" title={tr("reasoningEffort")}>
          {tr("effortChip", { effort: msg.effort })}
        </span>
      )}
      {msg.fast && (
        <span className="status-chip fast-chip" title={tr("fastMode")}>
          {tr("fastChip")}
        </span>
      )}
      {ctx === null && <span className="status-chip ctx-chip">{tr("contextUnknown")}</span>}
      {ctx && pct != null && (
        <span
          className={`status-chip ctx-chip${tone}`}
          title={tr(ctx.estimated ? "contextEstimate" : "context", {
            tokens: ctx.tokens.toLocaleString(),
            window: ctx.window.toLocaleString(),
          })}
        >
          <span className="ctx-bar">
            <span className="ctx-bar-fill" style={{ width: `${pct}%` }} />
          </span>
          {tr("contextChip", {
            tokens: `${formatTokens(ctx.tokens)}`,
            window: formatTokens(ctx.window),
            pct,
          })}
        </span>
      )}
    </div>
  );
}

function thinkingLabel(ev: StreamEvent, tr: ReturnType<typeof useT>): string {
  const head =
    ev.durationMs != null
      ? tr("thoughtFor", { duration: formatDuration(ev.durationMs) })
      : tr("thinking");
  if (!ev.tokens) return head;
  const tokens = ev.tokens < 1000 ? String(ev.tokens) : `${(ev.tokens / 1000).toFixed(1)}k`;
  return tr("thinkingTokens", { head, tokens });
}

const KIND_LABEL_KEY: Record<string, ChatKey> = {
  thinking: "thinking",
  tool_result: "result",
  text: "text",
  error: "error",
};

// A tool body under its row: the row already shows the first line.
function afterFirstLine(content: string, singleLine = content): string {
  const nl = content.indexOf("\n");
  return nl < 0 ? singleLine : content.slice(nl + 1);
}

function resultLabel(len: number, tr: ReturnType<typeof useT>): string {
  return tr("chars", { count: len > 1000 ? `${Math.round(len / 1000)}k` : len });
}

function formatSize(len: number, tr: ReturnType<typeof useT>): string {
  return tr("chars", {
    count: len > 1000 ? `${(len / 1000).toFixed(len < 10000 ? 1 : 0)}k` : len,
  });
}

// Strip Codex's outer Markdown delimiters only. toolSummary also removes
// backticks from the filename itself, which would open a different file.
function viewImagePathOf(ev: StreamEvent): string {
  const body = (ev.content ?? "").replace(/^\*\*[^*]+\*\*\s*/, "");
  if (!body.startsWith("`")) return body.trim();
  const inner = body.slice(1);
  return inner.endsWith("`") ? inner.slice(0, -1) : inner;
}

function ViewImagePath({
  path,
  truncated,
  onLoadDetails,
}: {
  path: string;
  truncated: boolean;
  onLoadDetails?: () => void;
}) {
  const tr = useT();
  const openFile = useContext(FileOpenContext);
  const pending = useRef(false);
  const open = useCallback(
    (target: string) => {
      if (truncated) {
        pending.current = true;
        // A send can be dropped while disconnected: every activation may retry.
        onLoadDetails?.();
        return;
      }
      pending.current = false;
      openFile?.(target, { literalPath: true });
    },
    [onLoadDetails, openFile, truncated],
  );
  // Loading message details replaces this row's props without remounting it.
  // Only then open, using the now-complete path rather than its ellipsis.
  useEffect(() => {
    if (!pending.current || truncated || !path || !openFile) return;
    open(path);
  }, [open, openFile, path, truncated]);

  if (!openFile || !path) return <code>{path}</code>;
  return (
    <FileRefCode target={path} title={tr("openImageFiles")} onOpen={open}>
      {path}
    </FileRefCode>
  );
}

export const EventItem = memo(function EventItem({
  ev,
  onLoadDetails,
  liveThinking = false,
}: {
  ev: StreamEvent;
  liveThinking?: boolean;
  // Set while the message is a summary: called on first expand so the
  // bodies get fetched.
  onLoadDetails?: () => void;
}) {
  const tr = useT();
  const [resultOpen, setResultOpen] = useState(false);
  const [bodyOpen, setBodyOpen] = useState(false);
  const summarized = !!onLoadDetails;
  const running = useContext(TurnRunningContext) && isRunningTool(ev);
  const runningSecs = useElapsed(running ? ev.startedAt : undefined);

  if (ev.kind === "compact" || ev.kind === "notice" || ev.kind === "retry" || ev.kind === "error") {
    return <BannerItem ev={ev} onLoadDetails={onLoadDetails} />;
  }

  const isResult = ev.kind === "tool_result";
  const isToolUse = ev.kind === "tool_use";
  const isThinking = ev.kind === "thinking";
  const toolName = isToolUse ? toolNameOf(ev) : null;
  const summary = isToolUse
    ? toolName === "ViewImage"
      ? viewImagePathOf(ev)
      : toolSummary(ev)
    : "";
  const kindKey = KIND_LABEL_KEY[ev.kind];
  const label = toolName
    ? chipLabelFor(toolName)
    : isThinking
      ? thinkingLabel(ev, tr)
      : kindKey
        ? tr(kindKey)
        : ev.kind;
  const chipClass = chipClassFor(toolName, ev.kind);
  const [firstLine, nextLine] = isToolUse && !summary ? ev.content.split("\n", 2) : [];
  const duplicateHeading =
    firstLine?.trimEnd().toLowerCase() === `**${label.toLowerCase()}**` &&
    /^(?:| {0,3}(?:`{3,}[^`]*|~{3,}.*))$/.test(nextLine?.trimEnd() ?? "");
  const body =
    summary || duplicateHeading
      ? afterFirstLine(ev.content, duplicateHeading ? "" : ev.content)
      : ev.content;
  // Multi-line tool calls (Bash commands, edits) always show their body;
  // single-line ones (Read, Grep) get a summary and an optional details toggle.
  const bodyLen = ev.bodyLength ?? ev.content.length;
  const multiLine =
    isToolUse &&
    toolName !== "ViewImage" &&
    (ev.content.includes("\n") || bodyLen > ev.content.length);
  const showBodyByDefault = isToolUse && (multiLine || !summary);
  const hasHiddenBody =
    isToolUse && toolName !== "ViewImage" && !showBodyByDefault && bodyLen > summary.length + 16;
  const resultLen = isResult
    ? (ev.contentLength ?? ev.content.length)
    : (ev.resultLength ?? ev.toolResult?.length ?? 0);
  const placeholderResult =
    toolName === "ViewImage" &&
    !ev.toolResultIsError &&
    (ev.toolResult === "" ||
      ev.toolResult === "done" ||
      (ev.toolResult == null && ev.resultLength === 0));
  const hasResult =
    isToolUse && !placeholderResult && (ev.toolResult != null || ev.resultLength != null);
  // A summarised body renders as a placeholder until the details arrive.
  const bodyMissing = summarized && !isToolUse && !ev.content && (ev.contentLength ?? 0) > 0;
  const toolBodyMissing =
    summarized && isToolUse && showBodyByDefault && bodyLen > ev.content.length;
  // A summary page cuts a long first line short: nothing whole to copy yet.
  const summaryCut = summarized && ev.content.endsWith("…");
  const toggleResult = () => {
    if (summarized) onLoadDetails?.();
    setResultOpen((v) => !v);
  };
  const toggleBody = () => {
    if (summarized) onLoadDetails?.();
    setBodyOpen((v) => !v);
  };

  return (
    <div className={`event event-${ev.kind}${liveThinking ? " live-thinking" : ""}`}>
      <div className="event-row" aria-hidden={liveThinking || undefined}>
        {!liveThinking && <span className={`event-chip ${chipClass}`}>{label}</span>}
        {isToolUse && ev.durationMs != null && (
          <span className="event-time" title={tr("fromCallResult")}>
            {formatRunTime(ev.durationMs)}
          </span>
        )}
        {running && ev.startedAt != null && (
          <span className="event-time event-time-live" title={tr("runningFor")}>
            {formatDuration(runningSecs * 1000)}
          </span>
        )}
        {hasHiddenBody && (
          <button
            className="btn-inline"
            {...telemetryTarget("trace.tool_toggle")}
            onClick={toggleBody}
          >
            {bodyOpen ? tr("hide") : tr("details")}
          </button>
        )}
        {(isResult || hasResult) && (
          <button
            className="btn-inline btn-diff"
            aria-expanded={resultOpen}
            {...telemetryTarget("trace.tool_toggle")}
            onClick={toggleResult}
          >
            {isResult
              ? resultOpen
                ? tr("hide")
                : tr("show")
              : resultOpen
                ? tr("hideResult")
                : tr("result")}{" "}
            · {resultLabel(resultLen, tr)}
          </button>
        )}
      </div>
      {isToolUse && summary && (
        <div className="event-summary-line">
          {!summaryCut && <CopyButton text={() => summary} />}
          {toolName === "ViewImage" ? (
            <ViewImagePath path={summary} truncated={summaryCut} onLoadDetails={onLoadDetails} />
          ) : (
            <code>{summary}</code>
          )}
        </div>
      )}
      {(bodyMissing || (toolBodyMissing && !bodyOpen)) && (
        <div
          className="event-content event-placeholder"
          {...telemetryTarget("trace.tool_toggle")}
          onClick={isResult ? toggleResult : toggleBody}
        >
          {tr("tapToLoad", {
            size: formatSize(bodyMissing ? (ev.contentLength ?? 0) : bodyLen, tr),
          })}
        </div>
      )}
      {isResult ? (
        resultOpen &&
        ev.content && (
          <div className="event-content event-result">
            {ev.isMarkdown ? (
              <MdBlock>{ev.content}</MdBlock>
            ) : (
              <CodeBlock>
                <code>{ev.content}</code>
              </CodeBlock>
            )}
          </div>
        )
      ) : (
        <>
          {!bodyMissing &&
            !toolBodyMissing &&
            (!isToolUse || showBodyByDefault || bodyOpen) &&
            (!duplicateHeading || body) &&
            (!liveThinking || body) && (
              <div className="event-content">
                {isThinking ? (
                  <StreamingMdBlock>{body}</StreamingMdBlock>
                ) : (
                  <MdBlock>{body}</MdBlock>
                )}
              </div>
            )}
          {hasResult && resultOpen && ev.toolResult != null && (
            <div className="event-content event-result">
              {ev.toolResultIsMarkdown ? (
                <MdBlock>{ev.toolResult}</MdBlock>
              ) : (
                <CodeBlock>
                  <code>{ev.toolResult}</code>
                </CodeBlock>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
});

function useBottomCollapse(open: boolean, close: () => void) {
  const header = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const pending = useRef<{ scroller: HTMLElement | null; clipped: boolean } | null>(null);
  const topOfViewport = (scroller: HTMLElement | null) =>
    scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0;

  useLayoutEffect(() => {
    if (open || !pending.current || !header.current) return;
    const { scroller, clipped } = pending.current;
    pending.current = null;
    toggle.current?.focus({ preventScroll: true });
    if (!clipped) return;
    // Measure again after the body is removed: the browser may already have
    // clamped the scroll offset, particularly at the end of the transcript.
    const delta = header.current.getBoundingClientRect().top - topOfViewport(scroller);
    if (delta < 0) (scroller ?? window).scrollBy({ top: delta, behavior: "instant" });
  }, [open]);

  return {
    header,
    toggle,
    collapse: () => {
      const el = header.current;
      if (el) {
        let scroller = el.parentElement;
        while (scroller && !/^(auto|scroll|overlay)$/.test(getComputedStyle(scroller).overflowY)) {
          scroller = scroller.parentElement;
        }
        pending.current = {
          scroller,
          clipped: el.getBoundingClientRect().top < topOfViewport(scroller),
        };
      }
      close();
    },
  };
}

function BottomCollapse({
  onClick,
  label,
  action,
}: {
  onClick: () => void;
  label: string;
  action: "trace.step_toggle" | "trace.subagent_toggle";
}) {
  const tr = useT();
  return (
    <div className="trace-collapse-footer">
      <button
        type="button"
        className="trace-collapse"
        {...telemetryTarget(action)}
        onClick={onClick}
        aria-label={label}
      >
        <span aria-hidden="true">▴</span> {tr("collapse")}
      </button>
    </div>
  );
}

function hasVisibleEventBody(ev: StreamEvent): boolean {
  return ev.kind !== "thinking" || !!ev.content.trim() || (ev.contentLength ?? 0) > 0;
}

const SUBAGENT_STATUS_ICONS: Record<SubagentStatus, string> = {
  queued: "◷",
  running: "↻",
  completed: "✓",
  failed: "✗",
  partial: "◐",
  paused: "Ⅱ",
  stopped: "◼",
  rejected: "⊘",
};

export const SubAgentItem = memo(function SubAgentItem({
  ev,
  onLoadEvents,
  onCancel,
  onLoadDetails,
}: {
  ev: StreamEvent;
  onLoadEvents?: (taskId: string) => void;
  onCancel?: (taskId: string) => void;
  onLoadDetails?: () => void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const bottom = useBottomCollapse(open, () => setOpen(false));
  const sa = ev.subagent;
  // The server holds more of the transcript than the client (a summary
  // page, or a live tail that arrived after the summary).
  const needsLoad = !!sa && (sa.eventCount ?? 0) > (sa.events?.length ?? 0);
  const transcriptRevision = sa?.transcriptRevision;
  useEffect(() => {
    if (open && needsLoad && onLoadEvents && sa?.taskId) onLoadEvents(sa.taskId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per open/needsLoad flip or transcript replacement; sa and onLoadEvents change identity on every stream update
  }, [open, needsLoad, transcriptRevision]);
  if (!sa) return null;

  const status = sa.status ?? (ev.kind === "subagent_done" ? "failed" : "stopped");
  const outstanding = isOutstandingSubagentStatus(status);
  const statusTitle = tr(
    (
      {
        queued: "subagentStatusQueued",
        running: "subagentStatusRunning",
        completed: "subagentStatusCompleted",
        stopped: "subagentStatusStopped",
        failed: "subagentStatusFailed",
        partial: "subagentStatusPartial",
        paused: "subagentStatusPaused",
        rejected: "subagentStatusRejected",
      } as const
    )[status],
  );

  const allInner = sa.events ?? [];
  const hasBody = !!(sa.prompt || sa.summary || sa.usage || allInner.some(hasVisibleEventBody));

  const handleToggle = () => {
    const willOpen = !open;
    setOpen(willOpen);
    if (willOpen && onLoadDetails) onLoadDetails();
  };

  // Its time is in the header, measured from this run's start: the CLI's
  // counts from the first, a resumed agent's idle time between included.
  // Records from before it was measured: the CLI's time of a finished agent.
  const ran = sa.durationMs ?? (outstanding ? undefined : sa.usage?.durationMs);
  const usageStr = sa.usage
    ? tr("subagentUsage", {
        tokens: `${Math.round(sa.usage.totalTokens / 1000)}k`,
        tools: sa.usage.toolUses,
      })
    : null;

  const role = sa.description || tr("subagent");
  return (
    <div className={`subagent-item subagent-${status}`}>
      <div
        className="subagent-header"
        ref={bottom.header}
        {...telemetryTarget("trace.subagent_toggle")}
        onClick={handleToggle}
      >
        <button
          type="button"
          className="events-toggle trace-header-toggle"
          ref={bottom.toggle}
          aria-expanded={open}
          {...telemetryTarget("trace.subagent_toggle")}
          aria-label={open ? tr("collapseSubagent", { role }) : tr("expandSubagent", { role })}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className={`subagent-status-icon subagent-icon-${status}`} title={statusTitle}>
          {SUBAGENT_STATUS_ICONS[status]}
        </span>
        <span className="subagent-desc" title={role}>
          {role}
        </span>
        {sa.model && (
          <span className="subagent-model" title={sa.model}>
            {shortModel(sa.model)}
          </span>
        )}
        {sa.effort && (
          <span className="subagent-effort" title={tr("effortTitle", { effort: sa.effort })}>
            {sa.effort}
          </span>
        )}
        {ran != null && (
          <span className="subagent-time" title={tr("howLongRan")}>
            {formatRunTime(ran)}
          </span>
        )}
        {status === "running" && <span className="streaming-dot" />}
        {outstanding && sa.cancellable !== false && onCancel && (
          <button
            className="btn-cancel-subagent"
            title={tr("cancelSubagent")}
            onClick={(e) => {
              e.stopPropagation();
              onCancel(sa.taskId);
            }}
          >
            {tr("cancel")}
          </button>
        )}
      </div>
      {open && (
        <div className="subagent-details subagent-body">
          {sa.prompt && (
            <div className="subagent-prompt">
              <MdBlock>{sa.prompt}</MdBlock>
            </div>
          )}
          {(needsLoad || (!sa.prompt && sa.hasPrompt) || (!sa.summary && sa.summaryLength)) && (
            <div className="subagent-loading">{tr("loading")}</div>
          )}
          {allInner.length > 0 && (
            <div className="subagent-events">
              {timelineBlocks(allInner).map((block, bi) => {
                if (block.kind === "steps") {
                  return block.events.map((ie, i) => (
                    <EventItem key={`${bi}-${i}`} ev={ie} onLoadDetails={onLoadDetails} />
                  ));
                }
                return (
                  <TimelineBlockItem
                    key={timelineBlockKey(block, bi)}
                    block={block}
                    onLoadEvents={onLoadEvents}
                    onCancelSubagent={onCancel}
                    onLoadDetails={onLoadDetails}
                  />
                );
              })}
            </div>
          )}
          {sa.summary && (
            <div className="subagent-summary">
              <MdBlock>{sa.summary}</MdBlock>
            </div>
          )}
          {usageStr && <div className="subagent-usage">{usageStr}</div>}
          {hasBody && (
            <BottomCollapse
              onClick={bottom.collapse}
              label={tr("collapseTrace")}
              action="trace.subagent_toggle"
            />
          )}
        </div>
      )}
    </div>
  );
});

function stepSummary(regular: StreamEvent[], tr: ReturnType<typeof useT>): string {
  const count = (kind: string) => regular.filter((e) => e.kind === kind).length;
  const thinkingCount = count("thinking");
  const toolCount = count("tool_use");
  const errorCount = count("error");
  const resultCount = count("tool_result");
  const parts: string[] = [];
  if (thinkingCount > 0) parts.push(tr("thinkingCount", { count: thinkingCount }));
  if (toolCount > 0) {
    parts.push(tr("toolCallCount", { count: toolCount, plural: toolCount === 1 ? "" : "s" }));
  }
  if (resultCount > 0) {
    parts.push(tr("resultCount", { count: resultCount, plural: resultCount === 1 ? "" : "s" }));
  }
  if (errorCount > 0) {
    parts.push(tr("errorCount", { count: errorCount, plural: errorCount === 1 ? "" : "s" }));
  }
  const other = regular.length - thinkingCount - toolCount - resultCount - errorCount;
  if (other > 0) parts.push(tr("otherCount", { count: other }));
  if (parts.length === 0) {
    parts.push(
      tr("eventCount", { count: regular.length, plural: regular.length === 1 ? "" : "s" }),
    );
  }
  return parts.join(" · ");
}

// Tool names in order of first use, for the collapsed step header.
function stepTools(regular: StreamEvent[]): string[] {
  const seen: string[] = [];
  for (const e of regular) {
    if (e.kind !== "tool_use") continue;
    const n = toolNameOf(e);
    if (n && !seen.includes(n)) seen.push(n);
  }
  return seen;
}

function elapsedSeconds(now: number, since: number): number {
  return Math.max(0, Math.floor((now - since) / 1000));
}

function nextSecondAt(now: number, since: number): number {
  return since + (elapsedSeconds(now, since) + 1) * 1000;
}

// Schedule against the phase's start, not the previous phase's tick cadence.
function useRenderAt(at: number) {
  const [ticks, tick] = useState(0);
  // Re-arm even at the same deadline if the wall clock moved backward.
  useEffect(() => {
    if (!Number.isFinite(at)) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, at - Date.now()));
    return () => clearTimeout(timer);
  }, [at, ticks]);
}

function useElapsed(since: number | undefined): number {
  const now = Date.now();
  useRenderAt(since == null ? Infinity : nextSecondAt(now, since));
  return since == null ? 0 : elapsedSeconds(now, since);
}

function StepTools({ tools }: { tools: string[] }) {
  const strip = useRef<HTMLSpanElement>(null);
  const track = useRef<HTMLSpanElement>(null);
  const [fadeStart, setFadeStart] = useState(false);
  const [fadeEnd, setFadeEnd] = useState(false);
  const measure = useCallback(() => {
    // A queued resize can arrive after React clears the ref, before effect cleanup.
    const el = strip.current;
    if (!el) return;
    setFadeStart(el.scrollLeft > 1);
    setFadeEnd(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
  }, []);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(strip.current!);
    observer.observe(track.current!);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <span
      className="step-tools"
      ref={strip}
      onScroll={measure}
      tabIndex={fadeStart || fadeEnd ? 0 : undefined}
      data-fade-start={fadeStart || undefined}
      data-fade-end={fadeEnd || undefined}
    >
      <span className="step-tools-track" ref={track}>
        {tools.slice(0, 6).map((t) => (
          <span key={t} className={`event-chip chip-mini ${chipClassFor(t, "tool_use")}`}>
            {chipLabelFor(t)}
          </span>
        ))}
        {tools.length > 6 && <span className="step-tools-more">+{tools.length - 6}</span>}
      </span>
    </span>
  );
}

// Live thinking joins the last box without changing the reader's choice to open it.
function StepBox({
  events,
  live,
  standaloneSince,
  onLoadDetails,
  defaultOpen = false,
}: {
  events: StreamEvent[];
  live?: string;
  standaloneSince?: number;
  onLoadDetails?: () => void;
  defaultOpen?: boolean;
}) {
  const tr = useT();
  const [toggled, setToggled] = useState<boolean | null>(null);
  const hasBody = !!live?.trim() || events.some(hasVisibleEventBody);
  const open = hasBody && (toggled ?? defaultOpen);
  const bottom = useBottomCollapse(open, () => setToggled(false));
  if (events.length === 0 && live == null) return null;
  const toggle = () => {
    if (!open) onLoadDetails?.();
    setToggled(!open);
  };
  const tools = stepTools(events);
  const items = open
    ? events.map((ev, i) => <EventItem key={i} ev={ev} onLoadDetails={onLoadDetails} />)
    : [];
  // The persisted event takes the same slot, preserving state inside its Markdown body.
  if (open && live != null) {
    items.push(
      <EventItem key={events.length} ev={{ kind: "thinking", content: live }} liveThinking />,
    );
  }
  return (
    <div className={`step-group${open ? " open" : ""}`}>
      <div
        className={`step-header${hasBody ? "" : " step-header-static"}`}
        ref={bottom.header}
        {...telemetryTarget(hasBody ? "trace.step_toggle" : undefined)}
        onClick={hasBody ? toggle : undefined}
      >
        {hasBody ? (
          <button
            type="button"
            className="events-toggle trace-header-toggle"
            ref={bottom.toggle}
            aria-expanded={open}
            {...telemetryTarget("trace.step_toggle")}
            aria-label={open ? tr("collapseSteps") : tr("expandSteps")}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="trace-header-placeholder" aria-hidden="true" />
        )}
        {events.length > 0 && <span className="step-summary">{stepSummary(events, tr)}</span>}
        {standaloneSince != null && <StepThinkingStatus since={standaloneSince} />}
        {!open && tools.length > 0 && <StepTools tools={tools} />}
      </div>
      {open && (
        <div className="events-list">
          {items}
          <BottomCollapse
            onClick={bottom.collapse}
            label={tr("collapseStepTrace")}
            action="trace.step_toggle"
          />
        </div>
      )}
    </div>
  );
}

// A segment's events in timeline order: each subagent card and banner is a
// boundary, so the step boxes between them count only what happened there.
type StepTimelineProps = {
  blocks: TimelineBlock[];
  onLoadEvents?: (taskId: string) => void;
  onCancelSubagent?: (taskId: string) => void;
  onLoadDetails?: () => void;
  defaultOpen?: boolean;
  // A thinking block streaming in or between its closing delta and final event.
  live?: string;
  standaloneSince?: number;
};

export function StepGroup({
  group,
  ...props
}: Omit<StepTimelineProps, "blocks"> & { group: { step: number; events: StreamEvent[] } }) {
  return <StepTimeline blocks={timelineBlocks(group.events)} {...props} />;
}

function StepTimeline({
  blocks,
  onLoadEvents,
  onCancelSubagent,
  onLoadDetails,
  defaultOpen = false,
  live,
  standaloneSince,
}: StepTimelineProps) {
  if (live != null && blocks.at(-1)?.kind !== "steps") {
    blocks = [...blocks, { kind: "steps", events: [] }];
  }
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === "steps") {
          return (
            <StepBox
              key={`s${i}`}
              events={block.events}
              live={i === blocks.length - 1 ? live : undefined}
              standaloneSince={i === blocks.length - 1 ? standaloneSince : undefined}
              onLoadDetails={onLoadDetails}
              defaultOpen={defaultOpen}
            />
          );
        }
        return (
          <TimelineBlockItem
            key={timelineBlockKey(block, i)}
            block={block}
            onLoadEvents={onLoadEvents}
            onCancelSubagent={onCancelSubagent}
            onLoadDetails={onLoadDetails}
          />
        );
      })}
    </>
  );
}

type TimelineCard = Exclude<TimelineBlock, { kind: "steps" }>;

function timelineBlockKey(block: TimelineCard, index: number): string {
  return block.kind === "subagent" ? `task-${block.ev.subagent!.taskId}` : `${block.kind}-${index}`;
}

function TimelineBlockItem({
  block,
  onLoadEvents,
  onCancelSubagent,
  onLoadDetails,
}: Pick<StepTimelineProps, "onLoadEvents" | "onCancelSubagent" | "onLoadDetails"> & {
  block: TimelineCard;
}) {
  switch (block.kind) {
    case "banner":
      return <BannerItem ev={block.ev} onLoadDetails={onLoadDetails} />;
    case "action":
      return <PanelActionItem ev={block.ev} action={block.action} onLoadDetails={onLoadDetails} />;
    case "subagent":
      return (
        <SubAgentItem
          ev={block.ev}
          onLoadEvents={onLoadEvents}
          onCancel={onCancelSubagent}
          onLoadDetails={onLoadDetails}
        />
      );
  }
}

function LiveChip({ secs }: { secs: number }) {
  const tr = useT();
  return (
    <span className="event-chip chip-thinking chip-live">
      <span className="streaming-dot" />
      {tr("thinkingTime", { seconds: secs })}
    </span>
  );
}

function StepThinkingStatus({ since }: { since: number }) {
  return <LiveChip secs={useElapsed(since)} />;
}

const CALL_SHOWN_AFTER_S = 3;

function isRunningTool(e: StreamEvent): boolean {
  return (
    e.kind === "tool_use" && e.toolResult == null && e.resultLength == null && e.durationMs == null
  );
}

// A tool call still running or a subagent still working: the turn is not
// waiting on the model.
function workInFlight(events: StreamEvent[]): boolean {
  return events.some(isRunningTool) || hasOutstandingSubagents(events);
}

const WAIT_SHOWN_AFTER_S = 15;

function QuietWait({ since }: { since: number }) {
  const tr = useT();
  const now = Date.now();
  const elapsed = elapsedSeconds(now, since);
  const show = elapsed >= WAIT_SHOWN_AFTER_S;
  useRenderAt(show ? nextSecondAt(now, since) : since + WAIT_SHOWN_AFTER_S * 1000);
  return show ? tr("quietEvents", { seconds: elapsed }) : null;
}

function TurnFooter({
  msg,
  activity,
  detailEvents,
  thinkingInHeader,
}: {
  msg: Message;
  activity?: string | null;
  detailEvents: StreamEvent[];
  thinkingInHeader: boolean;
}) {
  const tr = useT();
  const now = Date.now();
  const thinkingSince = msg.liveThinkingSince;
  let call: StreamEvent | undefined;
  let tickAt = Infinity;
  if (!thinkingInHeader && !activity) {
    for (let i = detailEvents.length - 1; i >= 0; i--) {
      const e = detailEvents[i];
      if (!isRunningTool(e) || e.startedAt == null) continue;
      const showAt = e.startedAt + CALL_SHOWN_AFTER_S * 1000;
      if (showAt <= now) {
        call = e;
        break;
      }
      tickAt = Math.min(tickAt, showAt);
    }
    const since = call?.startedAt ?? thinkingSince;
    if (since != null) tickAt = Math.min(tickAt, nextSecondAt(now, since));
  }
  useRenderAt(tickAt);

  const label =
    activity ||
    (call
      ? `${chipLabelFor(toolNameOf(call) ?? tr("toolFallback"))} · ${formatDuration(elapsedSeconds(now, call.startedAt!) * 1000)}`
      : null);

  return (
    <div className="turn-footer">
      {thinkingInHeader ? null : label ? (
        <span className="turn-activity">{label}</span>
      ) : thinkingSince != null ? (
        <LiveChip secs={elapsedSeconds(now, thinkingSince)} />
      ) : msg.waitingSince != null &&
        !workInFlight(detailEvents) &&
        !detailEvents.some((e) => e.kind === "retry") ? (
        <QuietWait since={msg.waitingSince} />
      ) : null}
    </div>
  );
}

function MessageRenderError() {
  const tr = useT();
  return <div className="message-render-error">{tr("renderError")}</div>;
}

// One broken message (an old persisted event missing a field, an unexpected
// shape) must not blank the whole transcript.
export class MessageBoundary extends Component<
  { children: ReactNode; messageId: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(err: unknown): void {
    console.error("[render] message", this.props.messageId, err);
  }
  render(): ReactNode {
    if (this.state.failed) {
      return <MessageRenderError />;
    }
    return this.props.children;
  }
}

// The server leads an agent's notices with its avatar ("avatars/Alice.jpg
// **Alice** joined the team"): an image, not text to show.
function systemAvatar(content: string): [string | null, string] {
  const m = /^(avatars\/[^\s]+\.(?:jpe?g|png|webp|gif)) (.*)$/is.exec(content);
  return m ? [m[1], m[2]] : [null, content];
}

const DELIVERY_STATUS_DELAY_MS = 350;

function usePendingDeliveryStatus(pending: boolean, messageId: string): boolean {
  const [visibleFor, setVisibleFor] = useState<string>();
  useEffect(() => {
    setVisibleFor(undefined);
    if (!pending) return;
    const timer = setTimeout(() => setVisibleFor(messageId), DELIVERY_STATUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pending, messageId]);
  return pending && visibleFor === messageId;
}

function PendingDeliveryStatus({ label }: { label: string }) {
  return (
    <span className="delivery-inline" role="status">
      <span className="streaming-dot" aria-hidden="true" /> {label}
    </span>
  );
}

export const MessageItem = memo(function MessageItem({
  user = DEFAULT_USER,
  msg,
  agents,
  compact,
  highlight,
  hasStreamingReply,
  onStartingRow,
  onQuote,
  onJumpToMessage,
  onLoadSubagentEvents,
  onCancelSubagent,
  onCancelQueued,
  onLoadDetails,
  onOpenWorkspace,
  onMentionAgent,
  isTurnTail = true,
}: {
  msg: Message;
  agents: AgentInfo[];
  user?: typeof DEFAULT_USER;
  compact?: boolean;
  highlight?: boolean;
  hasStreamingReply?: boolean;
  onStartingRow?: (row: HTMLDivElement | null) => void;
  onOpenWorkspace?: (workspaceId: string) => void;
  onQuote?: (msg: Message) => void;
  onJumpToMessage?: (messageId: string) => void;
  onLoadSubagentEvents?: (messageId: string, taskId: string) => void;
  onCancelSubagent?: (agentId: string, taskId: string) => void;
  onCancelQueued?: (messageId: string) => void;
  onLoadDetails?: (messageId: string) => void;
  onMentionAgent?: (agent: AgentInfo) => void;
  isTurnTail?: boolean;
}) {
  const tr = useT();
  const handleLoadEvents = useCallback(
    (taskId: string) => onLoadSubagentEvents?.(msg.id, taskId),
    [msg.id, onLoadSubagentEvents],
  );
  // Only wired while the message is a summary; once details arrive the
  // prop becomes undefined and the items render their bodies directly.
  const summarized = msg.detail === "summary";
  const handleLoadDetails = useMemo(
    () => (summarized && onLoadDetails ? () => onLoadDetails(msg.id) : undefined),
    [summarized, onLoadDetails, msg.id],
  );
  const outerLinks = useContext(SessionLinkContext);
  const localDayKey = useContext(LocalDayContext);
  const sessionLinks = useMemo(
    () => ({ ...outerLinks, ...(onOpenWorkspace && { open: onOpenWorkspace }) }),
    [outerLinks, onOpenWorkspace],
  );
  const agentId = msg.agentId;
  const handleCancelSubagent = useMemo(
    () =>
      onCancelSubagent && agentId
        ? (taskId: string) => onCancelSubagent(agentId, taskId)
        : undefined,
    [agentId, onCancelSubagent],
  );

  const isUser = msg.kind === "user";
  const starting = isUser && msg.status === "starting";
  const sending = isUser && msg.status === "dispatching";
  // Starting and dispatching share one delay even though they render in different rows.
  const showDelivery = usePendingDeliveryStatus(starting || sending, msg.id);
  const showStarting = showDelivery && starting && !hasStreamingReply;
  const target = showStarting ? agents.find((a) => a.id === msg.queuedFor) : undefined;

  if (msg.kind === "system") {
    const [avatar, text] = systemAvatar(msg.content);
    return (
      <div className="system-message">
        {avatar && <img className="system-avatar" src={avatar} alt="" />}
        <MdBlock>{text}</MdBlock>
      </div>
    );
  }

  const from = isUser ? msg.from : undefined;
  const agent = !isUser ? agents.find((a) => a.id === msg.agentId) : null;
  const streaming = msg.status === "streaming";
  const showMentionAction =
    !isUser && !streaming && !!agent && agents.length > 1 && isTurnTail && !!onMentionAgent;
  const deliveryClass =
    msg.status === "queued"
      ? " message-queued"
      : msg.status === "outcome_unknown"
        ? " message-outcome-unknown"
        : msg.status === "error"
          ? " message-error"
          : "";
  const events = msg.events ?? [];
  const detailEvents = events.filter(
    (e) => e.kind !== "text" && e.kind !== "text_delta" && e.kind !== "thinking_delta",
  );

  // Interleaved segments, using contentOffset to split msg.content. One
  // layout whatever has arrived so far: switching shapes when the first text
  // lands would remount the step boxes and fold whatever the reader opened.
  type Segment = { text: string; events: StreamEvent[] };
  const segments: Segment[] = [];
  const body = msg.content ?? "";
  // A thinking block that starts now lands at the current end of the text:
  // with the last events if no text followed them.
  let joinsLastEvents = false;
  if (!isUser && detailEvents.length === 0 && body) {
    segments.push({ text: body, events: [] });
  } else if (!isUser && detailEvents.length > 0) {
    // Events without an offset (older logs, error events) belong after all
    // the text rather than nowhere; subagent lifecycle events always sit
    // with their subagent_start so a task never splits across segments.
    const startOffsets = new Map<string, number>();
    for (const e of detailEvents) {
      if (e.kind === "subagent_start" && e.subagent?.taskId && e.contentOffset != null) {
        startOffsets.set(e.subagent.taskId, e.contentOffset);
      }
    }
    // Older logs carry no offsets at all: those events all happened before
    // the answer, so they go first, not after it. Within newer logs an event
    // without one (errors, some notices) sits with the event before it.
    const anyOffset = detailEvents.some((e) => e.contentOffset != null);
    const resolved = new Map<StreamEvent, number>();
    let last = 0;
    for (const e of detailEvents) {
      const taskId = e.subagent?.taskId;
      const own = taskId && startOffsets.has(taskId) ? startOffsets.get(taskId)! : e.contentOffset;
      const off = !anyOffset ? 0 : (own ?? last);
      resolved.set(e, off);
      last = off;
    }
    const offsetOf = (e: StreamEvent): number => resolved.get(e) ?? 0;
    const uniqueOffsets = [...new Set(detailEvents.map(offsetOf))].sort((a, b) => a - b);

    if (uniqueOffsets.length > 0) {
      let prevOff = 0;
      for (const off of uniqueOffsets) {
        const text = body.substring(prevOff, off).trim();
        const evtsAtOff = detailEvents.filter((e) => offsetOf(e) === off);
        segments.push({ text, events: evtsAtOff });
        prevOff = off;
      }
      const trailing = body.substring(prevOff).trim();
      if (trailing || streaming) {
        segments.push({ text: trailing, events: [] });
      }
      joinsLastEvents = body.length === prevOff;
    }
  }

  let tailAt = -1;
  if (!isUser && streaming) {
    if (segments.length === 0) segments.push({ text: "", events: [] });
    tailAt = joinsLastEvents ? segments.length - 2 : segments.length - 1;
  }
  const liveSince = msg.liveThinkingSince;
  const liveBlock = liveSince != null ? (msg.liveThinking ?? "") : msg.closingThinking;
  const tailBlocks = tailAt >= 0 ? timelineBlocks(segments[tailAt].events) : [];
  const standaloneSince = tailBlocks.at(-1)?.kind === "steps" ? undefined : liveSince;

  const time = formatMessageTime(
    msg.timestamp,
    localDayKey ? parseLocalDayKey(localDayKey) : Date.now(),
  );
  const timeTitle = formatFullDateTime(msg.timestamp);

  const quoteButton =
    !isUser && onQuote && segments.length > 0 ? (
      <button className="btn-quote" title={tr("quoteMessage")} onClick={() => onQuote(msg)}>
        ↩
      </button>
    ) : null;

  const forward = msg.forwardRef;
  const jump = forward?.messageId && onJumpToMessage;
  const ForwardRef = jump ? "button" : "div";

  return (
    <SessionLinkContext.Provider value={sessionLinks}>
      <TurnRunningContext.Provider value={streaming}>
        <div
          id={`msg-${msg.id}`}
          tabIndex={-1}
          className={`message${isUser ? " message-user" : " message-agent"}${compact ? " message-compact" : ""}${highlight ? " message-highlight" : ""}${deliveryClass}`}
        >
          <div className="message-gutter">
            {compact ? null : from ? (
              <div className="avatar-user avatar-from">{ORIGIN_GLYPH[from.role]}</div>
            ) : isUser ? (
              <div className="avatar-user">
                {isImageAvatar(user.avatar) ? (
                  <img
                    src={user.avatar}
                    alt={user.name}
                    style={{
                      width: "100%",
                      height: "100%",
                      borderRadius: "50%",
                      objectFit: "cover",
                    }}
                  />
                ) : (
                  user.avatar
                )}
              </div>
            ) : agent ? (
              <AgentAvatar agent={agent} size={32} />
            ) : (
              <div className="avatar-user">?</div>
            )}
          </div>
          <div className="message-body">
            {!compact && (
              <div className="message-header">
                {isUser ? (
                  <>
                    {from ? (
                      <button
                        className="message-author from-author"
                        title={tr("openThatSession")}
                        onClick={() => onOpenWorkspace?.(from.workspaceId)}
                      >
                        {originLabel(from)}
                      </button>
                    ) : (
                      <span className="message-author user-author" title={user.name}>
                        {user.name}
                      </span>
                    )}
                    {msg.status === "queued" && (
                      <span
                        className="queued-badge"
                        title={msg.steering ? tr("sentRunning") : undefined}
                      >
                        {tr("queuedBadge")}
                        {onCancelQueued && !msg.steering && (
                          <button
                            className="queued-cancel"
                            title={tr("removeQueue")}
                            onClick={() => onCancelQueued(msg.id)}
                          >
                            ✕
                          </button>
                        )}
                      </span>
                    )}
                  </>
                ) : agent ? (
                  <>
                    <span className="message-author" style={{ color: agentNameColor(agent.color) }}>
                      {agent.name}
                    </span>
                    {(() => {
                      const modelLabel = shortModel(msg.model ?? agent.model);
                      return (
                        <span className="message-model" title={modelLabel}>
                          {modelLabel}
                        </span>
                      );
                    })()}
                  </>
                ) : null}
                <span className="message-time" title={timeTitle}>
                  {time}
                </span>
                {isUser && msg.status !== "queued" && (
                  <span className="delivery-inline-slot">
                    {sending && showDelivery && <PendingDeliveryStatus label={tr("sending")} />}
                  </span>
                )}
                {streaming && <span className="streaming-dot" />}
                {!streaming && quoteButton}
              </div>
            )}
            {compact && (
              <div className="compact-header">
                <span className="message-time" title={timeTitle}>
                  {time}
                </span>
                {streaming && <span className="streaming-dot" />}
                {!streaming && quoteButton}
              </div>
            )}
            {!isUser && <MessageStatus msg={msg} />}

            {msg.status === "outcome_unknown" && (
              <div className="delivery-status delivery-outcome-unknown" role="alert">
                <strong>{tr("deliveryUnknown")}</strong> {tr("deliveryUnknownBody")}
              </div>
            )}

            {forward && (
              <ForwardRef
                className="forward-ref"
                {...(jump && {
                  type: "button" as const,
                  title: tr("jumpQuoted"),
                  "aria-label": tr("jumpQuotedFrom", {
                    author: forward.fromAgent,
                    preview: forward.preview,
                  }),
                  onClick: () => jump(forward.messageId),
                })}
              >
                <span className="forward-ref-icon">↩</span>
                <span className="forward-ref-agent">
                  <Avatar
                    avatar={forward.fromAvatar}
                    color={agents.find((a) => a.name === forward.fromAgent)?.color ?? "transparent"}
                    name={forward.fromAgent}
                    size={16}
                  />
                  {forward.fromAgent}
                </span>
                <span className="forward-ref-preview">{forward.preview}</span>
              </ForwardRef>
            )}

            {msg.images && msg.images.length > 0 && (
              <div className="msg-images">
                {msg.images.map((img, i) => (
                  <a key={i} href={img.url} target="_blank" rel="noopener noreferrer">
                    <img src={img.url} alt={img.name} />
                  </a>
                ))}
              </div>
            )}

            {isUser
              ? msg.content && (
                  <div className="message-content" onCopy={copySelectionAsMarkdown}>
                    {renderMentionContent(msg.content, agents)}
                  </div>
                )
              : segments.length > 0 && (
                  <div className="message-content" onCopy={copySelectionAsMarkdown}>
                    {segments.map((seg, si) => (
                      <div key={si}>
                        {seg.text &&
                          (streaming ? (
                            <StreamingMdBlock>{seg.text}</StreamingMdBlock>
                          ) : (
                            <MdBlock>{seg.text}</MdBlock>
                          ))}
                        {(seg.events.length > 0 || si === tailAt) && (
                          <StepTimeline
                            blocks={si === tailAt ? tailBlocks : timelineBlocks(seg.events)}
                            onLoadEvents={handleLoadEvents}
                            onCancelSubagent={handleCancelSubagent}
                            onLoadDetails={handleLoadDetails}
                            live={si === tailAt ? liveBlock : undefined}
                            standaloneSince={si === tailAt ? standaloneSince : undefined}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
            {!isUser && streaming && (
              <TurnFooter
                msg={msg}
                activity={agent?.activity}
                detailEvents={detailEvents}
                thinkingInHeader={standaloneSince != null}
              />
            )}
            {showMentionAction && (
              <div className="message-footer-actions">
                <button
                  type="button"
                  className="btn-mention-agent"
                  data-agent-id={agent.id}
                  title={tr("replyToAgent", { name: agent.name })}
                  aria-label={tr("replyToAgent", { name: agent.name })}
                  onClick={() => onMentionAgent(agent)}
                >
                  <span className="btn-mention-at" aria-hidden="true">
                    @
                  </span>
                  <span className="btn-mention-name">{agent.name}</span>
                </button>
              </div>
            )}
          </div>
        </div>
        {showStarting && (
          <div className="message message-agent message-starting" ref={onStartingRow}>
            <div className="message-gutter">
              {target ? (
                <AgentAvatar agent={target} size={32} />
              ) : (
                <div className="avatar-user">?</div>
              )}
            </div>
            <div className="message-body">
              <div className="message-header">
                <span
                  className="message-author"
                  title={target?.name}
                  style={target ? { color: agentNameColor(target.color) } : undefined}
                >
                  {target?.name ?? tr("startingAgentFallback")}
                </span>
                <PendingDeliveryStatus label={tr("starting")} />
              </div>
            </div>
          </div>
        )}
      </TurnRunningContext.Provider>
    </SessionLinkContext.Provider>
  );
});
