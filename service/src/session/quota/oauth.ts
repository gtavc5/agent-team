import { createHash } from "node:crypto";
import {
  QUOTA_AUTO_REFRESH_INTERVAL,
  type QuotaReadOptions,
  type QuotaSnapshot,
} from "../quota-schema";
import type { QuotaProviderAdapter } from "./registry";
import type { PiQuotaContext } from "./pi-context";

export function oauthAdapter(
  id: string,
  url: string,
  normalize: (raw: unknown, at: number) => QuotaSnapshot,
  extraHeaders?: (token: string) => Record<string, string>,
): QuotaProviderAdapter<PiQuotaContext> {
  let cached: { identity: string; until: number; sample: Promise<QuotaSnapshot> } | undefined;
  return {
    id,
    coalescesByCredential: true,
    isConfigured: ({ modelRegistry }) => {
      const model = modelRegistry.getAll().find((m) => m.provider === id);
      return (
        !!model &&
        modelRegistry.getProviderAuthStatus(id).source === "stored" &&
        modelRegistry.isUsingOAuth(model)
      );
    },
    async fetchQuota(ctx, signal, options?: QuotaReadOptions) {
      const startedAt = Date.now();
      const resolved = await ctx.modelRegistry.getProviderAuth(id);
      signal.throwIfAborted();
      if (resolved?.source !== "OAuth") throw new Error("No Pi OAuth login");
      const bearer = resolved.auth.headers?.Authorization;
      const token =
        resolved.auth.apiKey ??
        (typeof bearer === "string" && bearer.startsWith("Bearer ") ? bearer.slice(7) : undefined);
      if (!token) throw new Error("No Pi OAuth credential");
      const identity = createHash("sha256").update(token).digest("hex");
      if (
        cached?.identity === identity &&
        Date.now() < cached.until &&
        (!options?.force || cached.until === Infinity)
      )
        return cached.sample;
      const read = async () => {
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...extraHeaders?.(token),
          },
          redirect: "error",
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Usage endpoint unavailable");
        }
        return normalize(await response.json(), startedAt);
      };
      const entry = { identity, until: Infinity, sample: read() };
      cached = entry;
      try {
        const result = await entry.sample;
        entry.until = result.observedAt + QUOTA_AUTO_REFRESH_INTERVAL;
        return result;
      } catch (error) {
        if (cached === entry) cached = undefined;
        throw error;
      }
    },
  };
}
