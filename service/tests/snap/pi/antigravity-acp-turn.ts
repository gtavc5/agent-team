import { expect } from "vitest";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  description: "A synthetic Antigravity ACP model projects reasoning, tool use and context.",
  model: "antigravity-acp/synthetic-model",
  steps: [
    { op: "send", text: "Run the synthetic ACP turn." },
    { op: "check", name: "stats" },
  ],
  verify(r) {
    expect(r.pi!.checkpoints.stats.contextUsage).toMatchObject({
      model: "antigravity-acp/synthetic-model",
      totalTokens: 7,
      maxTokens: 1000,
    });
    expect(agentMessages(r)[0].events).toEqual([
      expect.objectContaining({ kind: "thinking" }),
      expect.objectContaining({ kind: "tool_use", toolName: "read", toolResult: "Example text." }),
    ]);
  },
});
