import { z } from "zod";
import { snapshotSchema, type QuotaWindow } from "../quota-schema";
import { oauthAdapter } from "./oauth";
const id = "kimi-coding";
const count = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative());
const detail = z.object({
  limit: count,
  used: count.optional(),
  remaining: count.optional(),
  resetTime: z.string().optional(),
  resetAt: z.string().optional(),
});
const ratioWindow = z.object({
  used_ratio: z.number().min(0).max(1),
  reset_time: z.string().optional(),
});
const ratioLabels = {
  limit_5h: "5h",
  limit_month_total: "monthly total",
  limit_month_code: "monthly code",
} as const;
const usage = z.object({
  usages: z
    .object({
      limit_5h: ratioWindow.optional(),
      limit_month_total: ratioWindow.optional(),
      limit_month_code: ratioWindow.optional(),
    })
    .optional(),
  usage: detail.optional(),
  limits: z
    .array(
      z.object({ window: z.object({ duration: count, timeUnit: z.string() }).optional(), detail }),
    )
    .max(15)
    .optional(),
});
function toWindow(d: z.infer<typeof detail>, label: string): QuotaWindow[] {
  const used = d.used ?? (d.remaining !== undefined ? d.limit - d.remaining : undefined);
  if (!d.limit || used === undefined || used < 0 || used > d.limit) return [];
  const reset = d.resetTime ?? d.resetAt;
  return [
    {
      label,
      usedPct: Math.round((100 * used) / d.limit),
      ...(reset && { resetsAt: Date.parse(reset) }),
    },
  ];
}
// Kimi CLI's /usage reads GET <coding base>/usages (ui/shell/usage.py).
export const kimiCodingAdapter = () =>
  oauthAdapter(id, "https://api.kimi.com/coding/v1/usages", (raw, observedAt) => {
    const parsed = usage.parse(raw);
    const windows = parsed.usage ? toWindow(parsed.usage, "weekly") : [];
    for (const [i, item] of (parsed.limits ?? []).entries()) {
      const w = item.window;
      const minutes = w?.timeUnit.includes("MINUTE")
        ? w.duration
        : w?.timeUnit.includes("HOUR")
          ? 60 * w.duration
          : undefined;
      windows.push(
        ...toWindow(
          item.detail,
          minutes ? (minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`) : `Limit ${i + 1}`,
        ),
      );
    }
    const byLabel = new Map(windows.map((w) => [w.label, w]));
    for (const [key, b] of Object.entries(parsed.usages ?? {})) {
      if (!b) continue;
      const label = ratioLabels[key as keyof typeof ratioLabels];
      byLabel.set(label, {
        label,
        usedPct: Math.round(b.used_ratio * 100),
        ...(b.reset_time && { resetsAt: Date.parse(b.reset_time) }),
      });
    }
    return snapshotSchema.parse({
      provider: id,
      observedAt,
      availability: "available",
      groups: [{ name: "Kimi Code", windows: [...byLabel.values()] }],
    });
  });
