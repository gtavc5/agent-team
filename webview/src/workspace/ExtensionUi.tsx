import type { Placement } from "../../../shared/extension-ui";
import type { LiveUi, LiveNotice } from "../state/extensionUi";
import type { Workspace } from "../state/useServer";

// In flow on both sides of the composer, never overlay its controls. Extension
// output is terminal text, not a chat message or trusted rich content.
export function ExtensionUi({
  workspace,
  ui,
  placement,
  dismiss,
}: {
  workspace: Workspace;
  ui: LiveUi;
  placement: Placement;
  dismiss: (n: LiveNotice) => void;
}) {
  const above = placement === "aboveEditor";
  const nodes = workspace.agents.flatMap((agent) => {
    const state = ui.agents.find((a) => a.workspaceId === workspace.id && a.agentId === agent.id);
    if (!state) return [];
    const notices = above
      ? ui.notices.filter(
          (n) =>
            n.workspaceId === workspace.id &&
            n.agentId === agent.id &&
            n.processGeneration === state.processGeneration,
        )
      : [];
    const statuses = above ? state.statuses.filter((s) => s.text) : [];
    const widgets = state.widgets.filter((w) => w.placement === placement && w.lines.length);
    if (!notices.length && !statuses.length && !widgets.length) return [];
    return (
      <section key={agent.id} aria-label={`${agent.name} extension UI`}>
        <strong>{agent.name}</strong>
        {notices.map((n) => (
          <div role="status" key={n.id} className={`extension-notice ${n.level}`}>
            <span>{n.message}</span>
            <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(n)}>
              ×
            </button>
          </div>
        ))}
        {statuses.map((s) => (
          <span className="extension-status" key={s.key}>
            {s.text}
          </span>
        ))}
        {widgets.map((w) => (
          <div className="extension-widget" key={w.key}>
            {w.lines.join("\n")}
          </div>
        ))}
      </section>
    );
  });
  return nodes.length ? (
    <div className="extension-ui" data-placement={placement}>
      {nodes}
    </div>
  ) : null;
}
