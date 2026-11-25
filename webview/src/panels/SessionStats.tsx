import { useEffect, useState } from "react";
import type { SessionStatsPage, StatsStep, StatsTurn } from "../../../shared/session-stats";
import { formatFullDateTime, formatRunTime } from "../format";
import type { Workspace } from "../state/useServer";
import { telemetryTarget } from "../telemetryEvents";

const PAGE_SIZE = 20;
const turnKey = (turn: StatsTurn) => turn.key ?? turn.turnId;
const stepLabels: Record<StatsStep["kind"], string> = {
  model: "Model",
  user: "User",
  tool: "Tool",
  compaction: "Compaction",
};

function duration(start?: number, end?: number): string | undefined {
  if (start === undefined || end === undefined || !Number.isFinite(end - start) || end < start)
    return undefined;
  return formatRunTime(end - start);
}

function StatField({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value ?? "—"}</dd>
    </div>
  );
}

export function SessionStatsStepInspector({ step }: { step: StatsStep }) {
  const { kind, promptDelta } = step;
  return (
    <details className="session-stats-step">
      <summary {...telemetryTarget("stats.step_toggle")}>{stepLabels[kind]}</summary>
      <dl className="session-stats-fields">
        <StatField label="Step ID" value={step.stepId} />
        {(kind === "user" || step.trigger !== undefined) && (
          <StatField label="Trigger" value={step.trigger} />
        )}
        {kind === "model" && (
          <>
            <StatField label="Model" value={step.model} />
            <StatField label="Inference ID" value={step.inferenceId} />
            <StatField label="Prompt tokens" value={step.promptTokens?.toLocaleString()} />
            <StatField
              label="Prompt delta"
              value={
                promptDelta === undefined
                  ? undefined
                  : `${promptDelta > 0 ? "+" : ""}${promptDelta.toLocaleString()}`
              }
            />
            <StatField
              label="Time to first delta"
              value={duration(step.stepStart, step.firstDelta)}
            />
            <StatField label="Step duration" value={duration(step.stepStart, step.stepEnd)} />
          </>
        )}
        {(kind === "model" || step.boundary !== undefined) && (
          <StatField label="Boundary" value={step.boundary} />
        )}
        {kind === "tool" && (
          <>
            <StatField label="Tool call ID" value={step.toolCallId} />
            <StatField label="Tool duration" value={duration(step.toolStart, step.toolResult)} />
          </>
        )}
        {(kind === "compaction" || step.compaction !== undefined) && (
          <StatField
            label="Compacted at (native or observed)"
            value={step.compaction === undefined ? undefined : formatFullDateTime(step.compaction)}
          />
        )}
      </dl>
    </details>
  );
}

export function SessionStats({
  workspaceId,
  connected,
  agents,
}: {
  workspaceId: string;
  connected: boolean;
  agents: Workspace["agents"];
}) {
  const [previous, setPrevious] = useState({ connected, agents, generation: 0 });
  if (previous.connected !== connected || previous.agents !== agents) {
    const settled = previous.agents.some(
      (agent) => agent.busy && agents.some((current) => current.id === agent.id && !current.busy),
    );
    // New turns can move the offset of every page; restart at the newest page.
    const refresh = connected && (!previous.connected || settled);
    setPrevious({ connected, agents, generation: previous.generation + (refresh ? 1 : 0) });
  }
  return <SessionStatsPages key={previous.generation} workspaceId={workspaceId} />;
}

function SessionStatsPages({ workspaceId }: { workspaceId: string }) {
  const [request, setRequest] = useState({ offset: 0 });
  const [result, setResult] = useState<{
    turns: StatsTurn[];
    total: number;
    nextOffset: number;
    status: "loading" | "ready" | "error";
  }>({ turns: [], total: 0, nextOffset: 0, status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    fetch(
      `api/workspaces/${encodeURIComponent(workspaceId)}/stats?offset=${request.offset}&limit=${PAGE_SIZE}`,
      {
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const page = (await response.json()) as SessionStatsPage;
        if (controller.signal.aborted) return;
        setResult((previous) => {
          const seen = new Set(previous.turns.map(turnKey));
          const older = page.turns.filter((turn) => {
            const key = turnKey(turn);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          return {
            turns: [...previous.turns, ...older],
            total: page.total,
            nextOffset: page.turns.length ? page.offset + page.turns.length : page.total,
            status: "ready",
          };
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult((previous) => ({ ...previous, status: "error" }));
      });
    return () => controller.abort();
  }, [request, workspaceId]);

  function load(offset: number) {
    setResult((previous) => ({ ...previous, status: "loading" }));
    setRequest({ offset });
  }

  const { turns, total, nextOffset, status } = result;
  return (
    <div className="session-stats">
      <p>
        <strong>Observed timing:</strong> Durations are based on server-observed lifecycle events,
        not provider billing latency.
      </p>
      {turns.length > 0 && (
        <>
          <p role="status">
            {turns.length} of {total} turns · Newest first
          </p>
          {turns.map((turn, index) => (
            <details key={turnKey(turn)} className="session-stats-turn">
              <summary {...telemetryTarget("stats.turn_toggle")}>
                Turn {total - index} · {turn.trigger} · {turn.steps.length}{" "}
                {turn.steps.length === 1 ? "step" : "steps"}
              </summary>
              <dl className="session-stats-fields session-stats-turn-id">
                <StatField label="Turn ID" value={turn.turnId} />
                {turn.source !== undefined && <StatField label="Source" value={turn.source} />}
                {turn.sessionId !== undefined && (
                  <StatField label="Session ID" value={turn.sessionId} />
                )}
              </dl>
              {turn.steps.length ? (
                <ol className="session-stats-steps">
                  {turn.steps.map((step) => (
                    <li key={step.stepId}>
                      <SessionStatsStepInspector step={step} />
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No steps recorded.</p>
              )}
            </details>
          ))}
        </>
      )}
      {status === "loading" && <p role="status">Loading session stats…</p>}
      {status === "error" && (
        <>
          <p role="alert">Could not load session stats.</p>
          <button className="panel-btn" onClick={() => load(request.offset)}>
            Retry
          </button>
        </>
      )}
      {status === "ready" && turns.length === 0 && <p>No session stats recorded.</p>}
      {status !== "error" && nextOffset < total && (
        <button
          className="panel-btn"
          disabled={status === "loading"}
          {...telemetryTarget("stats.load_more")}
          onClick={() => load(nextOffset)}
        >
          Load older turns
        </button>
      )}
    </div>
  );
}
