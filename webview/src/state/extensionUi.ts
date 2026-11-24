import {
  applyExtensionUi,
  sameAgent,
  type ExtensionUiEvent,
  type ExtensionUiSnapshot,
  type UiOwner,
  type Notice,
} from "../../../shared/extension-ui";

export type LiveNotice = UiOwner & Notice & { expiresAt: number };
export type LiveUi = { agents: ExtensionUiSnapshot[]; notices: LiveNotice[] };
export const emptyUi: LiveUi = { agents: [], notices: [] };
export function receiveUi(state: LiveUi, event: ExtensionUiEvent, now: number): LiveUi {
  const previous = state.agents.find((a) => sameAgent(a, event));
  if (previous && previous.processGeneration > event.processGeneration) return state;
  const next = applyExtensionUi(previous, event);
  const { change, ...owner } = event;
  let notices = state.notices.filter(
    (n) =>
      !sameAgent(n, owner) ||
      (n.processGeneration === owner.processGeneration && change.kind !== "reset"),
  );
  if (change.kind === "notify") {
    const keep = notices.filter((n) => sameAgent(n, owner) && n.id !== change.id).slice(-7);
    notices = [
      ...notices.filter((n) => !sameAgent(n, owner) || keep.includes(n)),
      { ...owner, ...change, expiresAt: now + 8000 },
    ];
  }
  return {
    agents:
      next === previous ? state.agents : [...state.agents.filter((a) => a !== previous), next],
    notices,
  };
}
export function withoutOwner(state: LiveUi, workspaceId: string, agentId?: string): LiveUi {
  const keep = (a: UiOwner) =>
    a.workspaceId !== workspaceId || (agentId !== undefined && a.agentId !== agentId);
  return { agents: state.agents.filter(keep), notices: state.notices.filter(keep) };
}
