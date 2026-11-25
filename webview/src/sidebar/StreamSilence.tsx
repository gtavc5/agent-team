import { useEffect, useId, useState } from "react";
import { useT } from "../i18n/chat";
import { useWorkspaceT } from "../i18n/workspace";
import type { Workspace } from "../state/useServer";
import { agentQueues } from "../workspace/agents";

export const SILENCE_MS = 120_000;

// A timestamp comes from the same turn stream on a fresh snapshot and live.
// Do not invent a start time from when the browser opened the session.
export function StreamSilence({ workspace }: { workspace: Workspace }) {
  const tr = useWorkspaceT();
  const busy = workspace.agents.filter((a) => a.busy || agentQueues(a));
  const queued = workspace.queued ? (
    <span className="session-silence">{tr("queuedSession")}</span>
  ) : null;
  if (!busy.length || busy.some((a) => a.lastStreamAt == null)) return queued;
  const since = Math.max(...busy.map((a) => a.lastStreamAt!));
  return <ElapsedSilence key={since} since={since} queued={queued} />;
}

function ElapsedSilence({ since, queued }: { since: number; queued: React.ReactNode }) {
  const tr = useWorkspaceT();
  const chat = useT();
  const [ticks, tick] = useState(0);
  const [focused, setFocused] = useState(false);
  const tipId = useId();
  const elapsed = Date.now() - since;
  const quiet = elapsed >= SILENCE_MS;
  useEffect(() => {
    if (quiet) return;
    // Schedule one wake-up for crossing SILENCE_MS; re-arm only if the timer fired early.
    const remaining = Math.max(0, SILENCE_MS - (Date.now() - since));
    const timer = setTimeout(() => tick((n) => n + 1), remaining);
    return () => clearTimeout(timer);
  }, [since, quiet, ticks]);
  useEffect(() => {
    if (!quiet) setFocused(false);
  }, [quiet]);
  if (!quiet) return queued;
  const detail = chat("quietEvents", { seconds: Math.floor(elapsed / 1000) });
  const refresh = () => tick((n) => n + 1);
  return (
    <span
      className="session-silence session-silence-quiet"
      tabIndex={0}
      title={detail}
      aria-label={tr("quietSessionDetail", { detail })}
      aria-describedby={focused ? tipId : undefined}
      onPointerEnter={refresh}
      onFocus={() => {
        refresh();
        setFocused(true);
      }}
      onBlur={() => setFocused(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.currentTarget.blur();
      }}
    >
      {tr("quietSession")}
      {focused && (
        <span id={tipId} role="tooltip" className="session-silence-tip">
          {detail}
        </span>
      )}
    </span>
  );
}
