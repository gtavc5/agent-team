// The transcript on narrow screens and touch: nothing said twice, nothing
// pushed off the row, no invisible tap targets over the text.
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { EventItem, MessageItem, SubAgentItem } from "../src/chat/messages";
import type { AgentInfo, Message, StreamEvent, SubAgentInfo } from "../src/state/useServer";

const agent: AgentInfo = {
  id: "a1",
  name: "Alice",
  model: "claude-opus-5-5",
  avatar: "A",
  color: "#888",
  isDefault: true,
};

describe("the transcript", () => {
  it("counts up a running call's time in the footer and its row, then shows how long it took", () => {
    vi.useFakeTimers();
    try {
      const call: StreamEvent = {
        kind: "tool_use",
        toolName: "Cursor",
        content: "**Cursor** a tool the SDK does not show (an await, a web search, …)",
        toolUseId: "cursor-hidden-1",
        startedAt: Date.now() - 37_000,
      };
      const msg: Message = {
        id: "m0",
        kind: "agent",
        agentId: "a1",
        content: "",
        timestamp: 0,
        status: "streaming",
        events: [call],
      };
      const { container, rerender } = render(<MessageItem msg={msg} agents={[agent]} />);
      const footer = () => container.querySelector(".turn-footer")?.textContent;
      const row = () => container.querySelector(".event-time")?.textContent;
      expect(footer()).toBe("Cursor · 37s");
      fireEvent.click(container.querySelector(".step-header")!);
      expect(row()).toBe("37s");
      act(() => {
        vi.advanceTimersByTime(25_000);
      });
      expect([footer(), row()]).toEqual(["Cursor · 1m 2s", "1m 2s"]);
      // What the backend says it is doing comes first.
      const busy = { ...agent, activity: "Bash · 40s" };
      rerender(<MessageItem msg={msg} agents={[busy]} />);
      expect(footer()).toBe("Bash · 40s");
      const ended = { ...call, toolResult: "done", durationMs: 63_000 };
      rerender(<MessageItem msg={{ ...msg, events: [ended] }} agents={[agent]} />);
      expect([footer(), row()]).toEqual([undefined, "1m 3s"]);
      // A turn that stopped with the call open (a restart) counts nothing.
      rerender(<MessageItem msg={{ ...msg, status: "done" }} agents={[agent]} />);
      expect(container.querySelector(".event-row")).not.toBeNull();
      expect([footer(), row()]).toEqual([undefined, undefined]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names an edited file once: in its block under the row, not again atop the diff", () => {
    const ev: StreamEvent = {
      kind: "tool_use",
      toolName: "Edit",
      content: "**Edit** `src/session/claude.ts`\n```diff\n-const a = 1;\n+const a = 2;\n```",
    };
    const { container } = render(<EventItem ev={ev} />);
    expect(container.querySelector(".event-summary-line code")!.textContent).toBe(
      "src/session/claude.ts",
    );
    const body = container.querySelector(".event-content")!.textContent;
    expect(body).toContain("const a = 2;");
    expect(body).not.toContain("src/session/claude.ts");
  });

  it("writes a file tool's path out whole in a block under its row, the row keeping the tool's name", () => {
    const path = "/home/ykiko/workspace/agent-team/webview/src/chat/messages.tsx";
    const write = render(
      <EventItem
        ev={{
          kind: "tool_use",
          toolName: "Write",
          content: `**Write** \`${path}\`\n\`\`\`tsx\nexport {};\n\`\`\``,
        }}
      />,
    ).container;
    expect(write.querySelector(".event-row .event-chip")!.textContent).toBe("Write");
    expect(write.querySelector(".event-summary-line code")!.textContent).toBe(path);
    // The body is the file's content, without the path again.
    expect(write.querySelector(".event-content")!.textContent).not.toContain(path);
    // A Bash call has no summary: its command is the body already.
    const bash = render(
      <EventItem
        ev={{ kind: "tool_use", toolName: "Bash", content: "**Bash**\n```bash\nls\n```" }}
      />,
    ).container;
    expect(bash.querySelector(".event-summary-line")).toBeNull();
  });

  it("shows how long each tool call and task ran, a quick one in milliseconds", () => {
    const call = (durationMs?: number) =>
      render(
        <EventItem
          ev={{
            kind: "tool_use",
            toolName: "Bash",
            content: "**Bash**\n```bash\nmake\n```",
            toolResult: "ok",
            ...(durationMs != null && { durationMs }),
          }}
        />,
      ).container.querySelector(".event-row .event-time")?.textContent ?? null;
    expect(call(4230)).toBe("4.2s");
    expect(call(38)).toBe("38ms");
    // Recorded before it was measured: nothing, not "0ms".
    expect(call()).toBeNull();
    const card = render(
      <SubAgentItem
        ev={{
          kind: "subagent_start",
          content: "",
          subagent: {
            taskId: "b1",
            description: "sleep 6",
            agentType: "shell",
            taskType: "local_bash",
            status: "completed",
            durationMs: 6004,
          },
        }}
      />,
    ).container;
    expect(card.querySelector(".subagent-header .subagent-time")!.textContent).toBe("6s");
    // A thinking block keeps its own time, in its label.
    const thought = render(
      <EventItem ev={{ kind: "thinking", content: "hm", durationMs: 2700 }} />,
    );
    expect(thought.container.querySelector(".event-time")).toBeNull();
  });

  it("gives a card one time: this run's, or a finished agent's from the CLI on old records", () => {
    const agentCard = (sa: Partial<SubAgentInfo>) =>
      render(
        <SubAgentItem
          ev={{
            kind: "subagent_start",
            content: "",
            subagent: {
              taskId: "a1",
              description: "look",
              agentType: "Explore",
              status: "completed",
              ...sa,
            },
          }}
        />,
      ).container;
    const time = (c: HTMLElement) => c.querySelector(".subagent-time")?.textContent ?? null;
    const usage = { totalTokens: 14_000, toolUses: 3, durationMs: 43_600 };
    // Resumed: the CLI counts from the first run, idle time included.
    const resumed = agentCard({ usage, durationMs: 27_800 });
    expect(time(resumed)).toBe("27.8s");
    expect(time(agentCard({ usage }))).toBe("43.6s");
    expect(time(agentCard({ usage, status: "running" }))).toBeNull();
  });
});
