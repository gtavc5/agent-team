import { expect } from "vitest";
import { fixture } from "../fixture.ts";

export default fixture({
  description: "A native async notify backfills both original child cards on wake-up.",
  steps: [
    { op: "send", text: "pi-e2e-launch:reconcile" },
    { op: "check", name: "waiting" },
    { op: "check", name: "notified" },
  ],
  verify(r) {
    expect(r.pi!.checkpoints.waiting).toMatchObject({
      runState: "waiting",
      terminalCount: 1,
      backgroundTasks: [
        { id: "id-1:0", cancellable: true },
        { id: "id-1:1", cancellable: true },
      ],
    });
    expect(r.pi!.checkpoints.notified).toMatchObject({
      runState: "working",
      terminalCount: 1,
      backgroundTasks: [],
    });
    expect(
      r.events
        .filter((e) => e.kind === "subagent_done")
        .map((e) => [e.subagent?.taskId, e.subagent?.status]),
    ).toEqual([
      ["id-1:0", "completed"],
      ["id-1:1", "completed"],
    ]);
    expect(r.events).toContainEqual(expect.objectContaining({ kind: "notice", level: "wakeup" }));
  },
});
