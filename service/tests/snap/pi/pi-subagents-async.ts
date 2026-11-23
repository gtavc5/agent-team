import { expect } from "vitest";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  description: "An async Pi subagent waits, then a notify backfills its original card on wake-up.",
  files: {
    "child.jsonl":
      '{"type":"session","version":3,"id":"child"}\n{"type":"message","id":"leaf","parentId":null,"message":{"role":"assistant","content":[{"type":"thinking","thinking":"Child reasoning."},{"type":"text","text":"Child evidence."}]}}\n',
  },
  steps: [
    { op: "send", text: "Delegate an async sample." },
    { op: "check", name: "waiting" },
    { op: "check", name: "notified" },
  ],
  verify(r) {
    expect(
      agentMessages(r)[0].events!.find((e) => e.kind === "subagent_start")?.subagent,
    ).toMatchObject({
      taskId: "child:0",
      status: "completed",
      summary: "Child complete.",
      events: [
        { kind: "thinking", content: "Child reasoning." },
        { kind: "text", content: "Child evidence." },
      ],
    });
    expect(r.events.filter((e) => e.kind === "subagent_done")).toHaveLength(1);
    expect(r.pi!.checkpoints.waiting).toMatchObject({
      runState: "waiting",
      backgroundTasks: [{ id: "child:0", cancellable: true }],
      terminalCount: 1,
    });
    expect(r.pi!.checkpoints.notified).toMatchObject({
      runState: "working",
      backgroundTasks: [],
      terminalCount: 1,
    });
    expect(r.events).toContainEqual(expect.objectContaining({ kind: "notice", level: "wakeup" }));
  },
});
