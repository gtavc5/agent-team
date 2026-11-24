import { expect } from "vitest";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  description:
    "A Pi crash closes open work and does not re-send an unaccepted prompt; the saved session resumes.",
  steps: [
    { op: "send", text: "pi-e2e-git-ready" },
    { op: "send", text: "pi-e2e-launch:foreground" },
    { op: "check", name: "beforeCrash" },
    { op: "check", name: "afterCrash" },
    { op: "send", text: "check retained notices" },
    { op: "check", name: "restored" },
  ],
  verify(r) {
    const { beforeCrash, afterCrash, restored } = r.pi!.checkpoints;
    expect(beforeCrash).toMatchObject({
      userStatuses: ["done", "dispatching"],
      runState: "working",
      terminalCount: 1,
    });
    expect(afterCrash).toMatchObject({
      userStatuses: ["done", "outcome_unknown"],
      runState: "idle",
      terminalCount: 2,
    });
    expect(restored.generation).toBe(beforeCrash.generation! + 1);
    expect(restored.prompts).toEqual([
      "pi-e2e-git-ready",
      "pi-e2e-launch:foreground",
      "check retained notices",
    ]);
    expect(r.pi!.connections).toEqual([{ restored: false }, { restored: true }]);
    const [, crashed, recovered] = agentMessages(r);
    expect(crashed.status).toBe("error");
    expect(
      crashed.events!.filter((e) => e.kind === "tool_use").map((e) => e.toolResultIsError),
    ).toEqual([true, true]);
    expect(crashed.events!.find((e) => e.kind === "subagent_start")?.subagent?.status).toBe(
      "stopped",
    );
    expect(recovered).toMatchObject({
      status: "done",
      content: expect.stringMatching(/^x+$/) as unknown,
    });
  },
});
