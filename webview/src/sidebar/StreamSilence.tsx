import { useEffect, useId, useState } from "react";
import type { Workspace } from "../state/useServer";
import { agentQueues } from "../workspace/agents";

export const SILENCE_MS = 120_000;

// A timestamp comes from the same turn stream on a fresh snapshot and live.
// Do not invent a start time from when the browser opened the session.
export function StreamSilence({ workspace }: { workspace: Workspace }) {
  const busy = workspace.agents.filter((a) => a.busy || agentQueues(a));
  const queued = workspace.queued ? <span className="session-silence">Queued</span> : null;
  if (!busy.length || busy.some((a) => a.lastStreamAt == null)) return queued;
  const since = Math.max(...busy.map((a) => a.lastStreamAt!));
  return <ElapsedSilence key={since} since={since} queued={queued} />;
}

function ElapsedSilence({ since, queued }: { since: number; queued: React.ReactNode }) {
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
  const detail = `No new events for ${Math.floor(elapsed / 1000)}s`;
  const refresh = () => tick((n) => n + 1);
  return (
    <span
      className="session-silence session-silence-quiet"
      tabIndex={0}
      title={detail}
      aria-label={`Quiet: ${detail}`}
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
      Quiet
      {focused && (
        <span id={tipId} role="tooltip" className="session-silence-tip">
          {detail}
        </span>
      )}
    </span>
  );
}
