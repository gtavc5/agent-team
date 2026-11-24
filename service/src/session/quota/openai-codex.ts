import { z } from "zod";
import { snapshotSchema } from "../quota-schema";
import { oauthAdapter } from "./oauth";
const id = "openai-codex";
const window = z.object({
  used_percent: z.number().min(0).max(100),
  limit_window_seconds: z.number().int().positive(),
  reset_at: z.number().int().positive().nullish(),
});
const usage = z.object({
  rate_limit: z.object({ primary_window: window.nullish(), secondary_window: window.nullish() }),
});
export const openaiCodexAdapter = () =>
  oauthAdapter(
    id,
    "https://chatgpt.com/backend-api/wham/usage",
    (raw, observedAt) => {
      const { primary_window, secondary_window } = usage.parse(raw).rate_limit;
      const windows = [primary_window, secondary_window].flatMap((w) =>
        w
          ? [
              {
                label:
                  w.limit_window_seconds === 604800
                    ? "weekly"
                    : w.limit_window_seconds % 3600 === 0
                      ? `${w.limit_window_seconds / 3600}h`
                      : `${w.limit_window_seconds}s`,
                usedPct: w.used_percent,
                ...(w.reset_at && { resetsAt: w.reset_at * 1000 }),
              },
            ]
          : [],
      );
      return snapshotSchema.parse({
        provider: id,
        observedAt,
        availability: "available",
        groups: [{ name: "Codex", windows }],
      });
    },
    (token) => {
      const claims = z
        .object({
          "https://api.openai.com/auth": z.object({
            chatgpt_account_id: z.string().min(1).max(128),
          }),
        })
        .parse(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")));
      return { "chatgpt-account-id": claims["https://api.openai.com/auth"].chatgpt_account_id };
    },
  );
