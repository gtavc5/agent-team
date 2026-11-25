import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { UsageObservation, UsagePrice } from "../../../shared/usage";

const rate = z.number().finite().nonnegative();
const schedule = z.object({
  channel: z.string().min(1),
  effective: z.iso.date(),
  input: rate,
  cacheRead: rate,
  cacheWrite: rate,
  output: rate,
});
const receipt = z.object({
  source: z.enum(["pi", "acp", "codex"]),
  sessionId: z.string().min(1),
  id: z.string().min(1),
  asOf: z.iso.date(),
  usd: rate,
});
const file = z
  .object({
    schedules: z.array(schedule).default([]),
    receipts: z.array(receipt).default([]),
  })
  .strict();
export type Prices = z.infer<typeof file>;
export function readPrices(baseDir: string): Prices {
  try {
    const config = file.parse(
      JSON.parse(readFileSync(join(baseDir, "usage-pricing.json"), "utf8")),
    );
    config.schedules.sort((a, b) => b.effective.localeCompare(a.effective));
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn("[usage] Invalid usage-pricing.json; ignoring pricing overrides");
    return { schedules: [], receipts: [] };
  }
}

export function entryPrice(obs: UsageObservation, prices: Prices): UsagePrice {
  if (!obs.channel || obs.timestamp === null || obs.price.kind === "reported") return obs.price;
  const row = prices.schedules.find(
    (r) => r.channel === obs.channel && Date.parse(r.effective) <= obs.timestamp!,
  );
  if (!row) return obs.price;
  const usd =
    (obs.input * row.input +
      obs.cacheRead * row.cacheRead +
      obs.cacheWrite * row.cacheWrite +
      obs.output * row.output) /
    1_000_000;
  return Number.isFinite(usd) ? { kind: "channel-estimate", usd, asOf: row.effective } : obs.price;
}
