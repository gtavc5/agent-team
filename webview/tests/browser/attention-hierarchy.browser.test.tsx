import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { App } from "../../src/App";
import { collectSnapshot, SNAPSHOT_SELECTORS } from "../../src/dev/debugSnapshot";
import type { AgentInfo, Message, Project, Workspace } from "../../src/state/useServer";
import { FakeSocket } from "../fakeSocket";
import "../../src/styles.css";

const NOW = 1_800_000_000_000;
const agent: AgentInfo = {
  id: "agent",
  name: "Agent",
  model: "model",
  avatar: "A",
  color: "#888",
  isDefault: true,
};
const project: Project = {
  id: "proj",
  name: "Project",
  root: "/repo",
  createdAt: NOW,
  leadWorkspaceId: "lead",
  objectives: [],
};
function workspace(id: string, order: number, fields: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: id,
    project: "repo",
    hostId: "local",
    cwd: "/repo",
    agents: [agent],
    messages: [],
    createdAt: NOW + order,
    projectLink: { projectId: project.id, role: id === "lead" ? "lead" : "worker" },
    ...fields,
  };
}
const lead = workspace("lead", 0);
const a = workspace("A", 1);
const b = workspace("B", 2);
const config = { presets: [], models: [], commands: [], hosts: {} };
const frame = (n: number, over: Partial<Message> = {}): Message => ({
  id: `m${n}`,
  kind: "agent",
  agentId: agent.id,
  status: "done",
  timestamp: NOW + n,
  content: `Reply ${n}\n\n${"The transcript is long enough to read in the middle. ".repeat(10)}`,
  ...over,
});
const get = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const row = (name: string) =>
  document.querySelector<HTMLElement>(`.task-item:has(.clip[title="${name}"])`);
const order = () =>
  [...document.querySelectorAll(".task-item .clip")].map((item) => item.textContent);
const cue = (name: string) => row(name)?.querySelector(".session-attention")?.textContent;
const sendPage = (sock: FakeSocket, workspaceId: string, messages: Message[]) =>
  act(() => sock.receive({ type: "workspace_messages", workspaceId, messages, hasMore: false }));
function connect(workspaces: Workspace[], extra = {}) {
  const sock = FakeSocket.instances.at(-1)!;
  const receive = (value: object) => act(() => sock.receive(value));
  act(() => sock.open());
  receive({ type: "init", workspaces, projects: [project], config, ...extra });
  return { sock, receive };
}
function mount(active = "lead") {
  localStorage.setItem("activeWsId", active);
  vi.stubGlobal("WebSocket", FakeSocket);
  const root = document.createElement("div");
  root.id = "root";
  root.style.cssText = "position:fixed; inset:0; height:100dvh";
  document.body.append(root);
  return render(<App />, { container: root });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeSocket.instances = [];
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

it.each([
  [1280, "light"],
  [1280, "dark"],
  [390, "light"],
  [390, "dark"],
] as const)(
  "keeps attention, quiet waits and stable worker positions at %ipx (%s)",
  async (width, theme) => {
    await page.viewport(width, 800);
    document.documentElement.dataset.theme = theme;
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const asking = workspace("Asking", 1, { awaitsUser: true, unread: 1 });
    const done = workspace("Result", 2, { agents: [{ ...agent, busy: true, lastStreamAt: NOW }] });
    const running = workspace("Running", 3, {
      agents: [{ ...agent, busy: true, lastStreamAt: NOW - 14_875 }],
    });
    const old = workspace("Read and idle", -1, { lastResult: "done" });
    const view = mount();
    const { sock, receive } = connect([lead, asking, done, running, old]);
    sendPage(sock, lead.id, [frame(0)]);
    if (width < 768) fireEvent.click(get(".mobile-menu-btn"));
    expect(order()).toEqual(["Running", "Result", "Asking"]);
    expect(cue("Asking")).toBe("Your turn");
    expect(row("Read and idle")).toBeNull();
    expect(view.getByRole("button", { name: "Idle / Done (1)" })).toBeTruthy();
    expect(cue("Result")).toBeUndefined();
    expect(row("Running")?.querySelector(".task-status.running")).toBeTruthy();
    expect(row("Running")?.textContent).not.toContain("No new events");
    clock = NOW + 125;
    await expect
      .poll(() => row("Running")?.querySelector(".session-silence")?.textContent)
      .toBe("No new events for 15s");
    expect(row("Running")?.textContent).not.toMatch(/thinking|stuck/i);

    const runningRow = row("Running")!;
    fireEvent.pointerDown(runningRow);
    receive({
      type: "new_message",
      workspaceId: done.id,
      message: frame(1, { status: "streaming", content: "" }),
    });
    receive({
      type: "stream_event",
      workspaceId: done.id,
      messageId: "m1",
      agentId: agent.id,
      streamAt: clock,
      event: { kind: "tool_use", content: "Read" },
    });
    expect(cue("Result")).toBeUndefined();
    receive({ type: "workspace_attention", workspaceId: done.id, lastResult: "done", unread: 1 });
    receive({ type: "agent_idle", workspaceId: done.id, agentId: agent.id });
    expect(cue("Result")).toBe("Unread result");
    expect(view.getByRole("status", { name: "Project: 1 need you · 1 unread" })).toBeTruthy();

    // A snapshot (as on reconnect) has the same cues without a local turn history.
    receive({
      type: "init",
      workspaces: [
        old,
        { ...running, queued: false },
        { ...done, agents: [agent], lastResult: "done", unread: 1 },
        asking,
        lead,
      ],
      projects: [project],
      config,
    });
    expect(cue("Asking")).toBe("Your turn");
    expect(cue("Result")).toBe("Unread result");
    expect(row("Running")?.textContent).toContain("No new events for 15s");
    const retryLabel = "Retrying (1/2 in 0s): 503 fixture service unavailable";
    receive({
      type: "stream_event",
      workspaceId: running.id,
      messageId: "not loaded",
      agentId: agent.id,
      streamAt: clock,
      retryLabel,
      event: { kind: "retry", content: retryLabel },
    });
    await expect
      .poll(() => row("Running")?.querySelector(".session-silence")?.textContent)
      .toBe("Retrying (attempt 1)");
    receive({
      type: "stream_event",
      workspaceId: running.id,
      messageId: "not loaded",
      agentId: agent.id,
      streamAt: clock,
      retryLabel: null,
      event: { kind: "text_delta", content: "Progress" },
    });
    await expect.poll(() => row("Running")?.querySelector(".session-silence")).toBeNull();
    receive({ type: "agent_idle", workspaceId: running.id, agentId: agent.id });
    expect(row("Running")).toBe(runningRow);
    expect(order()).toEqual(["Running", "Result", "Asking"]);
    fireEvent.pointerUp(runningRow);
    receive({
      type: "new_message",
      workspaceId: running.id,
      queued: true,
      message: frame(8, { kind: "user", status: "queued" }),
    });
    expect(row("Running")?.querySelector(".session-silence")?.textContent).toBe("Queued");
    expect(view.queryByRole("button", { name: "Fold idle (1)" })).toBeNull();
    receive({ type: "message_removed", workspaceId: running.id, messageId: "m8", queued: false });
    expect(row("Running")?.querySelector(".session-silence")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Fold idle (1)" }));
    expect(order()).toEqual(["Result", "Asking"]);
    expect(view.getByRole("button", { name: "Idle / Done (2)" })).toBeTruthy();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    for (const el of [get(".main-panel"), get(".sidebar")])
      expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
    const snapshot = collectSnapshot();
    expect(snapshot.elements.map((e) => e.selector)).toEqual(
      SNAPSHOT_SELECTORS.filter((s) => document.querySelector(s)),
    );
  },
);

it("restores A's exact reading anchor after sending in B, without following new A messages", async () => {
  await page.viewport(1280, 800);
  const view = mount("A");
  const { sock, receive } = connect([lead, a, b]);
  const history = Array.from({ length: 30 }, (_, index) => frame(index));
  sendPage(sock, a.id, history);
  const scroller = () => get(".messages");
  const offset = () =>
    get("#msg-m10").getBoundingClientRect().top - scroller().getBoundingClientRect().top;
  const gap = () => scroller().scrollHeight - scroller().clientHeight - scroller().scrollTop;
  expect(gap()).toBeLessThanOrEqual(1);
  scroller().scrollTop += offset() + 17;
  fireEvent.scroll(scroller());
  const original = offset();
  expect(original).toBeCloseTo(-17, 0);
  fireEvent.click(row("B")!);
  sendPage(sock, b.id, [frame(99, { content: "Session B" })]);
  const composer = get<HTMLTextAreaElement>(".chat-input");
  fireEvent.change(composer, { target: { value: "Please continue in B" } });
  fireEvent.click(within(get(".input-row")).getByRole("button", { name: "Send" }));
  await expect
    .poll(() => sock.frames().find((f) => f.type === "send_message"))
    .toMatchObject({ workspaceId: "B", content: "Please continue in B" });
  receive({ type: "new_message", workspaceId: "A", message: frame(30) });
  fireEvent.click(row("A")!);
  sendPage(sock, a.id, [...history, frame(30)]);
  expect(offset()).toBeCloseTo(original, 0);
  receive({ type: "new_message", workspaceId: "A", message: frame(31) });
  expect(offset()).toBeCloseTo(original, 0);

  // A newer snapshot no longer overlaps the previously loaded window.
  // The original anchor must survive replacement, not just live appends.
  const disjoint = {
    type: "workspace_messages",
    workspaceId: "A",
    hasMore: true,
    messages: Array.from({ length: 50 }, (_, index) => frame(index + 50)),
  };
  receive(disjoint);
  expect(sock.frames()).toContainEqual(
    expect.objectContaining({
      type: "load_messages",
      workspaceId: "A",
      before: NOW + 50,
    }),
  );
  expect(document.getElementById("msg-m10")).toBeNull();
  // A reconnect invalidates the previous request; the same cursor is sent again.
  const olderRequests = () =>
    sock.frames().filter((f) => f.type === "load_messages" && f.before === NOW + 50).length;
  expect(olderRequests()).toBe(1);
  receive({ type: "init", workspaces: [lead, a, b], projects: [project], config });
  expect(olderRequests()).toBe(2);
  // Another latest-page reply can arrive before the outstanding older page.
  receive(disjoint);
  expect(olderRequests()).toBe(2);
  scroller().scrollTop = scroller().scrollHeight;
  fireEvent.scroll(scroller());
  expect(view.getByRole("button", { name: /Jump to latest/ })).toBeTruthy();
  receive({
    type: "workspace_messages",
    workspaceId: "A",
    before: NOW + 50,
    hasMore: false,
    messages: Array.from({ length: 50 }, (_, index) => frame(index)),
  });
  expect(offset()).toBeCloseTo(original, 0);
  fireEvent.click(view.getByRole("button", { name: /Jump to latest/ }));
  expect(gap()).toBeLessThanOrEqual(1);
  expect(view.queryByRole("button", { name: /Jump to latest/ })).toBeNull();
  fireEvent.click(row("B")!);
  fireEvent.click(row("A")!);
  expect(gap()).toBeLessThanOrEqual(1);
});
