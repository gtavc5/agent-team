import { expect } from "vitest";
import { fixture } from "../fixture.ts";

export default fixture({
  description: "Foreground child results reconstruct separate detail cards.",
  steps: [{ op: "send", text: "pi-e2e-launch:foreground" }],
  verify(r) {
    expect(
      r.events
        .filter((e) => e.kind === "subagent_done")
        .map((e) => [
          e.subagent?.taskId,
          e.subagent?.model,
          e.subagent?.effort,
          e.subagent?.events,
        ]),
    ).toEqual([
      ["id-1:0", "pi-e2e/scenario", "sample", [{ kind: "text", content: "x".repeat(18) }]],
      ["id-1:1", "pi-e2e/scenario", "sample", [{ kind: "text", content: "x".repeat(17) }]],
    ]);
  },
});
