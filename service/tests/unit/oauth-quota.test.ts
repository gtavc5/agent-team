import { afterEach, expect, it, vi } from "vitest";
import { piAdapters } from "../../src/session/quota/pi-adapters";
import type { PiQuotaContext } from "../../src/session/quota/pi-context";
import { QUOTA_AUTO_REFRESH_INTERVAL } from "../../src/session/quota-schema";
const jwt = (account: string) =>
  `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.synthetic`;
function context(): PiQuotaContext {
  return {
    events: { emit: () => {} },
    modelRegistry: {
      getProvider: () => true,
      getAll: () => [{ provider: "openai-codex" }, { provider: "kimi-coding" }],
      isUsingOAuth: () => true,
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getProviderAuth: (id) =>
        Promise.resolve({
          source: "OAuth",
          auth:
            id === "openai-codex"
              ? { apiKey: jwt("account-a") }
              : { headers: { Authorization: "Bearer synthetic" } },
        }),
    },
  };
}
const openai = {
  user_id: "private",
  email: "private",
  rate_limit: {
    primary_window: { used_percent: 12, limit_window_seconds: 300 * 60, reset_at: 1900000000 },
    secondary_window: { used_percent: 67, limit_window_seconds: 604800 },
  },
};
const kimi = {
  usages: {
    limit_month_total: { used_ratio: 0.832, reset_time: "2027-01-01T08:30:00Z" },
    limit_month_code: { used_ratio: 0.59 },
    limit_5h: { used_ratio: 0.444 },
  },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", remaining: "56" },
    },
  ],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("does not advertise a stored API key as an OAuth reader", () => {
  const base = context();
  const ctx = { ...base, modelRegistry: { ...base.modelRegistry, isUsingOAuth: () => false } };
  expect(piAdapters().configured("kimi-coding", ctx)).toBe(false);
});
it("does not join a previous login’s pending read", async () => {
  const ctx = context(),
    r = piAdapters();
  let finish!: (r: Response) => void;
  const first = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetcher = vi.fn((_url: string, opts: RequestInit) =>
    new Headers(opts.headers).get("chatgpt-account-id") === "account-a"
      ? first
      : Promise.resolve(
          Response.json({
            rate_limit: { primary_window: { used_percent: 88, limit_window_seconds: 18000 } },
          }),
        ),
  );
  vi.stubGlobal("fetch", fetcher);
  const a = r.read("openai-codex", ctx);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  ctx.modelRegistry.getProviderAuth = () =>
    Promise.resolve({ source: "OAuth", auth: { apiKey: jwt("account-b") } });
  const b = r.read("openai-codex", ctx);
  finish(Response.json(openai));
  await a;
  expect((await b).groups[0].windows[0].usedPct).toBe(88);
});
it("reads only the fixed OAuth usage endpoints, normalizes verified windows and strips account data", async () => {
  const fetcher = vi.fn((url: string, opts: RequestInit) => {
    expect(opts.redirect).toBe("error");
    expect(opts.body).toBeUndefined();
    expect(opts.method ?? "GET").toBe("GET");
    const h = new Headers(opts.headers);
    if (url === "https://chatgpt.com/backend-api/wham/usage") {
      expect(h.get("chatgpt-account-id")).toBe("account-a");
      expect(h.get("authorization")).toBe(`Bearer ${jwt("account-a")}`);
      return Promise.resolve(Response.json(openai));
    }
    expect(url).toBe("https://api.kimi.com/coding/v1/usages");
    expect(h.get("authorization")).toBe("Bearer synthetic");
    return Promise.resolve(Response.json(kimi));
  });
  vi.stubGlobal("fetch", fetcher);
  const r = piAdapters();
  const ctx = context();
  const [g, k] = await Promise.all(["openai-codex", "kimi-coding"].map((id) => r.read(id, ctx)));
  expect(g.groups).toEqual([
    {
      name: "Codex",
      windows: [
        { label: "5h", usedPct: 12, resetsAt: 1900000000000 },
        { label: "weekly", usedPct: 67 },
      ],
    },
  ]);
  expect(k.groups[0].windows).toEqual([
    { label: "5h", usedPct: 44 },
    { label: "monthly total", usedPct: 83, resetsAt: Date.parse("2027-01-01T08:30:00Z") },
    { label: "monthly code", usedPct: 59 },
  ]);
  expect(JSON.stringify([g, k])).not.toMatch(/private|synthetic|account-a|Bearer/);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("coalesces live reads and reuses only same-login results within the TTL", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => Promise.resolve(Response.json(openai)));
  vi.stubGlobal("fetch", fetcher);
  const r = piAdapters(),
    ctx = context(),
    id = "openai-codex";
  await Promise.all([r.read(id, ctx), r.read(id, ctx)]);
  await r.read(id, ctx);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(QUOTA_AUTO_REFRESH_INTERVAL);
  await r.read(id, ctx);
  expect(fetcher).toHaveBeenCalledTimes(2);
  ctx.modelRegistry.getProviderAuth = () =>
    Promise.resolve({ source: "OAuth", auth: { apiKey: jwt("account-b") } });
  await r.read(id, ctx);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("force bypasses a resolved same-login cache while forced in-flight reads still coalesce", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => Promise.resolve(Response.json(openai)));
  vi.stubGlobal("fetch", fetcher);
  const r = piAdapters(),
    ctx = context(),
    id = "openai-codex";
  await r.read(id, ctx);
  expect(fetcher).toHaveBeenCalledTimes(1);

  await Promise.all([
    r.read(id, ctx, undefined, { force: true }),
    r.read(id, ctx, undefined, { force: true }),
  ]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await r.read(id, ctx);
  expect(fetcher).toHaveBeenCalledTimes(2);

  await r.read(id, ctx, undefined, { force: true });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("isolates a failed vendor and never forwards non-OAuth credentials or server errors", async () => {
  const fetcher = vi.fn((url: string) =>
    Promise.resolve(
      url.includes("kimi.com")
        ? Response.json(kimi)
        : new Response("private error", { status: 403 }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const r = piAdapters(),
    ctx = context();
  const results = await Promise.all(["openai-codex", "kimi-coding"].map((id) => r.read(id, ctx)));
  expect(results.map((r) => r.availability)).toEqual(["unavailable", "available"]);
  ctx.modelRegistry.getProviderAuth = () =>
    Promise.resolve({ source: "environment", auth: { apiKey: "private" } });
  expect(await r.read("kimi-coding", ctx)).toMatchObject({
    availability: "unavailable",
    groups: [],
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(results)).not.toContain("private");
});
