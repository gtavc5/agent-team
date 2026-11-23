import { expect } from "vitest";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  description: "Pi reads a seeded, temporary 1×1 PNG through the workspace attachment envelope.",
  steps: [
    { op: "image", text: "Describe this pixel.", seed: 17 },
    { op: "check", name: "dispatched" },
    { op: "check", name: "retained" },
  ],
  verify(r) {
    const { dispatched, retained } = r.pi!.checkpoints;
    expect(dispatched.lastEnvelope).toMatchObject({
      text: "Describe this pixel.",
      attachmentIds: ["pixel.png"],
    });
    expect(retained.lastEnvelope).toEqual(dispatched.lastEnvelope);
    // The player already compared the exact encoded PNG to its seeded bytes.
    expect(r.pi!.sent[0].images).toHaveLength(1);
    expect(agentMessages(r)[0].content).toBe("One synthetic pixel.");
  },
});
