import { expect } from "vitest";
import { captures } from "../pi-captures.ts";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  ...captures["single-queue-order"],
  verify(r) {
    const { queued, second, third } = r.pi!.checkpoints;
    expect(queued).toMatchObject({
      canSteer: false,
      runState: "working",
      userStatuses: ["done", "queued", "queued"],
      prompts: ["First prompt."],
      terminalCount: 0,
    });
    expect(second).toMatchObject({
      userStatuses: ["done", "done", "queued"],
      prompts: ["First prompt.", "Second prompt."],
      terminalCount: 1,
    });
    expect(third).toMatchObject({
      userStatuses: ["done", "done", "done"],
      prompts: ["First prompt.", "Second prompt.", "Third prompt."],
      terminalCount: 3,
    });
    expect(agentMessages(r)).toHaveLength(3);
    for (const m of agentMessages(r)) expect(m.content).toMatch(/^x+$/);
  },
});
