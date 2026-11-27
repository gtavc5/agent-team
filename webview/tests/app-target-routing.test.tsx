import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { render, act, fireEvent, cleanup, screen } from "@testing-library/react";
import { resolveTargetState } from "../src/composer/targetRouting";
import { App } from "../src/App";
import type { AgentInfo, Message, Project } from "../src/state/useServer";
import { FakeSocket } from "./fakeSocket";

class ReactSocket extends FakeSocket {
  override receive(frame: unknown) {
    act(() => super.receive(frame));
  }
  override drop() {
    act(() => super.drop());
  }
}

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

const agentMsg = (id: string, agentId: string, over: Partial<Message> = {}): Message => ({
  id,
  kind: "agent",
  agentId,
  content: `reply ${id}`,
  timestamp: 1000,
  status: "done",
  ...over,
});

interface BootWorkspace {
  id: string;
  name: string;
  agents: AgentInfo[];
  projectLink?: { projectId: string; role: "lead" | "worker" };
  messages?: Message[];
}

function boot(workspaces: BootWorkspace[], projects: Project[] = [], language = "en") {
  render(<App />);
  const sock = FakeSocket.instances.at(-1)!;
  act(() => sock.open());
  sock.receive({
    type: "init",
    sendReceipt: false,
    projects,
    workspaces: workspaces.map((w, idx) => ({
      id: w.id,
      name: w.name,
      project: "p",
      hostId: "local",
      cwd: "/tmp",
      agents: w.agents,
      projectLink: w.projectLink,
      messages: [],
      createdAt: 100 - idx,
    })),
    config: {
      presets: [],
      models: [],
      commands: [],
      hosts: {},
      user: { name: "User", avatar: "U", language },
    },
    hosts: [],
  });
  for (const w of workspaces) {
    if (w.messages) {
      sock.receive({
        type: "workspace_messages",
        workspaceId: w.id,
        messages: w.messages,
        hasMore: false,
      });
    }
  }
  act(() => {
    vi.advanceTimersByTime(20);
  });
  return sock;
}

const composer = () => document.querySelector<HTMLTextAreaElement>("textarea.chat-input")!;
const targetBtn = () => document.querySelector<HTMLButtonElement>(".target-select-btn");
const mentionButtons = () => [
  ...document.querySelectorAll<HTMLButtonElement>(".btn-mention-agent"),
];
const sendFrames = (sock: FakeSocket) =>
  sock.frames().filter((f) => f.type === "send_message") as Array<
    Record<string, unknown> & { workspaceId: string; content: string; target?: string }
  >;

const selectWorkspace = (name: string) =>
  fireEvent.click(
    [...document.querySelectorAll(".task-item")].find(
      (el) => el.querySelector(".task-name-text")!.firstChild!.textContent === name,
    )!,
  );

async function sendText(text: string) {
  const input = composer();
  fireEvent.change(input, { target: { value: text, selectionStart: text.length } });
  fireEvent.keyDown(input, { key: "Enter" });
  await act(async () => {});
}

let scrollIntoView: MockInstance<(arg?: boolean | ScrollIntoViewOptions) => void>;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", ReactSocket);
  scrollIntoView = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Same-room peer discussion controls", () => {
  it("deduplicates valid multi-target mentions in order and expands both all aliases", () => {
    const agents = [ALICE, BOB];
    for (const text of ["@Bob @Alice @Bob hello", "@Bob @all hello", "@Bob @全体 hello"]) {
      const state = resolveTargetState(agents, ALICE.id, text);
      expect(state.targetAgents).toEqual([BOB, ALICE]);
      expect(state.sendTarget).toBeUndefined();
    }
    expect(resolveTargetState(agents, BOB.id, "@Alice hi").targetAgents).toEqual([ALICE]);
    expect(
      resolveTargetState(agents, BOB.id, "@Alice ` @all `\n```\n@全体\n```").targetAgents,
    ).toEqual([ALICE]);
    expect(resolveTargetState(agents, BOB.id, "@all /usage").targetAgents).toEqual([ALICE]);
  });

  it("shows discussion controls only for a multi-target draft and sends the selected round count", async () => {
    const socket = boot([{ id: "w1", name: "Room", agents: [ALICE, BOB] }]);
    expect(screen.queryByText(/No cross-review|不互评/)).toBeNull();
    const text = "@all proposal";
    fireEvent.change(composer(), { target: { value: text, selectionStart: text.length } });
    expect(screen.getByText(/Send to Alice, Bob|发送给 Alice、Bob/)).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /No cross-review|不互评/ });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: /1 round|互评 1 轮/ }));
    expect(screen.getByRole("button", { name: /2 rounds|互评 2 轮/ })).toBeTruthy();
    fireEvent.keyDown(composer(), { key: "Enter" });
    await act(async () => {});
    expect(sendFrames(socket).at(-1)).toMatchObject({ content: text, discussionRounds: 2 });
    expect(screen.queryByText(/2 rounds|互评 2 轮/)).toBeNull();
    fireEvent.change(composer(), { target: { value: text, selectionStart: text.length } });
    expect(screen.getByRole("button", { name: /No cross-review|不互评/ })).toBeTruthy();
  });

  it("lets the target picker replace group routing", async () => {
    const socket = boot([{ id: "w1", name: "Room", agents: [ALICE, BOB] }]);
    const text = "@all proposal";
    fireEvent.change(composer(), { target: { value: text, selectionStart: text.length } });
    fireEvent.click(targetBtn()!);
    fireEvent.click(screen.getByText("Bob", { exact: true }));
    expect(composer().value).toBe("proposal");
    fireEvent.keyDown(composer(), { key: "Enter" });
    await act(async () => {});
    expect(sendFrames(socket).at(-1)).toMatchObject({ content: "proposal", target: BOB.id });
  });

  it.each([
    [
      "en",
      "Send to Alice, Bob",
      "No cross-review",
      "Cross-review 1/2",
      "Final synthesis",
      "Relay from Alice (2/2)",
      "2-hop limit reached",
    ],
    [
      "zh-CN",
      "发送给 Alice、Bob",
      "不互评",
      "交叉确认 1/2",
      "最终结论",
      "由 Alice 转交 (2/2)",
      "已达 2 跳上限",
    ],
  ])(
    "renders the %s composer and reply labels, including the live relay limit",
    (language, hint, toggle, review, synthesis, relay, limit) => {
      const socket = boot(
        [
          {
            id: "w1",
            name: "Room",
            agents: [ALICE, BOB],
            messages: [
              agentMsg("review", ALICE.id, { discussion: { kind: "review", round: 1, rounds: 2 } }),
              agentMsg("synthesis", ALICE.id, { discussion: { kind: "synthesis" } }),
              agentMsg("relay", BOB.id, {
                status: "streaming",
                discussion: { kind: "relay", from: "Alice", hop: 2 },
              }),
            ],
          },
        ],
        [],
        language,
      );
      fireEvent.change(composer(), { target: { value: "@all ", selectionStart: 5 } });
      expect(screen.getByText(hint)).toBeTruthy();
      expect(screen.getByRole("button", { name: toggle })).toBeTruthy();
      expect(screen.getByText(review)).toBeTruthy();
      expect(screen.getByText(synthesis)).toBeTruthy();
      expect(screen.getByText(relay)).toBeTruthy();
      socket.receive({
        type: "message_done",
        workspaceId: "w1",
        messageId: "relay",
        status: "done",
        content: "Done",
        discussion: { kind: "relay", from: "Alice", hop: 2, limitReached: true },
      });
      expect(screen.getByText(limit)).toBeTruthy();
    },
  );
});

describe("App target agent routing and quick @ mention", () => {
  it("shows TargetAgentSelect and bottom-right @AgentName only on finished turn-tail messages", () => {
    boot([
      {
        id: "w1",
        name: "Multi",
        agents: [ALICE, BOB],
        messages: [
          {
            id: "u1",
            kind: "user",
            agentId: null,
            content: "hi",
            timestamp: 900,
            status: "done",
          },
          agentMsg("m1", ALICE.id, { timestamp: 1000, turnId: "t1" }),
          agentMsg("m2", ALICE.id, { timestamp: 1001, turnId: "t1" }),
          agentMsg("m3", BOB.id, { timestamp: 1002, turnId: "t2" }),
          agentMsg("m4", BOB.id, { timestamp: 1003, turnId: "t3", status: "streaming" }),
        ],
      },
    ]);

    const btn = targetBtn()!;
    expect(btn).toBeTruthy();
    expect(btn.querySelector(".target-select-name")!.textContent).toBe("Alice");
    expect(btn.className).not.toContain("is-locked");

    // u1 (user): no button
    expect(document.querySelector("#msg-u1 .btn-mention-agent")).toBeNull();
    // m1 (intermediate in turn t1): no button
    expect(document.querySelector("#msg-m1 .btn-mention-agent")).toBeNull();
    // m2 (tail of turn t1): shows @Alice
    expect(document.querySelector("#msg-m2 .btn-mention-agent")!.textContent).toBe("@Alice");
    // m3 (tail of turn t2): shows @Bob
    expect(document.querySelector("#msg-m3 .btn-mention-agent")!.textContent).toBe("@Bob");
    // m4 (streaming): no button
    expect(document.querySelector("#msg-m4 .btn-mention-agent")).toBeNull();
    expect(mentionButtons()).toHaveLength(2);
  });

  it("locks target to Bob when clicking @Bob and sends consecutive messages with target=bob.id", async () => {
    const sock = boot([
      {
        id: "w1",
        name: "Multi",
        agents: [ALICE, BOB],
        messages: [agentMsg("m1", BOB.id, { timestamp: 1000 })],
      },
    ]);

    const bobBtn = document.querySelector<HTMLButtonElement>("#msg-m1 .btn-mention-agent")!;
    fireEvent.click(bobBtn);

    expect(document.activeElement).toBe(composer());
    expect(targetBtn()!.querySelector(".target-select-name")!.textContent).toBe("Bob");
    expect(targetBtn()!.className).toContain("is-locked");

    await sendText("first question");
    await sendText("follow-up question");

    const sends = sendFrames(sock);
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({
      workspaceId: "w1",
      content: "first question",
      target: BOB.id,
    });
    expect(sends[1]).toMatchObject({
      workspaceId: "w1",
      content: "follow-up question",
      target: BOB.id,
    });
    // Lock persists across sends
    expect(targetBtn()!.querySelector(".target-select-name")!.textContent).toBe("Bob");
    expect(targetBtn()!.className).toContain("is-locked");
  });

  it("supports temporary @Alice override while locked to Bob, then resumes routing to Bob", async () => {
    const sock = boot([
      {
        id: "w1",
        name: "Multi",
        agents: [ALICE, BOB],
        messages: [agentMsg("m1", BOB.id, { timestamp: 1000 })],
      },
    ]);

    fireEvent.click(document.querySelector("#msg-m1 .btn-mention-agent")!);
    expect(targetBtn()!.className).toContain("is-locked");

    const input = composer();
    fireEvent.change(input, { target: { value: "@Alice hello", selectionStart: 12 } });
    expect(targetBtn()!.querySelector(".target-select-name")!.textContent).toBe("Alice");
    expect(targetBtn()!.className).toContain("is-override");
    expect(targetBtn()!.className).not.toContain("is-locked");

    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});

    // mentionTarget resets cleanly after send, restoring locked Bob indicator
    expect(input.value).toBe("");
    expect(targetBtn()!.querySelector(".target-select-name")!.textContent).toBe("Bob");
    expect(targetBtn()!.className).toContain("is-locked");
    expect(targetBtn()!.className).not.toContain("is-override");

    await sendText("back to bob");

    const sends = sendFrames(sock);
    expect(sends).toHaveLength(2);
    expect(sends[0].content).toBe("@Alice hello");
    expect(sends[0].target).toBeUndefined();
    expect(sends[1]).toMatchObject({
      workspaceId: "w1",
      content: "back to bob",
      target: BOB.id,
    });
  });

  it("resets lock to default when clicking @Alice or selecting Alice in popover and strips conflicting leading @Bob", async () => {
    const sock = boot([
      {
        id: "w1",
        name: "Multi",
        agents: [ALICE, BOB],
        messages: [
          agentMsg("m1", ALICE.id, { timestamp: 1000 }),
          agentMsg("m2", BOB.id, { timestamp: 1001 }),
        ],
      },
    ]);

    // Lock to Bob via @Bob
    fireEvent.click(document.querySelector("#msg-m2 .btn-mention-agent")!);
    expect(targetBtn()!.className).toContain("is-locked");

    // Draft starts with conflicting @Bob mention
    fireEvent.change(composer(), { target: { value: "@Bob hi", selectionStart: 7 } });

    // Click @Alice on Alice's message -> unlocks to default and strips "@Bob "
    fireEvent.click(document.querySelector("#msg-m1 .btn-mention-agent")!);
    expect(composer().value).toBe("hi");
    expect(document.activeElement).toBe(composer());
    expect(targetBtn()!.querySelector(".target-select-name")!.textContent).toBe("Alice");
    expect(targetBtn()!.className).not.toContain("is-locked");

    fireEvent.keyDown(composer(), { key: "Enter" });
    await act(async () => {});
    expect(sendFrames(sock)[0].target).toBeUndefined();
    expect(sendFrames(sock)[0].content).toBe("hi");

    // Lock to Bob via TargetAgentSelect popover, then switch back to Alice via popover
    fireEvent.click(targetBtn()!);
    const options = [...document.querySelectorAll<HTMLButtonElement>(".target-select-option")];
    fireEvent.click(options[1]); // Bob
    expect(targetBtn()!.className).toContain("is-locked");

    fireEvent.change(composer(), { target: { value: "@Bob check this", selectionStart: 15 } });
    fireEvent.click(targetBtn()!);
    const options2 = [...document.querySelectorAll<HTMLButtonElement>(".target-select-option")];
    fireEvent.click(options2[0]); // Alice (default)
    expect(composer().value).toBe("check this");
    expect(targetBtn()!.className).not.toContain("is-locked");

    fireEvent.keyDown(composer(), { key: "Enter" });
    await act(async () => {});
    expect(sendFrames(sock)[1].content).toBe("check this");
    expect(sendFrames(sock)[1].target).toBeUndefined();
  });

  it("remembers locked target independently per workspace", async () => {
    const sock = boot([
      {
        id: "w1",
        name: "ws1",
        agents: [ALICE, BOB],
        messages: [agentMsg("m1", BOB.id, { timestamp: 1000 })],
      },
      {
        id: "w2",
        name: "ws2",
        agents: [ALICE, BOB],
        messages: [agentMsg("m2", ALICE.id, { timestamp: 1000 })],
      },
    ]);

    // Lock ws1 to Bob
    fireEvent.click(document.querySelector("#msg-m1 .btn-mention-agent")!);
    expect(targetBtn()!.querySelector(".target-select-name")!.textContent).toBe("Bob");

    // Switch to ws2: should default to Alice
    selectWorkspace("ws2");
    expect(targetBtn()!.querySelector(".target-select-name")!.textContent).toBe("Alice");
    expect(targetBtn()!.className).not.toContain("is-locked");
    await sendText("msg in ws2");

    // Switch back to ws1: still locked to Bob
    selectWorkspace("ws1");
    expect(targetBtn()!.querySelector(".target-select-name")!.textContent).toBe("Bob");
    expect(targetBtn()!.className).toContain("is-locked");
    await sendText("msg in ws1");

    const sends = sendFrames(sock);
    expect(sends).toHaveLength(2);
    expect(sends[0].workspaceId).toBe("w2");
    expect(sends[0].target).toBeUndefined();
    expect(sends[1]).toMatchObject({ workspaceId: "w1", content: "msg in ws1", target: BOB.id });
  });

  it("hides TargetAgentSelect and bottom-right @ buttons in a single-agent workspace", async () => {
    const sock = boot([
      {
        id: "w1",
        name: "Single",
        agents: [ALICE],
        messages: [agentMsg("m1", ALICE.id, { timestamp: 1000 })],
      },
    ]);

    expect(targetBtn()).toBeNull();
    expect(mentionButtons()).toEqual([]);

    await sendText("solo message");
    const sends = sendFrames(sock);
    expect(sends).toHaveLength(1);
    expect(sends[0].content).toBe("solo message");
    expect(sends[0].target).toBeUndefined();
  });

  it("disables TargetAgentSelect and hides bottom-right @ action in a sealed project", () => {
    const sealedProject: Project = {
      id: "p1",
      name: "Sealed Project",
      root: "/tmp",
      leadWorkspaceId: "w1",
      createdAt: 1,
      status: "sealed",
      objectives: [],
    };

    boot(
      [
        {
          id: "w1",
          name: "Sealed WS",
          agents: [ALICE, BOB],
          projectLink: { projectId: "p1", role: "lead" },
          messages: [agentMsg("m1", BOB.id, { timestamp: 1000 })],
        },
      ],
      [sealedProject],
    );

    const btn = targetBtn()!;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(document.querySelector(".target-select-popover")).toBeNull();
    expect(mentionButtons()).toEqual([]);
  });
});
