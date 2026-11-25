import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageItem, SubAgentItem } from "../../src/chat/messages";
import { useServer, type Message, type StreamEvent } from "../../src/state/useServer";
import type { SubagentStatus } from "../../../shared/subagent-status";
import { FakeSocket } from "../fakeSocket";
import "../../src/styles.css";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

it.each(["live", "reconnect"])(
  "reloads an expanded settled card after same-size enrichment (%s)",
  async (mode) => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const taskId = "child";
    const owner: Message = {
      id: "reply",
      kind: "agent",
      agentId: "a",
      status: "done",
      timestamp: 1,
      content: "Finished",
      events: ["subagent_start", "subagent_done"].map((kind) => ({
        kind,
        content: "",
        subagent: {
          taskId,
          description: "Review",
          status: "partial",
          summary: "First summary",
          durationMs: 1_000,
          eventCount: 1,
        },
      })),
    };
    function Transcript() {
      const { workspaces, loadSubagentEvents } = useServer();
      const message = workspaces[0]?.messages[0];
      return (
        message && (
          <MessageItem
            msg={message}
            agents={[]}
            onLoadSubagentEvents={(messageId, id) => loadSubagentEvents("w", messageId, id)}
          />
        )
      );
    }
    function connect() {
      const view = render(<Transcript />);
      let socket = FakeSocket.instances.at(-1)!;
      const receive = (frame: object) => act(() => socket.receive(frame));
      const init = () => {
        act(() => socket.open());
        receive({
          type: "init",
          workspaces: [{ id: "w", name: "w", agents: [], messages: [], createdAt: 1 }],
          config: { models: [], commands: [], presets: [], hosts: {} },
          hosts: [],
        });
      };
      init();
      return {
        ...view,
        receive,
        reconnect: () => {
          act(() => {
            socket.drop();
            // The online signal skips the socket's reconnect back-off.
            window.dispatchEvent(new Event("online"));
          });
          const previous = socket;
          socket = FakeSocket.instances.at(-1)!;
          expect(socket).not.toBe(previous);
          init();
        },
        sendPage: (message: Message) =>
          receive({
            type: "workspace_messages",
            workspaceId: "w",
            messages: [message],
            hasMore: false,
          }),
        sendTrace: (text: string, transcriptRevision?: number) =>
          receive({
            type: "subagent_events",
            workspaceId: "w",
            messageId: owner.id,
            taskId,
            transcriptRevision,
            events: [{ kind: "text", content: text }],
          }),
        traceRequests: () =>
          socket.frames().filter((frame) => frame.type === "load_subagent_events"),
      };
    }
    const {
      container,
      getByRole,
      receive,
      reconnect,
      sendPage,
      sendTrace,
      traceRequests,
      unmount,
    } = connect();
    sendPage(owner);
    fireEvent.click(getByRole("button", { name: "Expand subagent: Review" }));
    expect(traceRequests()).toHaveLength(1);
    sendTrace("old trace");
    expect(container.querySelector(".subagent-events")?.textContent).toContain("old trace");

    const enrichment: StreamEvent = {
      kind: "subagent_enrichment",
      content: "",
      subagent: {
        taskId,
        description: "",
        summary: "Final summary",
        eventCount: 1,
        durationMs: 2_000,
        transcriptRevision: 1,
      },
    };
    const updated = {
      ...owner,
      events: owner.events!.map((e) => ({
        ...e,
        subagent: { ...e.subagent!, ...enrichment.subagent, description: "Review" },
      })),
    };
    const summaryPage: Message = {
      ...updated,
      detail: "summary",
      events: updated.events.map((e) => ({
        ...e,
        subagent: { ...e.subagent, summary: undefined, summaryLength: "Final summary".length },
      })),
    };
    if (mode === "reconnect") {
      reconnect();
      // The new page has unchanged kinds, statuses, and transcript length.
      sendPage(summaryPage);
      receive({
        type: "message_details",
        workspaceId: "w",
        messageId: owner.id,
        events: updated.events,
      });
    } else {
      receive({ type: "stream_event", workspaceId: "w", messageId: owner.id, event: enrichment });
    }
    await waitFor(() => expect(traceRequests()).toHaveLength(mode === "live" ? 2 : 1));
    expect(container.querySelector(".subagent-events")).toBeNull();
    sendTrace("stale response from revision zero");
    expect(container.querySelector(".subagent-events")).toBeNull();
    sendTrace("new trace", 1);
    const card = () => container.querySelector(".subagent-item")!;
    expect(container.querySelectorAll(".subagent-item")).toHaveLength(1);
    expect(card().classList.contains("subagent-partial")).toBe(true);
    expect(card().textContent).toContain("Final summary");
    expect(card().querySelector(".subagent-time")?.textContent).toBe("2s");
    expect(card().textContent).toContain("new trace");
    const liveText = card().textContent;
    unmount();
    const fresh = connect();
    fresh.sendPage(updated);
    fireEvent.click(fresh.getByRole("button", { name: "Expand subagent: Review" }));
    expect(fresh.traceRequests()).toHaveLength(1);
    fresh.sendTrace("new trace", 1);
    expect(fresh.container.querySelector(".subagent-item")?.textContent).toBe(liveText);
  },
);
