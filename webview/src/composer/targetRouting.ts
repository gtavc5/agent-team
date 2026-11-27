import type { AgentInfo } from "../state/useServer";
import {
  defaultRoomAgent,
  firstMention,
  isAllMention,
  parseRoomTargets,
} from "../../../shared/room-targets";

export interface ResolvedTarget {
  /** The agent Send and slash commands actually target right now. */
  effectiveAgent: AgentInfo | null;
  /** All recipients for the current draft, in mention order. */
  targetAgents: AgentInfo[];
  /** The locked agent, when its id names a still-present agent. */
  lockedAgent: AgentInfo | null;
  /** The agent named by the first `@name` token in the draft, when present. */
  mentionedAgent: AgentInfo | null;
  /** True when an `@mention` in the draft overrides the locked/default target. */
  isMentionOverride: boolean;
  /**
   * The 3rd `target` argument for sendMessage. `undefined` keeps the exact
   * existing behavior: the backend parses `@name` natively, or default routing applies.
   */
  sendTarget: string | undefined;
}

export function extractMentionName(text: string): string | null {
  return firstMention(text) ?? null;
}

export function findMentionedAgent(text: string, agents: AgentInfo[]): AgentInfo | null {
  const name = extractMentionName(text);
  if (!name) return null;
  if (isAllMention(name)) return getDefaultAgent(agents);
  return agents.find((a) => a.name === name || a.id === name) ?? null;
}

export function getDefaultAgent(agents: AgentInfo[]): AgentInfo | null {
  return defaultRoomAgent(agents);
}

export function resolveTargetState(
  agents: AgentInfo[],
  lockedAgentId: string | null | undefined,
  draftText: string,
): ResolvedTarget {
  const defaultAgent = getDefaultAgent(agents);
  const lockedAgent = lockedAgentId ? (agents.find((a) => a.id === lockedAgentId) ?? null) : null;
  const { targets, slash, firstExplicit } = parseRoomTargets(draftText, agents);
  const group = targets.length > 1;
  const multi = group && !slash;
  const mentionedAgent = multi
    ? targets[0]
    : group
      ? (firstExplicit ?? defaultAgent)
      : findMentionedAgent(draftText, agents);
  const effectiveAgent = mentionedAgent ?? lockedAgent ?? defaultAgent;
  const isMentionOverride =
    mentionedAgent !== null && mentionedAgent !== (lockedAgent ?? defaultAgent);

  let sendTarget: string | undefined;
  if (mentionedAgent) {
    // The backend parses the @name itself; keep exact compatibility.
    sendTarget = undefined;
  } else if (lockedAgent && (!defaultAgent || lockedAgent.id !== defaultAgent.id)) {
    sendTarget = lockedAgent.id;
  } else {
    sendTarget = undefined;
  }

  const targetAgents = multi ? targets : effectiveAgent ? [effectiveAgent] : [];
  return {
    effectiveAgent,
    lockedAgent,
    mentionedAgent,
    isMentionOverride,
    sendTarget,
    targetAgents,
  };
}

export function clearConflictingMention(
  text: string,
  targetAgent: AgentInfo,
  agents: AgentInfo[],
): string {
  const { targets, clean } = parseRoomTargets(text, agents);
  if (targets.length > 1) return clean;
  const match = text.match(/^\s*@(\S+)/);
  if (!match) return text;
  const name = match[1];
  const conflicting = agents.find((a) => a.name === name && a.id !== targetAgent.id);
  if (!conflicting) return text;
  // Strip the leading mention token and the spaces that followed it.
  return text.slice(match[0].length).replace(/^\s+/, "");
}
