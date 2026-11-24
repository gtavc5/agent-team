import { expect } from "vitest";
import { captures } from "../pi-captures.ts";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  ...captures["extension-ui-dialog"],
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
    expect(agentMessages(r)[0]).toMatchObject({
      content: expect.stringMatching(/^x+$/) as unknown,
      status: "done",
    });
  },
});
