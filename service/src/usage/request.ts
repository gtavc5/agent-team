import type { UsageFilters } from "../../../shared/usage";

export type UsageRequest = {
  view: "overview" | "journey";
  filters: UsageFilters;
  cursor?: string;
  page?: number;
  refresh?: true;
};
const DAY = 86_400_000;

/** Windows have an exclusive UTC end. Pin `until` to continue a page across midnight. */
export function parseUsageRequest(
  view: UsageRequest["view"],
  params: URLSearchParams,
  now = Date.now(),
): UsageRequest {
  const allowed = new Set([
    "range",
    "granularity",
    "refresh",
    "until",
    "unit",
    "source",
    "channel",
    "model",
    "workspace",
    "session",
    "turn",
    ...(view === "journey" ? ["cursor", "page"] : []),
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
  if (!["24h", "7d", "30d", "90d"].includes(range)) throw new RangeError("Invalid usage range");
  const granularity = params.get("granularity") ?? (range === "24h" ? "hour" : "day");
  if (granularity !== "hour" && granularity !== "day") throw new RangeError("Invalid bucket size");
  if (granularity === "hour" && range !== "24h" && range !== "7d")
    throw new RangeError("Hourly range too long");
  if (params.has("refresh") && params.get("refresh") !== "1")
    throw new RangeError("Invalid refresh");
  const page = params.get("page");
  if (
    page !== null &&
    (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page)) || params.has("cursor"))
  )
    throw new RangeError("Invalid page");
  if (unit !== "inference" && unit !== "turn" && unit !== "session")
    throw new RangeError("Invalid reporting unit");
  if (source !== null && source !== "pi" && source !== "acp" && source !== "codex")
    throw new RangeError("Invalid backend source");
  const end = params.get("until");
  const boundary = granularity === "hour" || range === "24h" ? DAY / 24 : DAY;
  const until = end === null ? (Math.floor(now / boundary) + 1) * boundary : Number(end);
  if (end !== null && (!/^\d{1,13}$/.test(end) || until <= 0))
    throw new RangeError("Expected an exclusive Unix millisecond end");
  const filters: UsageFilters = {
    since: until - (range === "24h" ? DAY : parseInt(range, 10) * DAY),
    granularity,
    until,
    unit,
    ...(source && { source }),
  };
  for (const key of ["channel", "model", "workspace", "session", "turn"] as const) {
    const value = params.get(key);
    if (value !== null) filters[key] = value;
  }
  return {
    view,
    filters,
    ...(params.has("refresh") && { refresh: true }),
    ...(page !== null && { page: Number(page) }),
    ...(params.has("cursor") && { cursor: params.get("cursor")! }),
  };
}
