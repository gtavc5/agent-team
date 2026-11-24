import {
  QUOTA_TTL,
  unavailable,
  type QuotaRow,
  type QuotaState,
  type QuotaSnapshot,
} from "../session/quota-schema";
import type { QuotaAdapterRegistry } from "../session/quota/registry";

const MAX_QUOTA_RETRIES = 2;
export interface QuotaRefreshOptions {
  providers?: readonly string[];
  newlyReadable?: readonly string[];
}
interface QuotaRefresh<C> extends QuotaRefreshOptions {
  context: () => C;
}

export class QuotaMonitor<C> {
  private providers = new Map<
    string,
    {
      failureAt: number;
      latestAt: number;
      rows: Map<string, QuotaRow & { availabilityAt: number }>;
    }
  >();
  private lastAttempt = new Map<string, number>();
  private readonly retries = new Map<
    string,
    { count: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private readonly shutdown = new AbortController();
  private refreshing = false;
  private queuedRefresh?: QuotaRefresh<C>;

  constructor(
    private readonly changed: (state: QuotaState) => void,
    private readonly registry: QuotaAdapterRegistry<C>,
  ) {
    for (const id of registry.ids) this.merge(unavailable(id, 0));
  }
  state(): QuotaState {
    return {
      refreshing: this.refreshing,
      rows: [...this.providers.values()].flatMap((p) =>
        [...p.rows.values()].map(({ availabilityAt: _, ...row }) => row),
      ),
    };
  }
  accept(s: QuotaSnapshot, confirmedAt?: number) {
    if (this.shutdown.signal.aborted || !this.merge(s, confirmedAt)) return;
    if (s.availability === "available" || s.reason !== "usage unavailable")
      this.clearRetry(s.provider);
    this.changed(this.state());
  }
  private merge(s: QuotaSnapshot, confirmedAt?: number): boolean {
    let p = this.providers.get(s.provider);
    if (!p) {
      if (this.providers.size >= 32) {
        const oldest = [...this.providers]
          .filter(([id]) => !this.registry.ids.includes(id))
          .sort((a, b) => a[1].latestAt - b[1].latestAt)[0];
        if (!oldest || s.observedAt < oldest[1].latestAt) return false;
        this.providers.delete(oldest[0]);
      }
      this.providers.set(s.provider, (p = { failureAt: 0, latestAt: 0, rows: new Map() }));
    }
    // A live reader can confirm a provider-cached sample after reconnect. Its
    // windows are still ordered (and aged) by their original observation.
    const availabilityAt = Math.max(s.observedAt, confirmedAt ?? 0);
    if (
      availabilityAt < p.failureAt ||
      (s.availability === "available" &&
        confirmedAt === undefined &&
        availabilityAt === p.failureAt)
    )
      return false;
    p.latestAt = Math.max(p.latestAt, s.observedAt);
    let changed = false;
    if (s.availability !== "available") {
      p.failureAt = availabilityAt;
      if (!p.rows.size || p.rows.has("")) {
        p.rows.set("", {
          provider: s.provider,
          name: "",
          availabilityAt,
          observedAt: s.observedAt,
          availability: s.availability,
          reason: s.reason,
          windows: [],
        });
        changed = true;
      }
      for (const [key, row] of p.rows)
        if (
          row.availabilityAt <= availabilityAt &&
          (row.availability !== s.availability || row.reason !== s.reason)
        ) {
          p.rows.set(key, {
            ...row,
            availability: s.availability,
            availabilityAt,
            reason: s.reason,
          });
          changed = true;
        }
    } else {
      p.rows.delete("");
      for (const group of s.groups) {
        const prior = p.rows.get(group.name);
        if (prior && s.observedAt < prior.observedAt) {
          if (confirmedAt !== undefined && availabilityAt >= prior.availabilityAt) {
            p.rows.set(group.name, {
              ...prior,
              availability: "available",
              availabilityAt,
              reason: undefined,
            });
            changed = true;
          }
          continue;
        }
        if (
          prior?.observedAt === s.observedAt &&
          prior.availability === "available" &&
          JSON.stringify(prior.windows) === JSON.stringify(group.windows)
        ) {
          prior.availabilityAt = Math.max(prior.availabilityAt, availabilityAt);
          continue;
        }
        if (!prior && p.rows.size >= 32) {
          const oldest = [...p.rows.values()]
            .filter((row) => !s.groups.some((g) => g.name === row.name))
            .sort((a, b) => a.observedAt - b.observedAt)[0];
          if (!oldest || s.observedAt < oldest.observedAt) continue;
          p.rows.delete(oldest.name);
        }
        p.rows.set(group.name, {
          provider: s.provider,
          ...group,
          availabilityAt: Math.max(prior?.availabilityAt ?? 0, availabilityAt),
          availability: s.availability,
          observedAt: s.observedAt,
        });
        changed = true;
      }
    }
    return changed;
  }

  stop(): void {
    this.shutdown.abort();
    this.queuedRefresh = undefined;
    for (const id of this.retries.keys()) this.clearRetry(id);
  }

  private clearRetry(id: string, resetCount = true): void {
    const retry = this.retries.get(id);
    if (!retry) return;
    clearTimeout(retry.timer);
    retry.timer = undefined;
    if (resetCount) this.retries.delete(id);
  }

  private scheduleRetry(id: string, context: () => C): void {
    const count = this.retries.get(id)?.count ?? 0;
    if (count >= MAX_QUOTA_RETRIES) return;
    const timer = setTimeout(
      () => {
        void this.refresh(context, { providers: [id] });
      },
      QUOTA_TTL * 2 ** count,
    );
    timer.unref();
    this.retries.set(id, { count: count + 1, timer });
  }

  async refresh(context: () => C, options?: QuotaRefreshOptions) {
    if (this.shutdown.signal.aborted) return;
    if (this.refreshing) {
      const queued = this.queuedRefresh;
      this.queuedRefresh = {
        context,
        // A full refresh subsumes any queued provider-specific refreshes.
        providers:
          options?.providers && (!queued || queued.providers)
            ? [...new Set([...(queued?.providers ?? []), ...options.providers])]
            : undefined,
        newlyReadable: [
          ...new Set([...(queued?.newlyReadable ?? []), ...(options?.newlyReadable ?? [])]),
        ],
      };
      return;
    }
    this.refreshing = true;
    this.changed(this.state());
    try {
      let next: QuotaRefresh<C> | undefined = { context, ...options };
      while (next && !this.shutdown.signal.aborted) {
        this.queuedRefresh = undefined;
        await this.readProviders(next);
        next = this.queuedRefresh;
      }
    } finally {
      this.refreshing = false;
      if (!this.shutdown.signal.aborted) this.changed(this.state());
    }
  }

  private async readProviders({ context, providers, newlyReadable }: QuotaRefresh<C>) {
    const ctx = context();
    const now = Date.now();
    const run = async (id: string) => {
      if (!this.registry.configured(id, ctx)) {
        this.clearRetry(id);
        this.accept(this.registry.unconfigured(id, ctx, now));
        return;
      }
      // A newly readable provider can recover without waiting for the previous cooldown.
      const justReady = newlyReadable?.includes(id);
      if (justReady) this.clearRetry(id);
      else if (now - (this.lastAttempt.get(id) ?? -Infinity) < QUOTA_TTL) return;
      const rows = [...(this.providers.get(id)?.rows.values() ?? [])];
      if (rows.every((r) => r.availability === "available" && now - r.observedAt < QUOTA_TTL))
        return;
      if (rows.some((r) => r.reason === "waiting for ACP setup")) {
        this.accept({ ...unavailable(id, now), reason: "checking usage" });
      }
      this.lastAttempt.set(id, now);
      this.clearRetry(id, false);
      const result = await this.registry.read(id, ctx, this.shutdown.signal);
      if (this.shutdown.signal.aborted) return;
      this.accept(result, now);
      if (
        result.reason === "usage unavailable" &&
        [...(this.providers.get(id)?.rows.values() ?? [])].some((r) => r.reason === result.reason)
      )
        this.scheduleRetry(id, context);
      else this.clearRetry(id);
    };
    await Promise.all(
      this.registry.ids.filter((id) => !providers || providers.includes(id)).map(run),
    );
  }
}
