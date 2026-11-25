import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SubAgentItem } from "../../src/chat/messages";
import { App } from "../../src/App";
import { page } from "vitest/browser";
import { readTracePage, TRACE_MAX_BYTES, TRACE_MAX_EVENTS } from "../../../shared/subagent-trace";
import type { Message } from "../../src/state/useServer";
import * as telemetry from "../../src/telemetry";
import type { SubagentStatus } from "../../../shared/subagent-status";
import { FakeSocket } from "../fakeSocket";
import "../../src/styles.css";

vi.mock("../../src/telemetry", { spy: true });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  FakeSocket.instances = [];
});

const statuses: SubagentStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "partial",
  "paused",
  "stopped",
  "rejected",
];
it.each(statuses)("renders %s with the correct animation and cancel affordance", (status) => {
  const { container } = render(
    <SubAgentItem
      ev={{
        kind: "subagent_start",
        content: "",
        subagent: { taskId: "child", description: "Review", status },
      }}
      onCancel={() => {}}
    />,
  );
  const icon = container.querySelector(".subagent-status-icon")!;
  expect(icon.getAttribute("title")).toBe(status);
  expect(getComputedStyle(icon).animationName).toBe(status === "running" ? "spin" : "none");
  expect(!!container.querySelector(".streaming-dot")).toBe(status === "running");
  expect(!!container.querySelector(".btn-cancel-subagent")).toBe(
    status === "queued" || status === "running",
  );
});

const agent = {
  id: "a",
  name: "Agent",
  avatar: "A",
  color: "#888",
  model: "model",
  isDefault: true,
};
const workspaces = ["work", "other"].map((id) => ({
  id,
  name: id,
  project: "repo",
  hostId: "local",
  cwd: "/repo",
  agents: [{ ...agent, busy: id === "other" }],
  messages: [],
  createdAt: 1,
  projectLink: { projectId: "p", role: id === "work" ? "lead" : "worker" },
}));
const init = {
  type: "init",
  workspaces,
  projects: [
    {
      id: "p",
      name: "Project",
      root: "/repo",
      createdAt: 1,
      leadWorkspaceId: "work",
      objectives: [],
    },
  ],
  config: { models: [], commands: [], presets: [], hosts: {} },
};
const messages: Message[] = Array.from({ length: 30 }, (_, i) => ({
  id: `reply-${i}`,
  kind: "agent",
  agentId: "a",
  status: "done",
  timestamp: i + 2,
  content: `Reply ${i}\n\n${"A recorded paragraph to reread. ".repeat(20)}`,
}));
const owner = messages[12];
const task = {
  taskId: "child",
  description: "Review",
  status: "running" as const,
  lastTool: "Read",
};
const paint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

function mount() {
  vi.stubGlobal("WebSocket", FakeSocket);
  localStorage.setItem("activeWsId", "work");
  const root = document.createElement("div");
  root.style.cssText = "position:fixed; inset:0; height:100dvh";
  document.body.append(root);
  const view = render(<App />, { container: root });
  let sock = FakeSocket.instances.at(-1)!;
  const receive = (frame: object) => act(() => sock.receive(frame));
  const connect = () => {
    act(() => sock.open());
    receive(init);
  };
  connect();
  const requests = () => sock.frames().filter((f) => f.type === "load_subagent_trace");
  const openTrace = () =>
    fireEvent.click(view.getByRole("button", { name: "Expand subagent: Review" }));
  const details = () => root.querySelector<HTMLElement>(".subagent-item > .subagent-details");
  const events: NonNullable<Parameters<typeof readTracePage>[1]> = [];
  const meta = {
    prompt: "**Task prompt**\n\n" + "Check the repo carefully. ".repeat(12),
    summary: "**Final result**\n\n" + "All checks passed. ".repeat(12),
    usage: { totalTokens: 4000, toolUses: 3, durationMs: 6000 },
  };
  return {
    ...view,
    receive,
    requests,
    openTrace,
    details,
    events,
    meta,
    snapshot: (revision: number, summary = "First summary") =>
      receive({
        type: "workspace_messages",
        workspaceId: "work",
        before: null,
        hasMore: false,
        messages: messages.map((msg) =>
          msg === owner
            ? {
                ...owner,
                events: [
                  {
                    kind: "subagent_start",
                    content: "",
                    subagent: {
                      ...task,
                      summary,
                      transcriptRevision: revision,
                      eventCount: events.length,
                    },
                  },
                ],
              }
            : msg,
        ),
      }),
    disconnect: () => act(() => sock.drop()),
    reconnect: () => {
      const previous = sock;
      act(() => {
        sock.drop();
        window.dispatchEvent(new Event("online"));
      });
      sock = FakeSocket.instances.at(-1)!;
      expect(sock).not.toBe(previous);
      connect();
    },
    grow: (batchSize: number) =>
      act(() => {
        for (let i = 0; i < batchSize; i++) {
          events.push({ kind: "text", content: `Trace row ${events.length}: ${"🧪".repeat(640)}` });
          sock.receive({
            type: "stream_event",
            workspaceId: "work",
            messageId: owner.id,
            event: {
              kind: "subagent_enrichment",
              content: "",
              subagent: {
                taskId: task.taskId,
                description: "",
                eventCount: events.length,
                transcriptRevision: events.length,
              },
            },
          });
        }
      }),
    answer: (revision = events.length, request = requests().at(-1)!) => {
      const payload = readTracePage(
        request.requestId as number,
        [
          {
            kind: "subagent_start",
            content: "",
            subagent: {
              ...task,
              ...meta,
              transcriptRevision: revision,
              events,
            },
          },
        ],
        task.taskId,
        request,
      );
      receive(payload);
      return payload;
    },
  };
}

it("preserves a historical reading anchor on open, close, session switch and reconnect", async () => {
  await page.viewport(1280, 800);
  const view = mount();
  view.events.push({ kind: "text", content: "old trace" });
  view.snapshot(0);
  const scroller = () => view.container.querySelector<HTMLElement>(".messages")!;
  const widths = () =>
    [".main-panel", ".messages", "#msg-reply-12"].map(
      (selector) => view.container.querySelector(selector)?.getBoundingClientRect().width,
    );
  const offset = () =>
    view.container.querySelector("#msg-reply-12")!.getBoundingClientRect().top -
    scroller().getBoundingClientRect().top;
  const anchor = () => [scroller().scrollTop, offset()];
  await paint();
  scroller().scrollTop += offset() + 17;
  fireEvent.scroll(scroller());
  await paint();
  expect(offset()).toBeCloseTo(-17, 0);
  const original = anchor();
  const initialWidths = widths();
  const sameGeometry = () => {
    expect(anchor()).toEqual(original);
    expect(widths()).toEqual(initialWidths);
  };
  view.openTrace();
  const firstRequest = view.requests().at(-1)!;
  view.answer(0);
  expect(view.details()?.textContent).toContain("old trace");
  expect(scroller().contains(view.details())).toBe(true);
  sameGeometry();
  fireEvent.click(view.getByRole("button", { name: "Collapse subagent trace" }));
  expect(view.details()).toBeNull();
  expect(document.activeElement).toBe(
    view.getByRole("button", { name: "Expand subagent: Review" }),
  );
  sameGeometry();

  view.openTrace();
  fireEvent.click(view.getByText("other", { selector: ".clip" }));
  view.receive({
    type: "workspace_messages",
    workspaceId: "other",
    messages: [{ ...messages[0], id: "other-reply" }],
  });
  expect(view.details()).toBeNull();
  expect(widths().slice(0, 2)).toEqual(initialWidths.slice(0, 2));
  fireEvent.click(view.getByTitle("Open the lead of Project"));
  view.snapshot(0);
  await paint();
  sameGeometry();
  view.openTrace();
  view.reconnect();
  view.events[0].content = "new trace of the same size";
  view.snapshot(1, "Final summary");
  view.receive({
    type: "subagent_trace_page",
    requestId: firstRequest.requestId,
    events: [],
    revision: 0,
  });
  view.answer(1);
  await paint();
  expect(view.details()?.textContent).toContain("new trace of the same size");
  expect(scroller().textContent).toContain("Final result");
  sameGeometry();
});

it("reports timeout, unavailable and offline states on the expanded card", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const view = mount();
    view.snapshot(0);
    view.openTrace();
    const timedOut = view.requests().at(-1)!;
    void act(() => vi.advanceTimersByTime(5000));
    expect(view.details()?.textContent).toContain("Trace request timed out.");
    view.answer(0, timedOut);
    expect(view.details()?.querySelector(".subagent-trace-page")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    const retry = view.requests().at(-1)!;
    expect(retry.requestId).not.toBe(timedOut.requestId);
    view.receive(readTracePage(retry.requestId as number, [], task.taskId, {}));
    expect(view.details()?.textContent).toContain("Trace is unavailable.");
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(view.details()?.textContent).toContain("Loading trace…");
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    view.answer(0);
    expect(view.details()?.textContent).toContain("Final result");
    view.disconnect();
    expect(view.details()?.textContent).toContain("Offline. Waiting to reconnect…");
  } finally {
    vi.useRealTimers();
  }
});

it.each([390, 1280])("balances card and markdown border insets at %ipx", async (width) => {
  await page.viewport(width, 800);
  const view = mount();
  view.meta.prompt = "## Task prompt\n\nReview the call chain.";
  view.meta.summary = "The checks passed.\n\n- One tool call\n- No errors";
  view.events.push({
    kind: "subagent_start",
    content: "",
    subagent: {
      taskId: "nested",
      description: "Child",
      status: "completed",
      prompt: "**Child prompt**",
      summary: "**Child result**",
    },
  });
  view.snapshot(0);
  function expectInsets(box: Element, first: Element, last: Element, label: string) {
    const bounds = box.getBoundingClientRect();
    const top = first.getBoundingClientRect().top - bounds.top;
    const bottom = bounds.bottom - last.getBoundingClientRect().bottom;
    expect(
      Math.abs(top - bottom),
      `${label}: ${top}px top, ${bottom}px bottom`,
    ).toBeLessThanOrEqual(1);
  }
  function checkCard(card: Element, expanded: boolean) {
    const header = card.querySelector(":scope > .subagent-header")!;
    const end = expanded
      ? card.querySelector(":scope > .subagent-details > .trace-collapse-footer")!
      : header;
    expectInsets(card, header, end, `${expanded ? "expanded" : "collapsed"} card`);
    if (expanded) {
      for (const selector of [".subagent-prompt", ".subagent-summary"]) {
        const block = card.querySelector(
          `:scope > .subagent-details > .subagent-trace-page > ${selector}`,
        )!;
        expectInsets(block, block.firstElementChild!, block.lastElementChild!, selector);
      }
    }
  }
  const card = view.container.querySelector(".subagent-item")!;
  checkCard(card, false);
  view.openTrace();
  view.answer(0);
  checkCard(card, true);
  const nested = view.details()!.querySelector<HTMLElement>(".subagent-item")!;
  checkCard(nested, false);
  fireEvent.click(within(nested).getByRole("button", { name: "Expand subagent: Child" }));
  view.answer(0);
  checkCard(nested, true);
});

it("renders native markdown, steps and concurrently refreshing nested cards inline", async () => {
  await page.viewport(1280, 800);
  const view = mount();
  const child = {
    taskId: "nested",
    description: "Check output",
    status: "failed" as const,
    prompt: "**Nested prompt**",
    summary: "**Nested result**",
    events: [{ kind: "text", content: "Initial inner trace" }],
  };
  view.events.push(
    { kind: "thinking", content: "Inspecting callers" },
    {
      kind: "tool_use",
      toolName: "Read",
      content: "**Read** `source.ts`",
      toolResult: "**Not found**",
      toolResultIsError: true,
      toolResultIsMarkdown: true,
    },
    { kind: "subagent_start", content: "", subagent: child },
    { kind: "subagent_done", content: "", subagent: child },
  );
  view.snapshot(0);
  // The full header, not only the arrow, is the click target.
  fireEvent.click(view.getByText("Review", { selector: ".subagent-desc" }));
  expect(view.details()?.textContent).toContain("Loading trace…");
  view.answer(0);
  const details = view.details()!;
  expect(details.querySelector(".subagent-prompt strong")?.textContent).toBe("Task prompt");
  expect(details.querySelector(".subagent-prompt p:last-child")?.textContent?.trim()).toBe(
    view.meta.prompt.split("\n\n")[1].trim(),
  );
  expect(details.querySelector(".subagent-summary strong")?.textContent).toBe("Final result");
  expect(details.querySelector(".subagent-usage")?.textContent).toBe("4k tokens · 3 tools");
  expect(details.querySelector(".event-thinking .event-content")?.textContent).toBe(
    "Inspecting callers",
  );
  expect(details.querySelector(".event-tool_use .event-chip")?.textContent).toBe("Read");
  const result = within(details).getByRole("button", { name: /^Result .*failed$/ });
  expect(details.querySelector(".event-result")).toBeNull();
  fireEvent.click(result);
  expect(details.querySelector(".event-failed .event-result strong")?.textContent).toBe(
    "Not found",
  );
  const nested = details.querySelector<HTMLElement>(".subagent-item")!;
  expect(details.querySelectorAll(".subagent-item")).toHaveLength(1);
  expect(nested.querySelector(".subagent-details")).toBeNull();
  fireEvent.click(within(nested).getByRole("button", { name: "Expand subagent: Check output" }));
  expect(view.requests().at(-1)).toMatchObject({ taskId: task.taskId, path: ["nested"] });
  view.answer(0);
  expect(within(nested).getByText("Initial inner trace")).toBeTruthy();

  const previous = view.requests().length;
  child.events[0].content = "Updated inner trace";
  view.grow(1);
  await waitFor(() => expect(view.requests()).toHaveLength(previous + 2));
  const refreshes = view.requests().slice(previous);
  const inner = refreshes.find((request) => Array.isArray(request.path))!;
  const outer = refreshes.find((request) => request !== inner)!;
  view.answer(view.events.length, inner);
  view.answer(view.events.length, outer);
  expect(within(nested).getByText("Updated inner trace")).toBeTruthy();
  expect(details.textContent).toContain("Trace row 4");
  expect(details.querySelectorAll(".subagent-trace-page")).toHaveLength(2);
  fireEvent.click(view.getByRole("button", { name: "Collapse subagent: Review" }));
  expect(view.details()).toBeNull();
  expect(view.container.querySelectorAll(".subagent-trace-page")).toHaveLength(0);
  view.openTrace();
  view.answer();
  expect(view.details()?.querySelectorAll(".subagent-trace-page")).toHaveLength(1);
  expect(view.getByRole("button", { name: "Expand subagent: Check output" })).toBeTruthy();
});

it("retains one bounded reading window under repeated live growth, paging and open/close cycles", async () => {
  await page.viewport(1280, 800);
  const record = vi.mocked(telemetry.recordTelemetry);
  record.mockClear();
  const view = mount();
  const assertBound = () => {
    const windows = view.container.querySelectorAll<HTMLElement>(".subagent-trace-page");
    expect(windows).toHaveLength(1);
    const [readingWindow] = windows;
    expect(+readingWindow.dataset.traceEntries!).toBeLessThanOrEqual(TRACE_MAX_EVENTS);
    expect(+readingWindow.dataset.traceBytes!).toBeLessThanOrEqual(TRACE_MAX_BYTES);
    expect(view.details()!.querySelectorAll("*").length).toBeLessThanOrEqual(
      TRACE_MAX_EVENTS * 7 + 32,
    );
    expect(view.details()?.querySelectorAll(".subagent-events > .event")).toHaveLength(
      +readingWindow.dataset.traceEntries!,
    );
  };
  view.snapshot(0);
  for (let cycle = 0; cycle < 5; cycle++) {
    const before = view.requests().length;
    view.grow(100);
    await paint();
    expect(view.requests()).toHaveLength(before);
    view.openTrace();
    expect(view.details()?.textContent).not.toContain("Trace row");
    expect(view.answer().totalEvents).toBe(view.events.length);
    assertBound();
    const pageRequests = view.requests().length;
    view.grow(100);
    await waitFor(() => expect(view.requests()).toHaveLength(pageRequests + 1));
    const latest = view.answer();
    expect(latest.totalEvents).toBe(view.events.length);
    assertBound();
    const latestStart = latest.start;
    fireEvent.click(view.getByRole("button", { name: "Earlier" }));
    const earlier = view.answer();
    expect(earlier.end).toBe(latestStart);
    expect(earlier.hasMore).toBe(true);
    expect(view.details()?.querySelector(".subagent-pagination span")?.textContent).toBe(
      `${earlier.start + 1}–${earlier.end} of ${earlier.totalEvents} steps`,
    );
    assertBound();
    fireEvent.click(view.getByRole("button", { name: "Latest" }));
    expect(view.answer().start).toBe(latestStart);
    fireEvent.click(view.getByRole("button", { name: "Earlier" }));
    view.answer();
    fireEvent.click(view.getByRole("button", { name: "Newer" }));
    // Close with the newer request still outstanding; a late page must be ignored.
    fireEvent.click(view.getByRole("button", { name: "Collapse subagent trace" }));
    view.answer();
    expect(view.details()).toBeNull();
    expect(view.container.querySelectorAll(".subagent-item")).toHaveLength(1);
  }
  const actions = record.mock.calls
    .map(([action]) => action)
    .filter((action) => action.startsWith("trace."));
  expect(actions).toEqual(
    Array.from({ length: 5 }, () => [
      "trace.subagent_toggle",
      "trace.subagent_page",
      "trace.subagent_page",
      "trace.subagent_page",
      "trace.subagent_page",
      "trace.subagent_toggle",
    ]).flat(),
  );
});
