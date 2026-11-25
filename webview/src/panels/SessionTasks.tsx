import { useEffect, useState } from "react";
import { isZh } from "../i18n";
import { tPanel, usePanelT, type PanelMessageKey } from "../i18n/panels";
import type { AgentInfo, Workspace } from "../state/useServer";
import { agentState } from "../workspace/agents";
import { formatDuration } from "../format";

export interface TaskActions {
  onStopTask: (workspaceId: string, agentId: string, taskId: string) => void;
  onCancelWake: (workspaceId: string, agentId: string) => void;
  onStopAll: (workspaceId: string) => void;
}

const TYPE_LABEL_KEY: Record<string, PanelMessageKey> = {
  local_bash: "taskTypeShell",
  local_agent: "taskTypeAgent",
  monitor: "taskTypeMonitor",
};

// Work an agent has going on outside its turns: background commands and
// agents, each with its own stop, and a scheduled wake-up. The chat's Stop
// ends a turn and leaves all of this running.
export function AgentTasks({
  session: w,
  agent: a,
  actions,
}: {
  session: Workspace;
  agent: AgentInfo;
  actions: TaskActions;
}) {
  const t = usePanelT();
  const now = useNow(1000);
  return (
    <div className="tp-tasks">
      {(a.backgroundTasks ?? []).map((task) => {
        const typeKey = TYPE_LABEL_KEY[task.type];
        return (
          <div key={task.id} className="tp-task">
            <span className={`tp-type t-${task.type}`}>{typeKey ? t(typeKey) : task.type}</span>
            <span className="tp-desc" title={task.description}>
              {task.description || task.id}
            </span>
            {task.since > 0 && <span className="tp-when">{elapsed(now - task.since)}</span>}
            {task.cancellable !== false && (
              <button
                className="panel-btn danger tp-stop"
                aria-label={t("taskStopLabel", { target: task.description || task.id })}
                onClick={() => actions.onStopTask(w.id, a.id, task.id)}
              >
                {t("stop")}
              </button>
            )}
          </div>
        );
      })}
      {a.wake && (
        <div className="tp-task tp-wake">
          <span className="tp-type t-wake">{t("taskTypeWakeUp")}</span>
          <span className="tp-desc" title={a.wake.reason}>
            {a.wake.reason || t("taskScheduledWakeUp")}
          </span>
          <span className="tp-when">
            {clock(a.wake.at)} ·{" "}
            {a.wake.at > now ? t("taskWakeIn", { time: soon(a.wake.at - now) }) : t("taskWakeDue")}
          </span>
          {canCancelWake(a) && (
            <button
              className="panel-btn danger tp-stop"
              title={t("taskCancelWakeTitle")}
              onClick={() => actions.onCancelWake(w.id, a.id)}
            >
              {t("cancel")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// A wake-up is cancelled by closing the CLI process: not while a turn runs
// in it, nor while background tasks do (the server refuses both).
function canCancelWake(a: AgentInfo): boolean {
  return agentState(a) !== "working" && (a.backgroundTasks?.length ?? 0) === 0;
}

export function hasWork(a: AgentInfo): boolean {
  return (a.backgroundTasks?.length ?? 0) > 0 || !!a.wake;
}

export function workCount(sessions: Workspace[]): number {
  let n = 0;
  for (const w of sessions) {
    if (w.archivedAt != null) continue;
    for (const a of w.agents) n += (a.backgroundTasks?.length ?? 0) + (a.wake ? 1 : 0);
  }
  return n;
}

// Whole seconds: a clock ticking every second should not flicker tenths.
function elapsed(ms: number): string {
  return formatDuration(Math.max(0, Math.round(ms / 1000) * 1000));
}

// A countdown to the minute; seconds only in the last one.
export function soon(ms: number): string {
  if (ms < 60_000) {
    if (!isZh()) return elapsed(ms);
    const secs = Math.max(0, Math.round(ms / 1000));
    return secs < 60 ? tPanel("durationSeconds", { secs }) : tPanel("durationMinutes", { mins: 1 });
  }
  const mins = Math.ceil(ms / 60_000);
  return mins < 60
    ? tPanel("durationMinutes", { mins })
    : tPanel("durationHoursMinutes", { hours: Math.floor(mins / 60), mins: mins % 60 });
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// The time, refreshed every `ms` while mounted (elapsed times, countdowns).
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
