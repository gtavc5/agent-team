import type { PiSubagentWidgetNode } from "./pi-subagent-widget";
import type { StreamEvent } from "./types";

type NodeFacts = {
  status: PiSubagentWidgetNode["state"];
  model?: string;
  effort?: string;
  summary?: string;
  lastTool?: string;
  startedAt?: number;
  durationMs?: number;
};

export interface PiSubagentTreeState {
  ownerTaskId: string;
  nodes: Record<string, NodeFacts>;
}

function isTerminal(status: NodeFacts["status"]): boolean {
  return status !== "queued" && status !== "running";
}

function changed(previous: NodeFacts | undefined, next: NodeFacts): boolean {
  return (
    !previous ||
    previous.status !== next.status ||
    previous.model !== next.model ||
    previous.effort !== next.effort ||
    previous.summary !== next.summary ||
    previous.lastTool !== next.lastTool ||
    previous.durationMs !== next.durationMs ||
    previous.startedAt !== next.startedAt
  );
}

/** Deltas for an already-owned card, whose transcript must be restored alongside these facts. */
export function projectPiSubagentTree(
  taskId: string,
  children: readonly PiSubagentWidgetNode[] | undefined,
  previous?: PiSubagentTreeState,
): { state: PiSubagentTreeState; events: StreamEvent[] } {
  const prior = previous?.ownerTaskId === taskId ? previous : { ownerTaskId: taskId, nodes: {} };
  let state = prior;
  const events: StreamEvent[] = [];

  function remember(id: string, facts: NodeFacts) {
    if (state === prior) state = { ownerTaskId: taskId, nodes: { ...prior.nodes } };
    state.nodes[id] = facts;
  }

  function visit(
    nodes: readonly PiSubagentWidgetNode[],
    path: readonly (readonly [PiSubagentWidgetNode["kind"], string])[],
    emit: (event: StreamEvent) => void,
  ) {
    const siblings = nodes.map((node) => {
      const nodePath = [...path, [node.kind, node.id] as const];
      // Producer IDs are local to a branch; positions may change or be omitted.
      const id = `pi-subagent-tree:${JSON.stringify([taskId, nodePath])}`;
      return { node, nodePath, id };
    });
    const counts = new Map<string, number>();
    for (const { id } of siblings) counts.set(id, (counts.get(id) ?? 0) + 1);

    for (const { node, nodePath, id } of siblings) {
      if (counts.get(id) !== 1) continue;
      const before = state.nodes[id];
      if (node.kind === "host-step") {
        if (before?.status !== node.state) {
          remember(id, { status: node.state });
          emit({
            kind: "notice",
            level: "info",
            toolUseId: `pi-host-step:${id}`,
            content: `Host step: ${node.label} (${node.state})`,
          });
        }
        continue;
      }

      // Nested folding cannot reopen a terminal lifecycle. Resume is a new execution.
      const status =
        before && isTerminal(before.status) && !isTerminal(node.state) ? before.status : node.state;
      const startedAt = node.startedAt ?? before?.startedAt;
      const durationMs =
        isTerminal(status) &&
        startedAt !== undefined &&
        node.endedAt !== undefined &&
        node.endedAt >= startedAt
          ? node.endedAt - startedAt
          : before?.durationMs;
      const facts: NodeFacts = {
        status,
        model: node.model ?? before?.model,
        effort: node.thinking ?? before?.effort,
        summary: node.progressText ?? before?.summary,
        lastTool: node.activity?.currentTool ?? before?.lastTool,
        startedAt,
        durationMs,
      };
      if (changed(before, facts)) {
        remember(id, facts);
        const { startedAt, ...meta } = facts;
        const subagent = { ...meta, taskId: id, description: node.label, cancellable: false };
        if (!before) emit({ kind: "subagent_start", content: "", startedAt, subagent });
        else
          emit({
            kind: isTerminal(status) ? "subagent_done" : "subagent_progress",
            content: "",
            subagent,
          });
      }
      if (node.children?.length) {
        visit(node.children, nodePath, (_innerEvent) =>
          emit({
            kind: "subagent_progress",
            content: "",
            subagent: { taskId: id, description: "", cancellable: false, _innerEvent },
          }),
        );
      }
    }
  }

  if (children?.length) visit(children, [], (event) => events.push(event));
  return { state, events };
}
