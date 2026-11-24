import type { RateLimitSnapshot } from "../session/codex-rpc";
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

import { codexProcessEnv, readCodexRateLimits } from "../session/codex";
import type { QuotaProviderAdapter } from "../session/quota/registry";
export class CodexQuotaSource implements QuotaProviderAdapter<unknown> {
  readonly id = NATIVE_CODEX;
  isConfigured() {
    return true;
  }
  async fetchQuota() {
    const at = Date.now();
    return this.snapshot(await readCodexRateLimits(codexProcessEnv()), at);
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
