// Live-only WebSocket protocol. Both ends fold ordered deltas with the same
// bounds and eviction order, so a snapshot is equivalent to replay.
export interface UiOwner {
  workspaceId: string;
  agentId: string;
  processGeneration: number;
}
export type Placement = "aboveEditor" | "belowEditor";
export type Notice = {
  kind: "notify";
  id: string;
  level: "info" | "warning" | "error";
  message: string;
};
export type UiChange =
  | Notice
  | { kind: "reset" }
  | { kind: "status"; key: string; text?: string }
  | { kind: "widget"; key: string; placement: Placement; lines?: string[] };
export interface ExtensionUiEvent extends UiOwner {
  change: UiChange;
}
export interface ExtensionUiSnapshot extends UiOwner {
  statuses: { key: string; text: string }[];
  widgets: { key: string; placement: Placement; lines: string[] }[];
}
export function sameAgent(a: UiOwner, b: UiOwner): boolean {
  return a.workspaceId === b.workspaceId && a.agentId === b.agentId;
}
function replace<T extends { key: string }>(
  entries: T[],
  key: string,
  value: T | undefined,
  limit: number,
): T[] {
  const kept = entries.filter((entry) => entry.key !== key);
  return value ? [...kept, value].slice(-limit) : kept;
}
// `previous`, when present, belongs to the same agent as `event`.
export function applyExtensionUi(
  previous: ExtensionUiSnapshot | undefined,
  { change, ...owner }: ExtensionUiEvent,
): ExtensionUiSnapshot {
  if (previous && owner.processGeneration < previous.processGeneration) return previous;
  const state =
    previous?.processGeneration === owner.processGeneration
      ? previous
      : { ...owner, statuses: [], widgets: [] };
  switch (change.kind) {
    case "reset":
      return { ...owner, statuses: [], widgets: [] };
    case "notify":
      return state;
    case "status":
      return {
        ...state,
        statuses: replace(
          state.statuses,
          change.key,
          change.text === undefined ? undefined : { key: change.key, text: change.text },
          16,
        ),
      };
    case "widget":
      return {
        ...state,
        widgets: replace(
          state.widgets,
          change.key,
          change.lines === undefined
            ? undefined
            : { key: change.key, lines: change.lines, placement: change.placement },
          8,
        ),
      };
  }
}
