import {
  CONFIGURED_EVENT,
  SNAPSHOT_EVENT,
  REFRESH_EVENT,
  providerId,
  type QuotaSnapshot,
} from "./quota-schema";
import { piAdapters } from "./quota/pi-adapters";
import type { PiQuotaContext } from "./quota/pi-context";
interface CommandContext {
  model?: { provider: string };
  modelRegistry: PiQuotaContext["modelRegistry"];
  ui: { notify(text: string, level: "info" | "warning"): void };
}
interface ExtensionApi {
  events: {
    on(name: string, handler: (value: unknown) => void | Promise<void>): unknown;
    emit(name: string, value: unknown): void;
  };
  on(name: "session_start", handler: (event: unknown, ctx: CommandContext) => void): void;
  registerCommand(
    name: string,
    command: { description: string; handler(args: string, ctx: CommandContext): Promise<void> },
  ): void;
}
export default function piQuota(pi: ExtensionApi) {
  const registry = piAdapters();
  let current: CommandContext | undefined;
  pi.on("session_start", (_e, ctx) => {
    current = ctx;
  });
  async function publish(id: string, ctx: CommandContext) {
    const s = await registry.read(id, { events: pi.events, modelRegistry: ctx.modelRegistry });
    pi.events.emit(SNAPSHOT_EVENT, s);
    return s;
  }
  pi.events.on(CONFIGURED_EVENT, (reply) => {
    if (current && typeof reply === "function")
      (reply as (ids: string[]) => void)(
        registry.ids.filter((id) =>
          registry.configured(id, { events: pi.events, modelRegistry: current!.modelRegistry }),
        ),
      );
  });
  pi.events.on(REFRESH_EVENT, (raw) => {
    const request = raw as { provider?: string; reply?: (s: QuotaSnapshot) => void } | null;
    if (
      !current ||
      !request?.provider ||
      !providerId.safeParse(request.provider).success ||
      request.provider.startsWith("native-") ||
      typeof request.reply !== "function"
    )
      return;
    return publish(request.provider, current).then(request.reply);
  });
  pi.registerCommand("quota", {
    description: "Show account quota across configured providers",
    handler: async (_args, ctx) => {
      const id = providerId.safeParse(ctx.model?.provider);
      const ids = new Set(registry.ids);
      if (id.success && !id.data.startsWith("native-")) ids.add(id.data);
      const samples = await Promise.all([...ids].map((p) => publish(p, ctx)));
      const lines = samples.map((s) =>
        s.availability !== "available"
          ? `${s.provider}: ${s.availability}${s.reason ? ` (${s.reason})` : ""}`
          : [
              `${s.provider} quota`,
              ...s.groups.flatMap((g) =>
                g.windows.map(
                  (w) =>
                    `${g.name} · ${w.label}: ${w.usedPct}% used${w.resetsAt ? ` (resets ${new Date(w.resetsAt).toISOString()})` : ""}`,
                ),
              ),
            ].join("\n"),
      );
      ctx.ui.notify(
        lines.join("\n"),
        samples.some((s) => s.availability === "available") ? "info" : "warning",
      );
    },
  });
}
