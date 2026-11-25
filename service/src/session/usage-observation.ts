import type { JourneyEvent, UsageObservation } from "../../../shared/usage";

import { ACP } from "./quota-schema";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** The same native response has the same key at message_end and in the v3 session file. */
export function piUsage(
  sessionId: string,
  msg: Record<string, unknown>,
  entryId?: string,
): UsageObservation | null {
  const response = text(msg.responseId);
  const channel = text(msg.provider);
  if (msg.role !== "assistant" || (!response && !entryId) || msg.api === ACP || channel === ACP)
    return null;
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
    id: JSON.stringify(
      response ? ["pi", sessionId, channel ?? null, response] : ["entry", sessionId, entryId],
    ),
    source: "pi",
    sessionId,
    unit: "inference",
    timestamp:
      typeof msg.timestamp === "number" && Number.isFinite(new Date(msg.timestamp).getTime())
        ? msg.timestamp
        : null,
    model: text(msg.model) ?? null,
    ...(channel && { channel }),
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
