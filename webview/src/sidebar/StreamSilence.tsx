import { useEffect, useState } from "react";
import type { Workspace } from "../state/useServer";
import { agentQueues } from "../workspace/agents";

export const SILENCE_MS = 15_000;

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
  const [, tick] = useState(0);
  const elapsed = Date.now() - since;
  const next = elapsed < SILENCE_MS ? SILENCE_MS - elapsed : 1000 - (elapsed % 1000);
  useEffect(() => {
    const timer = setTimeout(() => tick((n) => n + 1), next);
    return () => clearTimeout(timer);
  });
  if (elapsed < SILENCE_MS) return queued;
  const label = `No new events for ${Math.floor(elapsed / 1000)}s`;
  return (
    <span className="session-silence" title={label}>
      {label}
    </span>
  );
}
