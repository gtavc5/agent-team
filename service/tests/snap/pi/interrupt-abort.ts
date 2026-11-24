import { expect } from "vitest";
import { captures } from "../pi-captures.ts";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  ...captures["interrupt-abort"],
  verify(r) {
    expect(r.pi!.sent.map((m) => m.type)).toEqual(["prompt", "abort", "get_session_stats"]);
    expect(r.pi!.checkpoints.aborting).toMatchObject({ runState: "working", terminalCount: 0 });
    expect(r.events.filter((e) => e.kind === "result")).toEqual([
      expect.objectContaining({ interrupted: true }),
    ]);
    expect(agentMessages(r)[0].content).toContain("interrupted");
  },
});
