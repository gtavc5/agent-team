import type { UsageFilters } from "../../../shared/usage";

export type UsageRequest = { view: "overview" | "journey"; filters: UsageFilters; cursor?: string };
const DAY = 86_400_000;

/** Windows have an exclusive UTC end. Pin `until` to continue a page across midnight. */
export function parseUsageRequest(
  view: UsageRequest["view"],
  params: URLSearchParams,
  now = Date.now(),
): UsageRequest {
  const allowed = new Set([
    "range",
    "until",
    "unit",
    "source",
    "channel",
    "model",
    "workspace",
    "session",
    "turn",
    ...(view === "journey" ? ["cursor"] : []),
  ]);
  for (const [key, value] of params) {
    if (
      !allowed.delete(key) ||
      !value ||
      value.length > (key === "cursor" ? 4096 : 256) ||
      Array.from(value).some((c) => c.charCodeAt(0) < 32)
    )
      throw new RangeError("Invalid usage filter");
  }
  const range = params.get("range") ?? "30d";
  const unit = params.get("unit") ?? "inference";
  const source = params.get("source");
  if (range !== "7d" && range !== "30d" && range !== "90d")
    throw new RangeError("Expected range 7d, 30d or 90d");
  if (unit !== "inference" && unit !== "turn" && unit !== "session")
    throw new RangeError("Invalid reporting unit");
  if (source !== null && source !== "pi" && source !== "acp" && source !== "codex")
    throw new RangeError("Invalid backend source");
  const end = params.get("until");
  const until = end === null ? (Math.floor(now / DAY) + 1) * DAY : Number(end);
  if (end !== null && (!/^\d{1,13}$/.test(end) || until <= 0))
    throw new RangeError("Expected an exclusive Unix millisecond end");
  const filters: UsageFilters = {
    since: until - parseInt(range, 10) * DAY,
    until,
    unit,
    ...(source && { source }),
  };
  for (const key of ["channel", "model", "workspace", "session", "turn"] as const) {
    const value = params.get(key);
    if (value !== null) filters[key] = value;
  }
  return { view, filters, ...(params.has("cursor") && { cursor: params.get("cursor")! }) };
}
