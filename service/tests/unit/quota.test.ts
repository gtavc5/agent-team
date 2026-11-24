import { EventEmitter } from "node:events";
import { expect, it, vi, afterEach } from "vitest";
import piQuota from "../../src/session/pi-quota";
import {
  ACP,
  NATIVE_CODEX,
  QUOTA_TTL,
  SNAPSHOT_EVENT,
  REFRESH_EVENT,
  unavailable,
  type QuotaSnapshot,
} from "../../src/session/quota-schema";
import { QuotaMonitor as Monitor } from "../../src/server/quota";
import { codexQuota, CodexQuotaSource } from "../../src/server/native-codex-quota";
import { QuotaAdapterRegistry } from "../../src/session/quota/registry";
import type { PiQuotaContext } from "../../src/session/quota/pi-context";
type Reader = () => Promise<QuotaSnapshot>;
class TestQuotaMonitor extends Monitor<(Reader | undefined)[]> {
  constructor() {
    super(
      () => {},
      new QuotaAdapterRegistry(
        [NATIVE_CODEX, ACP].map((id, i) => ({
          id,
          isConfigured: (ctx) => !!ctx[i],
          fetchQuota: (ctx) => ctx[i]!(),
        })),
      ),
    );
  }
}
function monitor() {
  const q = new TestQuotaMonitor();
  return {
    accept: (s: QuotaSnapshot) => q.accept(s),
    state: () => q.state(),
    refresh: (...readers: Reader[]) => q.refresh(() => readers),
  };
}

function fixture(
  modelRegistry: PiQuotaContext["modelRegistry"] = {
    getProvider: () => true,
    getAll: () => [],
    isUsingOAuth: () => false,
    getProviderAuthStatus: () => ({ configured: false }),
    getProviderAuth: () => Promise.resolve(undefined),
  },
) {
  const events = new EventEmitter();
  let command!: Parameters<Parameters<typeof piQuota>[0]["registerCommand"]>[1];
  const notify = vi.fn();
  piQuota({
    events,
    on(_e, handler) {
      handler({}, { modelRegistry, ui: { notify } });
    },
    registerCommand(name, cmd) {
      expect(name).toBe("quota");
      command = cmd;
    },
  });
  const snapshots: QuotaSnapshot[] = [];
  events.on(SNAPSHOT_EVENT, (s) => snapshots.push(s as QuotaSnapshot));
  return {
    events,
    notify,
    snapshots,
    run: (provider = ACP as string) =>
      command.handler("", { modelRegistry, model: { provider }, ui: { notify } }),
  };
}
afterEach(() => vi.useRealTimers());
it("shares the provider read between command, panel control and cached requests, publishing only quota fields", async () => {
  const { events, run, notify, snapshots } = fixture();
  const requests: { reply: (v: unknown) => void }[] = [];
  events.on("antigravity-acp:quota:request", (req) =>
    requests.push(req as (typeof requests)[number]),
  );
  const cmd = run();
  const ack = vi.fn();
  events.emit(REFRESH_EVENT, { provider: ACP, reply: ack });
  await Promise.resolve();
  const at = Date.now();
  const reset = "2027-01-01T10:00:00Z";
  requests[0].reply({
    ok: true,
    headers: "secret",
    quota: {
      at,
      groups: [
        { displayName: "Available only", buckets: [] },
        {
          displayName: "Gemini",
          buckets: [{ window: "5h", remainingFraction: 0.79, resetTime: reset }],
        },
      ],
    },
  });
  await cmd;
  expect(requests).toHaveLength(1);
  const expected = {
    provider: ACP,
    observedAt: at,
    availability: "available",
    groups: [
      { name: "Gemini", windows: [{ label: "5h", usedPct: 21, resetsAt: Date.parse(reset) }] },
    ],
  };
  expect(ack).toHaveBeenCalledWith(expected);
  expect(snapshots).toContainEqual(expected);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("Gemini · 5h: 21% used"), "info");
});
it("does not bypass provider cache invalidation after logout", async () => {
  const f = fixture();
  let loggedIn = true;
  f.events.on("antigravity-acp:quota:request", ({ reply }: { reply: (raw: unknown) => void }) =>
    reply(
      loggedIn
        ? {
            ok: true,
            quota: {
              at: Date.now(),
              groups: [{ displayName: "A", buckets: [{ window: "5h", remainingFraction: 0.2 }] }],
            },
          }
        : { ok: false, error: "signed out" },
    ),
  );
  await f.run();
  loggedIn = false;
  await f.run();
  expect(f.snapshots.filter((s) => s.provider === ACP).map((s) => s.availability)).toEqual([
    "available",
    "unavailable",
  ]);
});
it("reports unsupported providers without probing; errors, missing listeners and malformed fractions are unavailable", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.events.once("antigravity-acp:quota:request", ({ reply }: { reply: (v: unknown) => void }) =>
    reply({ ok: false }),
  );
  await f.run("unknown-provider");
  expect(f.snapshots.find((s) => s.provider === "unknown-provider")).toMatchObject({
    provider: "unknown-provider",
    availability: "unsupported",
    groups: [],
  });
  const cmd = f.run();
  await vi.advanceTimersByTimeAsync(45_000);
  await cmd;
  for (const raw of [
    { ok: false, error: "SECRET" },
    {
      ok: true,
      quota: {
        at: Date.now(),
        groups: [{ displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: -1 }] }],
      },
    },
  ]) {
    await vi.advanceTimersByTimeAsync(QUOTA_TTL);
    f.events.once("antigravity-acp:quota:request", ({ reply }: { reply: (raw: unknown) => void }) =>
      reply(raw),
    );
    await f.run();
  }
  expect(
    f.snapshots
      .filter((s) => s.provider === ACP)
      .slice(1)
      .map((s) => s.availability),
  ).toEqual(Array(3).fill("unavailable"));
  expect(JSON.stringify(f.snapshots)).not.toContain("SECRET");
});
function group(at: number, name: string, pct: number): QuotaSnapshot {
  return {
    provider: ACP,
    observedAt: at,
    availability: "available",
    groups: [{ name, windows: [{ label: "5h", usedPct: pct }] }],
  };
}
it("merges per group, rejects older reports and keeps independent last-known values when readers disappear", async () => {
  const q = monitor();
  const now = Date.now();
  q.accept(group(now, "A", 31));
  q.accept(group(now - 10, "B", 54));
  q.accept(group(now - 5, "A", 99));
  const native = codexQuota(
    {
      primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 123 },
      secondary: null,
      limitId: "account",
      planType: null,
    },
    now,
  );
  await q.refresh(() => Promise.resolve(native));
  expect(q.state().rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        provider: NATIVE_CODEX,
        windows: [{ label: "5h", usedPct: 41, resetsAt: 123000 }],
      }),
      expect.objectContaining({
        name: "A",
        observedAt: now,
        availability: "unavailable",
        reason: "not configured",
        windows: [{ label: "5h", usedPct: 31 }],
      }),
      expect.objectContaining({ name: "B", observedAt: now - 10 }),
    ]),
  );
});
it("does not revive an unavailable row with a delayed duplicate", async () => {
  const q = monitor();
  const sample = group(Date.now() - 10, "A", 3);
  q.accept(sample);
  await q.refresh(() => Promise.resolve(unavailable(NATIVE_CODEX)));
  q.accept(sample);
  expect(q.state().rows.find((r) => r.name === "A")?.availability).toBe("unavailable");
});
it.each([0, 10])(
  "a reconnected reader can confirm a cached observation (%d ms older) without changing its age or values",
  async (lag) => {
    const q = monitor();
    const now = Date.now();
    const sample = group(now - 10, "A", 3);
    q.accept(sample);
    await q.refresh(() => Promise.resolve(unavailable(NATIVE_CODEX)));
    await q.refresh(
      () => Promise.resolve(unavailable(NATIVE_CODEX)),
      () => Promise.resolve(lag ? group(sample.observedAt - lag, "A", 81) : sample),
    );
    expect(q.state().rows.find((r) => r.name === "A")).toMatchObject({
      availability: "available",
      windows: [{ label: "5h", usedPct: 3 }],
      observedAt: now - 10,
    });
  },
);
it("makes room for current groups and providers at capacity", () => {
  const q = monitor();
  const now = Date.now();
  for (let i = 0; i < 32; i++) q.accept(group(now - 1, `g${i}`, 1));
  q.accept(group(now, "new", 1));
  expect(q.state().rows.map((r) => r.name)).toContain("new");
  for (let i = 0; i < 32; i++) q.accept(unavailable(`p${i}`, now));
  expect(q.state().rows.map((r) => r.provider)).toContain("p31");
});
it("merges sparse native windows received from independent sessions", () => {
  const q = monitor();
  const at = Date.now();
  const full = {
    primary: { usedPercent: 13, windowDurationMins: 300, resetsAt: null },
    secondary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: null },
    limitId: "codex",
    planType: null,
  };
  const source = new CodexQuotaSource();
  q.accept(source.snapshot(full, at - 1));
  q.accept(source.snapshot({ ...full, primary: null }, at, true));
  expect(q.state().rows.find((r) => r.provider === NATIVE_CODEX)?.windows).toHaveLength(2);
});
it("refreshes a stale group even with a fresh sibling", async () => {
  const q = monitor(),
    now = Date.now();
  q.accept(group(now - 2 * QUOTA_TTL, "old", 5));
  q.accept(group(now, "new", 90));
  const acp = vi.fn(() => Promise.resolve(group(Date.now(), "old", 55)));
  await q.refresh(() => Promise.resolve(unavailable(NATIVE_CODEX)), acp);
  expect(acp).toHaveBeenCalledTimes(1);
});
it("returns the async refresh chain to the event bus for reload error handling", async () => {
  const f = fixture();
  const listener = f.events.listeners(REFRESH_EVENT)[0] as (req: unknown) => unknown;
  f.events.on("antigravity-acp:quota:request", ({ reply }: { reply: (v: unknown) => void }) =>
    reply({ ok: false }),
  );
  const result = listener({ provider: ACP, reply: () => {} });
  expect(result).toBeInstanceOf(Promise);
  await result;
});
it("limits refresh to one in flight and one read per TTL independently of passive native events", async () => {
  vi.useFakeTimers();
  const q = monitor();
  const codex = vi.fn(() => Promise.resolve(unavailable(NATIVE_CODEX)));
  const acp = vi.fn(() => Promise.resolve(group(Date.now(), "A", 41)));
  await Promise.all([q.refresh(codex, acp), q.refresh(codex, acp)]);
  await q.refresh(codex, acp);
  expect(acp).toHaveBeenCalledTimes(1);
  expect(codex).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(QUOTA_TTL);
  await q.refresh(codex, acp);
  expect(acp).toHaveBeenCalledTimes(2);
  expect(q.state().rows.find((r) => r.provider === ACP)?.availability).toBe("available");
});
