import { codexProcessEnv, readCodexRateLimits } from "../session/codex";
import type { RateLimitSnapshot } from "../session/codex-rpc";
import type { QuotaProviderAdapter } from "../session/quota/registry";
import {
  NATIVE_CODEX,
  snapshotSchema,
  unavailable,
  type QuotaSnapshot,
} from "../session/quota-schema";

export function codexQuota(limits: RateLimitSnapshot | null, at = Date.now()): QuotaSnapshot {
  const windows = [limits?.primary, limits?.secondary].flatMap((w, i) => {
    if (!w) return [];
    const minutes = w.windowDurationMins;
    const label =
      minutes === 10080
        ? "weekly"
        : minutes && minutes % 60 === 0
          ? `${minutes / 60}h`
          : minutes
            ? `${minutes}m`
            : i === 0
              ? "primary"
              : "secondary";
    return [{ label, usedPct: w.usedPercent, ...(w.resetsAt && { resetsAt: w.resetsAt * 1000 }) }];
  });
  const parsed = snapshotSchema.safeParse({
    provider: NATIVE_CODEX,
    observedAt: at,
    availability: "available",
    groups: [{ name: limits?.limitId || "Codex", windows }],
  });
  return parsed.success ? parsed.data : unavailable(NATIVE_CODEX, at);
}

export class CodexQuotaSource implements QuotaProviderAdapter<unknown> {
  readonly id = NATIVE_CODEX;
  constructor(private readonly configured: () => boolean = () => true) {}
  isConfigured() {
    return this.configured();
  }
  async fetchQuota(_ctx: unknown, signal: AbortSignal): Promise<QuotaSnapshot> {
    const notConfigured = (): QuotaSnapshot => ({
      ...unavailable(NATIVE_CODEX),
      reason: "not configured",
    });
    if (!this.isConfigured()) return notConfigured();
    const at = Date.now();
    const limits = await readCodexRateLimits(codexProcessEnv(), signal);
    signal.throwIfAborted();
    if (!this.isConfigured()) return notConfigured();
    const snapshot = this.snapshot(limits, at);
    return snapshot.availability === "available"
      ? snapshot
      : { ...snapshot, reason: "usage unavailable" };
  }
  private groups = new Map<string, { at: number; limits: RateLimitSnapshot }>();
  snapshot(limits: RateLimitSnapshot | null, at = Date.now(), sparse = false): QuotaSnapshot {
    if (!limits) return unavailable(NATIVE_CODEX, at);
    const key = limits.limitId ?? "Codex";
    const prior = this.groups.get(key);
    const merged =
      sparse && prior
        ? {
            ...limits,
            primary: limits.primary ?? prior.limits.primary,
            secondary: limits.secondary ?? prior.limits.secondary,
          }
        : limits;
    const result = codexQuota(merged, at);
    if (result.availability === "available" && (!prior || at >= prior.at)) {
      this.groups.delete(key);
      this.groups.set(key, { at, limits: merged });
      if (this.groups.size > 32) this.groups.delete(this.groups.keys().next().value!);
    }
    return result;
  }
}
