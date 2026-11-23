import { expect } from "vitest";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  description: "Pi streams thinking and text, then settles with usage and context.",
  steps: [
    { op: "send", text: "Describe a sample." },
    { op: "check", name: "stats" },
  ],
  verify(r) {
    expect(r.events.filter((e) => e.kind === "thinking_delta").map((e) => e.content)).toEqual([
      "Consider the example.",
      "",
    ]);
    expect(agentMessages(r)[0]).toMatchObject({
      status: "done",
      content: "A synthetic reply.",
      context: { tokens: 7, window: 1000 },
    });
    expect(r.sessions[0].usage).toMatchObject({
      input_tokens: 6,
      output_tokens: 3,
      cache_read_tokens: 1,
      turns: 1,
    });
    expect(r.pi!.checkpoints.stats.contextUsage).toMatchObject({
      totalTokens: 7,
      maxTokens: 1000,
      model: "synthetic/pi-model",
    });
  },
});
