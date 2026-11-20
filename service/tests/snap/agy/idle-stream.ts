import { expect } from "vitest";
import { agentMessages, fixture, send, wait } from "../fixture.ts";

export default fixture({
  description:
    "a message sent while agy streams a reply of its own waits for that model call's end, and its reply opens with agy's, once and whole",
  // Thoughts stream at this level (none at low).
  effort: "high",
  steps: [
    send(
      "Run the shell command `sleep 25 && echo bg-finished` as a background task and do not wait for it: reply with the single word started and end your turn right away. Later, when you are told that this command finished, use no tool: write an original six-line poem about a lighthouse, its first word being zebra in capital letters, and end your turn.",
    ),
    wait("result"),
    // agy's own reply to the command's end, streaming while no prompt runs.
    wait({ frame: "ZEBRA" }),
    send("Reply with the single word here."),
    wait("idle"),
  ],
  verify(r) {
    const messages = agentMessages(r);
    const texts = messages.map((m) => m.content);
    // The message came while agy streamed the poem: the load before the
    // prompt waited for that model call's end, so the poem shows once and
    // whole, opening the reply to the message.
    expect(texts.join("\n").match(/ZEBRA/g)).toHaveLength(1);
    const reply = messages.find((m) => m.content.includes("ZEBRA"))!;
    const lines = reply.content
      .trim()
      .split("\n")
      .filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(7);
    expect(lines.at(-1)!.trim()).toBe("here");
    expect(texts.join("\n").match(/\bhere\b/g)).toHaveLength(1);
    // The command's end names the wake-up that opens it.
    expect(reply.events![0]).toMatchObject({ kind: "notice", level: "wakeup" });
    expect(reply.events![0].content).toContain("sleep 25");
  },
});
