import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageItem } from "../src/chat/messages";
import { resetLocaleForTests, setServerLanguage } from "../src/i18n";
import type { AgentInfo, Message } from "../src/state/useServer";

const ALICE: AgentInfo = {
  id: "a1",
  name: "Alice",
  model: "claude-opus-5-5",
  avatar: "🤖",
  color: "#888",
  isDefault: true,
};

const BOB: AgentInfo = {
  id: "a2",
  name: "Bob",
  model: "gpt-5.6",
  avatar: "🧠",
  color: "#4a9",
  isDefault: false,
};

const agentMsg = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  kind: "agent",
  agentId: "a1",
  content: "Done",
  timestamp: 0,
  status: "done",
  ...over,
});

afterEach(() => {
  cleanup();
  resetLocaleForTests();
  vi.restoreAllMocks();
});

describe("MessageItem mention action", () => {
  it("shows the mention button on a finished multi-agent turn tail, defaulting isTurnTail to true", () => {
    const onMentionAgent = vi.fn();
    const { container, rerender } = render(
      <MessageItem msg={agentMsg()} agents={[ALICE, BOB]} onMentionAgent={onMentionAgent} />,
    );

    const omitted = container.querySelector(".btn-mention-agent")!;
    expect(omitted).toBeTruthy();
    expect(omitted.getAttribute("data-agent-id")).toBe("a1");
    expect(omitted.textContent).toBe("@Alice");
    expect(onMentionAgent).not.toHaveBeenCalled();

    rerender(
      <MessageItem
        msg={agentMsg()}
        agents={[ALICE, BOB]}
        onMentionAgent={onMentionAgent}
        isTurnTail={true}
      />,
    );
    expect(container.querySelector(".btn-mention-agent")).toBeTruthy();
  });

  it("calls onMentionAgent with the exact agent object when clicked", () => {
    const onMentionAgent = vi.fn();
    render(<MessageItem msg={agentMsg()} agents={[ALICE, BOB]} onMentionAgent={onMentionAgent} />);

    fireEvent.click(screen.getByRole("button", { name: "Reply to @Alice" }));
    expect(onMentionAgent).toHaveBeenCalledWith(ALICE);
  });

  it("hides the button in a single-agent workspace", () => {
    const { container } = render(
      <MessageItem msg={agentMsg()} agents={[ALICE]} onMentionAgent={vi.fn()} />,
    );
    expect(container.querySelector(".btn-mention-agent")).toBeNull();
  });

  it("hides the button while the agent message is streaming", () => {
    const { container } = render(
      <MessageItem
        msg={agentMsg({ status: "streaming" })}
        agents={[ALICE, BOB]}
        onMentionAgent={vi.fn()}
      />,
    );
    expect(container.querySelector(".btn-mention-agent")).toBeNull();
  });

  it("hides the button on user messages", () => {
    const { container } = render(
      <MessageItem
        msg={agentMsg({ kind: "user", agentId: null, content: "hi" })}
        agents={[ALICE, BOB]}
        onMentionAgent={vi.fn()}
      />,
    );
    expect(container.querySelector(".btn-mention-agent")).toBeNull();
  });

  it("hides the button on an intermediate message of a multi-message turn", () => {
    const { container } = render(
      <MessageItem
        msg={agentMsg()}
        agents={[ALICE, BOB]}
        onMentionAgent={vi.fn()}
        isTurnTail={false}
      />,
    );
    expect(container.querySelector(".btn-mention-agent")).toBeNull();
  });

  it("hides the button when the author agent is no longer in the workspace", () => {
    const { container } = render(
      <MessageItem msg={agentMsg()} agents={[BOB]} onMentionAgent={vi.fn()} />,
    );
    expect(container.querySelector(".btn-mention-agent")).toBeNull();
  });

  it("hides the button when no onMentionAgent callback is provided", () => {
    const { container } = render(<MessageItem msg={agentMsg()} agents={[ALICE, BOB]} />);
    expect(container.querySelector(".btn-mention-agent")).toBeNull();
  });

  it("renders localized title and aria-label in en and zh-CN", () => {
    const { container } = render(
      <MessageItem msg={agentMsg()} agents={[ALICE, BOB]} onMentionAgent={vi.fn()} />,
    );

    let button = container.querySelector(".btn-mention-agent")!;
    expect(button.getAttribute("title")).toBe("Reply to @Alice");
    expect(button.getAttribute("aria-label")).toBe("Reply to @Alice");

    act(() => setServerLanguage("zh-CN"));
    button = container.querySelector(".btn-mention-agent")!;
    expect(button.getAttribute("title")).toBe("回复 @Alice");
    expect(button.getAttribute("aria-label")).toBe("回复 @Alice");
  });
});
