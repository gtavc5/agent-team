import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { App } from "../../src/App";
import type { AgentInfo, Message } from "../../src/state/useServer";
import { FakeSocket } from "../fakeSocket";
import { healViewport, settleScroller } from "../../src/viewport/viewportHeal";
import "../../src/styles.css";

const agent: AgentInfo = {
  id: "a",
  name: "Agent",
  model: "claude-opus-5-5",
  color: "#888",
  avatar: "A",
  isDefault: true,
};
const title = "A workspace with a title much too long for a phone to show on a single line";
const ws = {
  id: "w",
  name: title,
  project: "repo",
  cwd: "/repo",
  hostId: "local",
  agents: [agent],
  messages: [],
  createdAt: 1,
};
const turn = (i: number, extra: Partial<Message> = {}): Message => ({
  id: `m${i}`,
  kind: "agent",
  agentId: "a",
  status: "done",
  timestamp: 1000 + i,
  content: `Reply ${i}\n\n${"A paragraph of work in progress. ".repeat(4)}`,
  ...extra,
});
const history = Array.from({ length: 18 }, (_, i) => turn(i));
const get = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const gap = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop;
const bottom = (el: HTMLElement) => expect.poll(() => gap(el)).toBeLessThanOrEqual(1);
const nextPaint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

function connect(sock: FakeSocket, workspaces = [ws]) {
  act(() => {
    sock.open();
    sock.receive({
      type: "init",
      workspaces,
      config: {
        presets: [],
        models: [],
        commands: [
          {
            name: "compact",
            description: "Summarize the conversation before continuing",
            source: "extension",
          },
        ],
        hosts: {},
      },
      hosts: [],
    });
  });
}
async function boot(tail: Message[] = [], workspaces = [ws]) {
  await page.viewport(390, 760);
  localStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  const root = document.createElement("div");
  root.id = "root";
  root.style.cssText = "position:fixed; inset:0; height:100dvh";
  document.body.append(root);
  render(<App />, { container: root });
  const sock = FakeSocket.instances.at(-1)!;
  connect(sock, workspaces);
  const receive = (frame: object) => {
    act(() => sock.receive({ workspaceId: "w", ...frame }));
  };
  receive({ type: "workspace_messages", messages: [...history, ...tail], hasMore: false });
  const scroll = get(".messages");
  expect(scroll.clientHeight).toBeGreaterThan(350);
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  await bottom(scroll);
  await nextPaint();
  return { scroll, sock, receive };
}
function move(el: HTMLElement, top: number) {
  el.scrollTop = top;
  fireEvent.scroll(el);
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("follows a growing tail only until the reader moves up, and resumes at the bottom", async () => {
  const live = turn(18, { status: "streaming", content: "Working" });
  const { scroll, receive } = await boot([live]);
  async function grow() {
    const oldHeight = scroll.scrollHeight;
    receive({
      type: "stream_event",
      messageId: live.id,
      event: { kind: "text_delta", content: "\n\nAnother paragraph at the streaming tail." },
    });
    await expect.poll(() => scroll.scrollHeight).toBeGreaterThan(oldHeight);
    await nextPaint();
  }
  await grow();
  await bottom(scroll);
  for (const top of [scroll.scrollTop - 40, 200]) {
    move(scroll, top);
    await grow();
    expect(scroll.scrollTop).toBe(top);
  }
  move(scroll, scroll.scrollHeight);
  await grow();
  await bottom(scroll);
});

it("keeps the opened step in view when its details arrive and the composer grows", async () => {
  const last = turn(18, {
    detail: "summary",
    events: [{ kind: "tool_use", content: "**Bash**", toolUseId: "t", contentOffset: 0 }],
  });
  const { scroll, sock, receive } = await boot([last]);
  const step = [...scroll.querySelectorAll<HTMLElement>(".step-header")].at(-1)!;
  fireEvent.click(step);
  expect(sock.frames()).toContainEqual(
    expect.objectContaining({ type: "load_message_details", messageId: last.id }),
  );
  await nextPaint();
  const stepTop = step.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  const height = scroll.scrollHeight;
  receive({
    type: "message_details",
    messageId: last.id,
    events: [
      {
        kind: "tool_use",
        content: "**Bash**\n```bash\n" + "echo x\n".repeat(40) + "```",
        toolUseId: "t",
        contentOffset: 0,
      },
    ],
  });
  await expect.poll(() => scroll.scrollHeight).toBeGreaterThan(height);
  const client = scroll.clientHeight;
  fireEvent.change(get("textarea"), { target: { value: "A longer draft\n".repeat(10) } });
  await expect.poll(() => scroll.clientHeight).toBeLessThan(client);
  await nextPaint();
  expect(step.getBoundingClientRect().top - scroll.getBoundingClientRect().top).toBeCloseTo(
    stepTop,
    0,
  );
});

it("fits the phone header and composer, and keeps the bottom in view while composing", async () => {
  const { scroll } = await boot();
  const header = get(".panel-header-top").getBoundingClientRect();
  const heading = get(".panel-title");
  const chip = get(".agents-chip").getBoundingClientRect();
  const label = heading.getBoundingClientRect();
  expect(heading.scrollWidth).toBeGreaterThan(heading.clientWidth);
  expect(getComputedStyle(heading).textOverflow).toBe("ellipsis");
  expect(label.right).toBeLessThanOrEqual(chip.left);
  expect(label.top).toBeLessThan(chip.bottom);
  expect(label.bottom).toBeGreaterThan(chip.top);
  expect(chip.right).toBeLessThanOrEqual(header.right);
  const input = get<HTMLTextAreaElement>("textarea");
  expect(input.placeholder).toBe("Message, or / for commands");
  fireEvent.change(input, { target: { value: "/", selectionStart: 1 } });
  const command = get(".command-item");
  expect(get(".command-desc").getBoundingClientRect().top).toBeGreaterThanOrEqual(
    command.querySelector(".command-name")!.getBoundingClientRect().bottom,
  );
  fireEvent.change(input, { target: { value: "" } });
  await nextPaint();
  const oldHeight = scroll.clientHeight;
  fireEvent.change(input, { target: { value: "A longer draft\n".repeat(10) } });
  await expect.poll(() => scroll.clientHeight).toBeLessThan(oldHeight);
  await bottom(scroll);
  fireEvent.change(input, { target: { value: "A shorter draft" } });
  await expect.poll(() => scroll.clientHeight).toBe(oldHeight);
  await bottom(scroll);
  await nextPaint();

  // Disable Chromium's native anchor correction to exercise the app's own
  // one-pixel settle guard, which is needed on WebKit.
  scroll.style.overflowAnchor = "none";
  await nextPaint();
  const before = scroll.scrollTop;
  input.style.height = `${parseFloat(getComputedStyle(input).height) + 1}px`;
  expect(scroll.clientHeight).toBe(oldHeight - 1);
  await nextPaint();
  expect(scroll.scrollTop).toBe(before);

  move(scroll, 200);
  fireEvent.change(input, { target: { value: "A longer draft\n".repeat(10) } });
  await expect.poll(() => scroll.clientHeight).toBeLessThan(oldHeight - 1);
  await nextPaint();
  expect(scroll.scrollTop).toBe(200);
});

it("keeps the scroll position and draft caret across reconnect", async () => {
  const { scroll, sock } = await boot();
  move(scroll, 200);
  const input = get<HTMLTextAreaElement>("textarea");
  fireEvent.change(input, { target: { value: "half a thought" } });
  input.setSelectionRange(4, 4);
  await nextPaint();
  expect(scroll.scrollTop).toBe(200);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  act(() => sock.drop());
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  const next = FakeSocket.instances.at(-1)!;
  expect(next).not.toBe(sock);
  connect(next);
  act(() =>
    next.receive({
      type: "workspace_messages",
      workspaceId: "w",
      messages: history,
      hasMore: false,
    }),
  );
  vi.useRealTimers();
  await nextPaint();
  expect(get(".messages").scrollTop).toBe(200);
  const restored = get<HTMLTextAreaElement>("textarea");
  expect(restored.value).toBe("half a thought");
  expect(restored.selectionStart).toBe(4);
  expect(next.frames()).toContainEqual(
    expect.objectContaining({ type: "load_messages", workspaceId: "w" }),
  );
});

it("intercepts the second tap above the closing sidebar", async () => {
  await boot([], [ws, { ...ws, id: "other", name: "Other workspace" }]);
  fireEvent.click(get(".mobile-menu-btn"));
  const target = [...document.querySelectorAll<HTMLElement>(".task-item")].find((row) =>
    row.textContent?.includes("Other workspace"),
  )!;
  await expect.poll(() => target.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
  const { x, y, width, height } = target.getBoundingClientRect();
  fireEvent.click(target);
  const shield = get(".sidebar-overlay.closing");
  expect(document.elementFromPoint(x + width / 2, y + height / 2)).toBe(shield);
  fireEvent.click(shield);
  expect(document.querySelector(".sidebar-open")).toBeNull();
  await expect.poll(() => document.querySelector(".sidebar-overlay")).toBeNull();
});

it("heals the shell without moving a reader, then can settle the transcript at the end", async () => {
  const { scroll } = await boot();
  move(scroll, 120);
  healViewport(get(".app"), scroll);
  await nextPaint();
  expect(scroll.scrollTop).toBe(120);
  expect(get(".app").getBoundingClientRect().height).toBe(window.innerHeight);
  settleScroller(scroll, true);
  expect(gap(scroll)).toBe(1);
  await nextPaint();
  expect(gap(scroll)).toBe(0);
});
