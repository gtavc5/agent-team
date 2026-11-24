import { expect } from "vitest";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  description: "Compaction and retry do not settle Pi early; unknown context tokens stay unknown.",
  steps: [
    { op: "send", text: "Retry a sample." },
    { op: "check", name: "retry" },
    { op: "check", name: "compacting" },
    { op: "check", name: "compacted" },
    { op: "check", name: "progress" },
    { op: "check", name: "settled" },
  ],
  verify(r) {
    const { retry, compacting, compacted, progress, settled } = r.pi!.checkpoints;
    for (const phase of [retry, compacting, compacted, progress])
      expect(phase).toMatchObject({ runState: "working", terminalCount: 0 });
    expect(retry.retryBanner).toBe("Retrying (1/3 in 2s): Synthetic transient error.");
    expect(compacted.retryBanner).toBe(retry.retryBanner);
    expect(progress.retryBanner).toBeNull();
    expect(settled).toMatchObject({
      runState: "idle",
      terminalCount: 1,
      contextUsage: null,
      retryBanner: null,
    });
    expect(r.events.filter((e) => e.kind === "retry").map((e) => e.content)).toEqual([
      retry.retryBanner,
      "",
    ]);
    expect(agentMessages(r)[0].events?.map((e) => [e.kind, e.content])).toEqual([
      ["compact", "Compacting context (threshold)"],
      ["compact", "Context compacted (threshold): 900 → ~320 tokens"],
    ]);
  },
});
