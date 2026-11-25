import { createHash } from "node:crypto";
import type { JourneyEvent, UsageObservation } from "../../../shared/usage";

import { ACP } from "./quota-schema";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);

// Pi emits and appends the same final assistant message. Persist only its digest,
// and do not use it as the ledger ID: identical messages can be distinct entries.
function piMessageKey(msg: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(msg)).digest("hex");
}

/** The same native response has the same key at message_end and in the v3 session file. */
export function piUsage(
  sessionId: string,
  msg: Record<string, unknown>,
  entryId?: string,
): UsageObservation | null {
  if (!entryId && !text(msg.responseId)) return null;
  const observation = piAssistantUsage(sessionId, msg);
  return (
    observation && {
      ...observation,
      id: observation.id ?? JSON.stringify(["entry", sessionId, entryId]),
    }
  );
}

// A live response can have valid usage before Pi assigns its native entry ID.
export function piAssistantUsage(
  sessionId: string,
  msg: Record<string, unknown>,
): (Omit<UsageObservation, "id"> & { id?: string }) | null {
  const response = text(msg.responseId);
  const channel = text(msg.provider);
  if (msg.role !== "assistant" || msg.api === ACP || channel === ACP) return null;
  const { input, output, cacheRead, cacheWrite, cost: rawCost } = obj(msg.usage);
  if (
    !isTokenCount(input) ||
    !isTokenCount(output) ||
    !isTokenCount(cacheRead) ||
    !isTokenCount(cacheWrite)
  )
    return null;
  if (!response && !input && !output && !cacheRead && !cacheWrite) return null;
  const cost = obj(rawCost);
  const usd =
    typeof cost.total === "number" && Number.isFinite(cost.total) ? cost.total : undefined;
  const price: UsageObservation["price"] =
    cost.totalFromProvider === true && usd !== undefined && usd >= 0
      ? { kind: "reported", usd }
      : (cost.totalFromProvider ?? false) === false && usd !== undefined && usd > 0
        ? { kind: "api-equivalent", usd }
        : { kind: "unpriced", usd: null };
  const toolCalls = (Array.isArray(msg.content) ? msg.content : []).flatMap((v: unknown) => {
    const block = obj(v),
      id = text(block.id),
      name = text(block.name);
    return block.type === "toolCall" && id && name ? [{ id, name }] : [];
  });
  return {
    ...(response && { id: JSON.stringify(["pi", sessionId, channel ?? null, response]) }),
    source: "pi",
    sessionId,
    unit: "inference",
    timestamp:
      typeof msg.timestamp === "number" && Number.isFinite(new Date(msg.timestamp).getTime())
        ? msg.timestamp
        : null,
    model: text(msg.model) ?? null,
    ...(channel && { channel }),
    ...(!response && { piMessageKey: piMessageKey(msg) }),
    input,
    output,
    cacheRead,
    cacheWrite,
    price,
    ...(toolCalls.length && { toolCalls }),
  };
}

export interface UsageRecorder {
  recordUsage(this: void, observation: UsageObservation): void;
  recordJourney(this: void, event: JourneyEvent): void;
}

export function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
