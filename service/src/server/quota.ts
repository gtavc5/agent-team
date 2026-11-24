import {
  QUOTA_TTL,
  unavailable,
  type QuotaRow,
  type QuotaState,
  type QuotaSnapshot,
} from "../session/quota-schema";
import type { QuotaAdapterRegistry } from "../session/quota/registry";
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
  private refreshing = false;
  private queuedRefresh?: { context: () => C; newlyReadable: Set<string> };

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
    if (this.merge(s, confirmedAt)) this.changed(this.state());
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

  cancelQueuedRefresh(): void {
    this.queuedRefresh = undefined;
  }

  async refresh(context: () => C, newlyReadable?: readonly string[]) {
    if (this.refreshing) {
      if (newlyReadable) {
        this.queuedRefresh = {
          context,
          newlyReadable: new Set([...(this.queuedRefresh?.newlyReadable ?? []), ...newlyReadable]),
        };
      }
      return;
    }
    this.refreshing = true;
    this.changed(this.state());
    try {
      let next: typeof this.queuedRefresh = { context, newlyReadable: new Set(newlyReadable) };
      while (next) {
        this.queuedRefresh = undefined;
        await this.readProviders(next.context(), next.newlyReadable);
        next = this.queuedRefresh;
      }
    } finally {
      this.refreshing = false;
      this.changed(this.state());
    }
  }

  private async readProviders(ctx: C, newlyReadable: ReadonlySet<string>) {
    const now = Date.now();
    const run = async (id: string) => {
      if (!this.registry.configured(id, ctx)) {
        this.accept(this.registry.unconfigured(id, ctx, now));
        return;
      }
      // A newly readable provider can recover from a failed read without waiting for the cooldown.
      if (!newlyReadable.has(id) && now - (this.lastAttempt.get(id) ?? -Infinity) < QUOTA_TTL)
        return;
      if (
        [...(this.providers.get(id)?.rows.values() ?? [])].every(
          (r) => r.availability === "available" && now - r.observedAt < QUOTA_TTL,
        )
      )
        return;
      this.lastAttempt.set(id, now);
      try {
        this.accept(await this.registry.read(id, ctx), now);
      } catch {
        this.accept({ ...unavailable(id, now), reason: "usage unavailable" });
      }
    };
    await Promise.all(this.registry.ids.map(run));
  }
}
