import { z } from "zod";

export const ACP = "antigravity-acp";
export const NATIVE_CODEX = "native-codex";
export const QUOTA_TTL = 60_000;
export const SNAPSHOT_EVENT = "quota:snapshot:v1";
export const CONFIGURED_EVENT = "quota:configured:v1";
export interface PiQuotaReader {
  configured: string[];
  read: (provider: string) => Promise<QuotaSnapshot>;
}
export const REFRESH_EVENT = "quota:refresh:v1";
export const providerId = z
  .string()
  .max(80)
  .regex(/^[a-zA-Z0-9_.-]+$/);
export const label = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((s) => !Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127));
export const observedAt = z
  .number()
  .int()
  .positive()
  .refine((n) => n <= Date.now() + 1000);
const windowSchema = z.strictObject({
  label,
  usedPct: z.number().min(0).max(100),
  resetsAt: z.number().int().positive().max(8.64e15).optional(),
});
const group = z.strictObject({
  name: label,
  windows: z
    .array(windowSchema)
    .min(1)
    .max(16)
    .refine((ws) => new Set(ws.map((w) => w.label)).size === ws.length),
});
export const snapshotSchema = z
  .strictObject({
    provider: providerId,
    observedAt,
    availability: z.enum(["available", "unavailable", "unsupported"]),
    reason: z
      .enum(["not configured", "waiting for Pi session", "usage unavailable", "no quota adapter"])
      .optional(),
    groups: z
      .array(group)
      .max(32)
      .refine((gs) => new Set(gs.map((g) => g.name)).size === gs.length),
  })
  .refine((s) => s.groups.length > 0 === (s.availability === "available"));
export const piSnapshotSchema = snapshotSchema.refine((s) => !s.provider.startsWith("native-"));
export type QuotaSnapshot = z.infer<typeof snapshotSchema>;
export type QuotaGroup = QuotaSnapshot["groups"][number];
export type QuotaWindow = QuotaGroup["windows"][number];
export function unavailable(provider: string, at = Date.now()): QuotaSnapshot {
  return { provider, observedAt: at, availability: "unavailable", groups: [] };
}
export interface QuotaRow {
  provider: string;
  name: string;
  observedAt: number;
  availability: QuotaSnapshot["availability"];
  reason?: QuotaSnapshot["reason"];
  windows: QuotaWindow[];
}
export interface QuotaState {
  refreshing: boolean;
  rows: QuotaRow[];
}
