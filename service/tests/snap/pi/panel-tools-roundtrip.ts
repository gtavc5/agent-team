import { expect } from "vitest";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  description:
    "Synthetic Pi tool anchors call real Panel HTTP and persist Notes, Board and Journal effects.",
  piProject: true,
  steps: [
    { op: "send", text: "Record a project update." },
    { op: "panelCall", callId: "note" },
    { op: "panelCall", callId: "objective" },
    { op: "panelCall", callId: "report" },
  ],
  verify(r) {
    const calls = agentMessages(r)[0].events!.filter((e) => e.kind === "tool_use");
    expect(calls.map((e) => [e.toolName, e.toolSource, e.toolResultIsError ?? false])).toEqual([
      ["mcp__panel__write_note", "panel", false],
      ["mcp__panel__write_objective", "panel", false],
      ["mcp__panel__finish_task", "panel", false],
    ]);
    expect(calls[1].toolResult).toContain("Updated demo/replay");
    expect(calls[2].toolResult).toBe("Reported to the lead.");
  },
});
