import { expect } from "vitest";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  description: "Recorded Panel calls persist Notes, Board and Journal effects through HTTP.",
  piProject: true,
  steps: [
    { op: "send", text: "pi-e2e-lead-plan" },
    { op: "panelCall", callId: "objective" },
    { op: "send", text: "[From the project lead]\n\npi-e2e-worker-notes" },
    { op: "panelCall", callId: "note" },
    { op: "send", text: "pi-e2e-finish" },
    { op: "panelCall", callId: "report" },
  ],
  verify(r) {
    const calls = agentMessages(r).flatMap((m) => m.events!.filter((e) => e.kind === "tool_use"));
    expect(calls.map((e) => [e.toolName, e.toolSource, e.toolResultIsError ?? false])).toEqual([
      ["mcp__panel__write_objective", "panel", false],
      ["mcp__panel__write_note", "panel", false],
      ["mcp__panel__finish_task", "panel", false],
    ]);
    expect(calls[0].toolResult).toContain("Updated pi-e2e/suite");
    expect(calls[2].toolResult).toBe("Reported to the lead.");
  },
});
