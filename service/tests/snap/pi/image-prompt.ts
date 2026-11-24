import { expect } from "vitest";
import { captures } from "../pi-captures.ts";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  ...captures["image-prompt"],
  verify(r) {
    const { dispatched, retained } = r.pi!.checkpoints;
    expect(dispatched.lastEnvelope).toMatchObject({
      text: "Describe this pixel.",
      attachmentIds: ["pixel.png"],
    });
    expect(retained.lastEnvelope).toEqual(dispatched.lastEnvelope);
    // The player already compared the exact encoded PNG to its seeded bytes.
    expect(r.pi!.sent[0].images).toHaveLength(1);
    expect(agentMessages(r)[0].content).toMatch(/^x+$/);
  },
});
