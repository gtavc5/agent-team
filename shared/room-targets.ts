export interface RoomAgent {
  id: string;
  name: string;
  isDefault: boolean;
}

export type DiscussionRounds = 0 | 1 | 2;

export type DiscussionLabel =
  | { kind: "review"; round: number; rounds: 1 | 2 }
  | { kind: "synthesis" }
  | { kind: "relay"; from: string; hop: number; limitReached?: true };

export const MAX_PEER_RELAY_HOPS = 2;

export function discussionRounds(value: unknown): DiscussionRounds {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value >= 2 ? 2 : value >= 1 ? 1 : 0;
}

export function defaultRoomAgent<T extends RoomAgent>(agents: readonly T[]): T | null {
  return agents.find((a) => a.isDefault) ?? agents[0] ?? null;
}

// Mask code without moving offsets or turning a suffix into a new token.
export function roomProse(text: string): string {
  if (!/[`~]/.test(text)) return text;
  let fence: { char: string; length: number } | undefined;
  const mask = (code: string) => code.replace(/[^\r\n]/g, "\0");
  return text
    .split("\n")
    .map((line) => {
      const run = /^(?: {0,3}> ?)* {0,3}(`{3,}|~{3,})(.*)$/.exec(line.trimEnd());
      if (fence) {
        if (run && run[1][0] === fence.char && run[1].length >= fence.length && !run[2])
          fence = undefined;
        return mask(line);
      }
      if (!run) return line;
      fence = { char: run[1][0], length: run[1].length };
      return mask(line);
    })
    .join("\n")
    .replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, mask);
}

const roomMention = /(^|\s)@([^\s\0]+)/g;

export function firstMention(text: string): string | undefined {
  return roomProse(text).matchAll(roomMention).next().value?.[2];
}

export function isAllMention(name: string): boolean {
  return /^(all|全体)$/i.test(name);
}

export function parseRoomTargets<T extends RoomAgent>(text: string, agents: readonly T[]) {
  const targets = new Set<T>();
  let firstExplicit: T | undefined;
  let first: string | undefined;
  let singleClean = text;
  let clean = "";
  let offset = 0;
  for (const token of roomProse(text).matchAll(roomMention)) {
    const [match, prefix, name] = token;
    const start = token.index;
    const end = start + match.length;
    if (first === undefined) {
      first = name;
      singleClean = `${text.slice(0, start)} ${text.slice(end).trimStart()}`.trim();
    }
    if (isAllMention(name)) {
      for (const agent of agents) targets.add(agent);
    } else {
      const agent = agents.find((a) => a.name === name || a.id === name);
      if (!agent) continue;
      firstExplicit ??= agent;
      targets.add(agent);
    }
    clean += text.slice(offset, start + prefix.length);
    offset = end;
  }
  clean = (clean + text.slice(offset)).trim();
  return {
    targets: [...targets],
    firstExplicit,
    first,
    singleClean,
    clean,
    slash: clean.startsWith("/"),
  };
}
