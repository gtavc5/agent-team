import type { IncomingHttpHeaders } from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { futureReset, headerReset, notRecoverable } from "../session/pi-rate-limit";

export type CcpaOperation =
  "streamGenerateContent" | "fetchAvailableModels" | "retrieveUserQuotaSummary";
export type CcpaObservation =
  | { kind: "quota"; exhausted: Map<string, number> }
  | { kind: "response"; model: string; limited: boolean; resetsAt?: number };
export type ObserveRequest = (
  operation: CcpaOperation,
) => ((response: CcpaObservation) => void) | undefined;
export const observationCap = 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function decode(bytes: Buffer | undefined, encoding: unknown): unknown {
  if (!bytes?.length) return;
  try {
    const opts = { maxOutputLength: observationCap };
    if (encoding === "gzip") bytes = gunzipSync(bytes, opts);
    else if (encoding === "deflate") bytes = inflateSync(bytes, opts);
    else if (encoding === "br") bytes = brotliDecompressSync(bytes, opts);
    else if (encoding && encoding !== "identity") return;
    return JSON.parse(bytes.toString()) as unknown;
  } catch {
    return;
  }
}

export function ccpaObservation(
  op: CcpaOperation,
  model: string,
  status: number,
  headers: IncomingHttpHeaders,
  bytes?: Buffer,
): CcpaObservation {
  const body = record(decode(bytes, headers["content-encoding"]));
  if (op !== "streamGenerateContent") {
    const exhausted = new Map<string, number>();
    const add = (id: unknown, quota: Record<string, unknown>) => {
      const at = futureReset(Date.parse(String(quota.resetTime)) / 1000);
      if (typeof id === "string" && quota.remainingFraction === 0 && at)
        exhausted.set(id, Math.max(exhausted.get(id) ?? 0, at));
    };
    if (status === 200 && op === "fetchAvailableModels") {
      for (const [id, row] of Object.entries(record(body.models)))
        add(id, record(record(row).quotaInfo));
    } else if (status === 200) {
      // Group labels and matching timestamps do not identify a model. Only
      // use buckets that explicitly name one; a group-only summary is inert.
      for (const group of Array.isArray(body.groups) ? body.groups : []) {
        const buckets = record(group).buckets;
        for (const bucket of Array.isArray(buckets) ? buckets : []) {
          const row = record(bucket);
          if (!row.disabled) add(row.modelId, row);
        }
      }
    }
    return { kind: "quota", exhausted };
  }
  const response = { kind: "response" as const, model, limited: false };
  if (status !== 429 || model === "unknown") return response;
  const error = record(body.error);
  const details = Array.isArray(error.details) ? error.details.map(record) : [];
  if (
    (error.status && error.status !== "RESOURCE_EXHAUSTED") ||
    [error.message, ...details.map((d) => d.reason)].some(
      (v) => typeof v === "string" && notRecoverable(v.replaceAll("_", " ")),
    )
  )
    return response;
  const info = details.find((d) => d["@type"] === "type.googleapis.com/google.rpc.ErrorInfo");
  if (info && !["QUOTA_EXHAUSTED", "RATE_LIMIT_EXCEEDED"].includes(String(info.reason)))
    return response;
  const metadata = record(info?.metadata);
  const at = futureReset(Date.parse(String(metadata.quotaResetTimeStamp)) / 1000);
  // agy's ErrorInfo metadata uses Go durations (e.g. 119h36m35.419s).
  const resetDelay = metadata.quotaResetDelay;
  const units: Record<string, number> = {
    h: 3600,
    m: 60,
    s: 1,
    ms: 0.001,
    us: 1e-6,
    µs: 1e-6,
    μs: 1e-6,
    ns: 1e-9,
  };
  const delaySeconds =
    typeof resetDelay === "string" && /^(?:\d+(?:\.\d+)?(?:ns|[µμu]s|ms|h|m|s))+$/.test(resetDelay)
      ? Array.from(
          resetDelay.matchAll(/(\d+(?:\.\d+)?)(ns|[µμu]s|ms|h|m|s)/g),
          ([, n, u]) => Number(n) * units[u],
        ).reduce((a, b) => a + b, 0)
      : 0;
  // google.rpc.RetryInfo carries a protobuf Duration (seconds), not an epoch.
  const delay = details.find(
    (d) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
  )?.retryDelay;
  const seconds =
    typeof delay === "string" && /^(?:\d+)(?:\.\d+)?s$/.test(delay)
      ? Number(delay.slice(0, -1))
      : 0;
  return {
    ...response,
    limited: true,
    resetsAt:
      at ??
      futureReset(Date.now() / 1000 + delaySeconds) ??
      headerReset(headers) ??
      futureReset(Date.now() / 1000 + seconds),
  };
}
