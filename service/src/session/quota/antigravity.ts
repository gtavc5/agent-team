import { z } from "zod";
import { ACP_PREPARE_STEP, inspectAcpRuntime } from "../acp-readiness";
import { ACP, label, observedAt, snapshotSchema } from "../quota-schema";
import type { PiQuotaContext } from "./pi-context";
import type { QuotaProviderAdapter } from "./registry";
const reply = z.object({
  ok: z.literal(true),
  quota: z.object({
    at: observedAt,
    groups: z
      .array(
        z.object({
          displayName: label,
          buckets: z
            .array(
              z.object({
                window: label,
                remainingFraction: z.number().min(0).max(1),
                resetTime: z.string().max(48).optional(),
              }),
            )
            .max(16),
        }),
      )
      .min(1)
      .max(32),
  }),
});
export const antigravityAdapter: QuotaProviderAdapter<PiQuotaContext> = {
  id: ACP,
  isConfigured: (ctx) => Boolean(ctx.modelRegistry.getProvider(ACP)),
  async fetchQuota(ctx) {
    // Keep the route registered so the running Pi can pick up a new local install.
    if (!inspectAcpRuntime().ready) throw new Error(ACP_PREPARE_STEP);
    const raw = await new Promise<unknown>((resolve) =>
      ctx.events.emit("antigravity-acp:quota:request", { reply: resolve }),
    );
    const { at, groups } = reply.parse(raw).quota;
    return snapshotSchema.parse({
      provider: ACP,
      observedAt: at,
      availability: "available",
      groups: groups
        .filter((g) => g.buckets.length)
        .map((g) => ({
          name: g.displayName,
          windows: g.buckets.map((b) => ({
            label: b.window,
            usedPct: Math.round(100 * (1 - b.remainingFraction)),
            ...(b.resetTime && { resetsAt: Date.parse(b.resetTime) }),
          })),
        })),
    });
  },
};
