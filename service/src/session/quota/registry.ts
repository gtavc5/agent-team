import { snapshotSchema, unavailable, type QuotaSnapshot } from "../quota-schema";

export interface QuotaProviderAdapter<C> {
  id: string;
  coalescesByCredential?: boolean;
  isConfigured(ctx: C): boolean;
  unconfiguredReason?(ctx: C): QuotaSnapshot["reason"];
  fetchQuota(ctx: C, signal: AbortSignal): Promise<QuotaSnapshot>;
}

export class QuotaAdapterRegistry<C> {
  private readonly adapters = new Map<string, QuotaProviderAdapter<C>>();
  private readonly pending = new Map<string, Promise<QuotaSnapshot>>();
  constructor(
    adapters: QuotaProviderAdapter<C>[],
    private readonly timeoutMs = 45_000,
  ) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) throw new Error(`Duplicate quota adapter: ${adapter.id}`);
      this.adapters.set(adapter.id, adapter);
    }
  }
  get ids() {
    return [...this.adapters.keys()];
  }
  configured(id: string, ctx: C) {
    try {
      return this.adapters.get(id)?.isConfigured(ctx) === true;
    } catch {
      return false;
    }
  }

  unconfigured(id: string, ctx: C, at = Date.now()): QuotaSnapshot {
    return {
      ...unavailable(id, at),
      reason: this.adapters.get(id)?.unconfiguredReason?.(ctx) ?? "not configured",
    };
  }

  read(id: string, ctx: C): Promise<QuotaSnapshot> {
    const adapter = this.adapters.get(id);
    if (!adapter)
      return Promise.resolve({
        ...unavailable(id),
        availability: "unsupported",
        reason: "no quota adapter",
      });
    if (!this.configured(id, ctx)) return Promise.resolve(this.unconfigured(id, ctx));
    const startedAt = Date.now();
    const pending = this.pending.get(id);
    if (pending) return pending;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error("Quota timed out"));
      }, this.timeoutMs);
    });
    const work = Promise.race([
      Promise.resolve().then(() => adapter.fetchQuota(ctx, abort.signal)),
      timeout,
    ])
      .then((raw) => {
        const s = snapshotSchema.parse(raw);
        if (s.provider !== id) throw new Error("Incorrect quota source");
        return s;
      })
      .catch((): QuotaSnapshot => ({ ...unavailable(id, startedAt), reason: "usage unavailable" }))
      .finally(() => {
        clearTimeout(timer);
        this.pending.delete(id);
      });
    if (!adapter.coalescesByCredential) this.pending.set(id, work);
    return work;
  }
}
