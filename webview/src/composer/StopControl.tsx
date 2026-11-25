import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "../panels/Icon";
import { useT } from "../i18n/chat";
import type { AgentInfo } from "../state/useServer";

export function StopControl({
  busyAgents,
  onStop,
}: {
  busyAgents: AgentInfo[];
  onStop: (agentIds: string[]) => void;
}) {
  const tr = useT();
  if (busyAgents.length === 0) return null;
  if (busyAgents.length === 1) {
    const agent = busyAgents[0];
    return (
      <button
        type="button"
        className="btn-abort"
        aria-label={tr("stopAgent", { name: agent.name })}
        title={tr("stopAgentTitle", { name: agent.name })}
        aria-description={tr("stopAgentDescription")}
        onClick={() => onStop([agent.id])}
      >
        <Icon name="stop" />
        <span className="stop-label" aria-hidden="true">
          Stop
        </span>
      </button>
    );
  }
  return <StopPopover busyAgents={busyAgents} onStop={onStop} />;
}

function StopPopover({
  busyAgents,
  onStop,
}: {
  busyAgents: AgentInfo[];
  onStop: (agentIds: string[]) => void;
}) {
  const tr = useT();
  const id = useId();
  const [mode, setMode] = useState<"hover" | "pinned" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const count = busyAgents.length;

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!mode) return;
    const outside = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      clearTimeout(timer.current);
      setMode(null);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      clearTimeout(timer.current);
      if (root.current?.contains(document.activeElement)) trigger.current?.focus();
      setMode(null);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [mode]);

  function stop(agents: AgentInfo[]) {
    clearTimeout(timer.current);
    trigger.current?.focus();
    setMode(null);
    onStop(agents.map((agent) => agent.id));
  }

  function navigate(event: KeyboardEvent) {
    if (!mode || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    const actions = Array.from(panel.current?.querySelectorAll("button") ?? []);
    const index = actions.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? index + 1 : index < 0 ? -1 : index - 1;
    event.preventDefault();
    actions[(next + actions.length) % actions.length]?.focus();
  }

  return (
    <div
      ref={root}
      className="composer-stop"
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse" || !window.matchMedia?.("(hover: hover)").matches) return;
        clearTimeout(timer.current);
        if (!mode) timer.current = setTimeout(() => setMode("hover"), 150);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        clearTimeout(timer.current);
        if (mode === "hover") {
          timer.current = setTimeout(() => {
            if (!panel.current?.contains(document.activeElement)) setMode(null);
          }, 180);
        }
      }}
      onBlur={(event) => {
        // Presses on the bridge or scrollbar can blur without moving focus.
        if (!event.relatedTarget || event.currentTarget.contains(event.relatedTarget)) return;
        clearTimeout(timer.current);
        setMode(null);
      }}
      onKeyDown={navigate}
    >
      <button
        ref={trigger}
        type="button"
        className="btn-abort"
        aria-label={tr("stopRunningAgents", { count })}
        title={tr("chooseTurnsToStop")}
        aria-description={tr("chooseTurnsToStopDescription")}
        aria-expanded={!!mode}
        aria-controls={mode ? id : undefined}
        onClick={() => {
          clearTimeout(timer.current);
          setMode(mode === "pinned" ? null : "pinned");
        }}
      >
        <Icon name="stop" />
        <span className="stop-count" aria-hidden="true">
          {count}
        </span>
      </button>
      {mode && (
        <div className="stop-popover">
          <div
            ref={panel}
            id={id}
            className="stop-actions"
            role="group"
            aria-label={tr("stopRunningTurns")}
          >
            {busyAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                title={tr("stopAgentTitle", { name: agent.name })}
                onClick={() => stop([agent])}
              >
                {tr("stopAgent", { name: agent.name })}
              </button>
            ))}
            <button type="button" title={tr("stopAllTurnsTitle")} onClick={() => stop(busyAgents)}>
              {tr("stopAll", { count })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
