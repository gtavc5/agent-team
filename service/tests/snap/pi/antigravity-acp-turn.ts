import { expect } from "vitest";
import { agentMessages, fixture } from "../fixture.ts";
import { captures } from "../pi-captures.ts";

export default fixture({
  ...captures["antigravity-acp-turn"],
  verify(r) {
    expect(r.pi!.checkpoints.stats.contextUsage).toMatchObject({
      model: "antigravity-acp/gemini-4-neon",
      totalTokens: 15444,
      maxTokens: 1000000,
    });
    expect(agentMessages(r)[0].events).toEqual([
      expect.objectContaining({ kind: "thinking" }),
      expect.objectContaining({ kind: "tool_use", toolName: "read", toolResult: "x".repeat(31) }),
    ]);
  },
});
