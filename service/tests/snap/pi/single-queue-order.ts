import { expect } from "vitest";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  description: "Without a steering boundary, Pi dispatches queued prompts FIFO after settlement.",
  steps: [
    { op: "send", text: "First prompt." },
    { op: "send", text: "Second prompt." },
    { op: "send", text: "Third prompt." },
    { op: "check", name: "queued" },
    { op: "check", name: "second" },
    { op: "check", name: "third" },
  ],
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
    expect(agentMessages(r).map((m) => m.content)).toEqual([
      "First reply.",
      "Second reply.",
      "Third reply.",
    ]);
  },
});
