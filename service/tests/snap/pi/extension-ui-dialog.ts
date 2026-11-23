import { expect } from "vitest";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  description: "A blocking extension dialog still allows stdout frames before the user responds.",
  steps: [
    { op: "send", text: "Ask for confirmation." },
    { op: "check", name: "dialogOpen" },
    { op: "uiDialogResponse", requestId: "confirmation", confirmed: true },
  ],
  verify(r) {
    expect(r.pi!.dialogs).toEqual([
      { kind: "request", id: "confirmation" },
      { kind: "resolved", id: "confirmation" },
    ]);
    expect(r.pi!.checkpoints.dialogOpen).toMatchObject({
      runState: "working",
      terminalCount: 0,
      thinkingClosed: true,
      pendingDialogIds: ["confirmation"],
    });
    expect(agentMessages(r)[0]).toMatchObject({ content: "Confirmed.", status: "done" });
  },
});
