import { describe, expect, it } from "vitest";
import { splitEvents } from "../../../webview/src/chat/events";
import { applyEventsToMessage } from "../../../webview/src/state/stream";
import {
  projectPiSubagentTree,
  type PiSubagentTreeState,
} from "../../src/session/pi-subagent-tree";
import {
  decodePiSubagentWidget,
  type PiSubagentWidgetNode,
} from "../../src/session/pi-subagent-widget";
import type { StreamEvent } from "../../src/session/types";

// Encoded by pi-subagents 0.90.0 with a materialized build lane, nested workflow and CI monitor.
const running =
  'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","version":1,"generatedAt":20,"caps":{"maxRuns":20,"maxChildrenPerNode":8,"maxDepth":3,"maxStringLength":160,"maxSerializedBytes":32768},"omitted":{"runs":0,"children":0,"byteLimitExceeded":false},"runs":[{"id":"outer","kind":"workflow","label":"builder","state":"running","children":[{"id":"build","kind":"step","label":"builder","state":"running","children":[{"id":"audit-run","kind":"workflow","label":"reviewer","state":"running","children":[{"id":"audit","kind":"step","label":"reviewer","state":"queued","startedAt":10,"updatedAt":10,"progressText":"checked files","agent":"reviewer","model":"provider/test","thinking":"high"}]},{"id":"ci","kind":"host-step","label":"Build checks","state":"running","updatedAt":20,"hostStep":{"kind":"ci","state":"running"}}],"agent":"builder"}]}]}';
const settled =
  'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","version":1,"generatedAt":20,"caps":{"maxRuns":20,"maxChildrenPerNode":8,"maxDepth":3,"maxStringLength":160,"maxSerializedBytes":32768},"omitted":{"runs":0,"children":0,"byteLimitExceeded":false},"runs":[{"id":"outer","kind":"workflow","label":"builder","state":"running","children":[{"id":"build","kind":"step","label":"builder","state":"running","children":[{"id":"audit-run","kind":"workflow","label":"reviewer","state":"complete","children":[{"id":"audit","kind":"step","label":"reviewer","state":"complete","startedAt":10,"updatedAt":20,"endedAt":20,"progressText":"checked files","agent":"reviewer","model":"provider/test","thinking":"high"}]},{"id":"ci","kind":"host-step","label":"Build checks","state":"partial","updatedAt":20,"endedAt":20,"hostStep":{"kind":"ci","state":"done","verdict":"inconclusive"}}],"agent":"builder"}]}]}';

function decodeBuildChildren(line: string) {
  return decodePiSubagentWidget({
    method: "setWidget",
    widgetKey: "subagent-async",
    widgetLines: [line],
  })!.runs![0].children![0].children!;
}

const owner = "tool:0";
const step = (id: string, state: PiSubagentWidgetNode["state"]): PiSubagentWidgetNode => ({
  id,
  kind: "step",
  label: "Reviewer",
  state,
});

function wrap(inner: StreamEvent): StreamEvent {
  return {
    kind: "subagent_progress",
    content: "",
    subagent: { taskId: owner, description: "", _innerEvent: inner },
  };
}

function restore(state: PiSubagentTreeState): PiSubagentTreeState {
  return JSON.parse(JSON.stringify(state)) as PiSubagentTreeState;
}

describe("projectPiSubagentTree", () => {
  it("folds producer descendants and changed host monitors under the owning card", () => {
    const first = projectPiSubagentTree(owner, decodeBuildChildren(running));
    const next = projectPiSubagentTree(owner, decodeBuildChildren(settled), restore(first.state));
    expect(first.events.map((e) => e.kind)).toEqual([
      "subagent_start",
      "subagent_progress",
      "notice",
    ]);
    expect(next.events.map((e) => e.kind)).toEqual([
      "subagent_done",
      "subagent_progress",
      "notice",
    ]);
    const message = applyEventsToMessage(
      {
        id: "m",
        kind: "agent",
        agentId: "a",
        content: "",
        timestamp: 1,
        status: "done",
        events: [
          {
            kind: "subagent_start",
            content: "",
            subagent: { taskId: owner, description: "Build", events: [] },
          },
        ],
      },
      [...first.events, ...next.events].map(wrap),
    );
    expect(message.events).toHaveLength(1);
    const {
      subagents: [audit],
      banners,
    } = splitEvents(message.events![0].subagent!.events!);
    expect(audit.subagent).toMatchObject({
      description: "reviewer",
      status: "completed",
      cancellable: false,
    });
    const {
      subagents: [lane],
    } = splitEvents(audit.subagent!.events!);
    expect(lane.subagent).toMatchObject({
      status: "completed",
      cancellable: false,
      durationMs: 10,
      model: "provider/test",
      effort: "high",
      summary: "checked files",
    });
    expect(banners.map((e) => e.content)).toEqual([
      "Host step: Build checks (running)",
      "Host step: Build checks (partial)",
    ]);
    expect(projectPiSubagentTree(owner, decodeBuildChildren(settled), next.state).events).toEqual(
      [],
    );
  });

  it.each([
    "queued",
    "running",
    "completed",
    "failed",
    "partial",
    "paused",
    "stopped",
    "rejected",
  ] as const)("preserves the exact %s lifecycle state", (status) => {
    const first = projectPiSubagentTree(owner, [step("audit", "queued")]);
    expect(first.events[0].subagent).toMatchObject({ status: "queued", cancellable: false });
    const next = projectPiSubagentTree(owner, [step("audit", status)], first.state);
    if (status === "queued") {
      expect(next.events).toEqual([]);
    } else {
      expect(next.events).toHaveLength(1);
      expect(next.events[0].kind).toBe(
        status === "running" ? "subagent_progress" : "subagent_done",
      );
      expect(next.events[0].subagent).toMatchObject({ status, cancellable: false });
    }
  });

  it("preserves known facts across omissions, reorderings and restore", () => {
    const rich = { ...step("a", "running"), model: "provider/test", progressText: "first" };
    const other = step("b", "completed");
    const first = projectPiSubagentTree(owner, [rich, other]);
    const saved = restore(first.state);
    for (const children of [undefined, [], [step("a", "running")], [other, rich]]) {
      expect(projectPiSubagentTree(owner, children, saved)).toEqual({ state: saved, events: [] });
    }
    const ended = projectPiSubagentTree(owner, [step("a", "paused")], saved);
    expect(ended.events[0].subagent).toMatchObject({
      status: "paused",
      model: "provider/test",
      summary: "first",
    });
    expect(projectPiSubagentTree(owner, [step("a", "running")], ended.state).events).toEqual([]);
    expect(saved.nodes).toEqual(first.state.nodes);
  });

  it("scopes repeated local IDs to the owner and full branch, and ignores ambiguous siblings", () => {
    const branches = ["left", "right"].map((id) => ({
      ...step(id, "running"),
      children: [step("step:0", "queued")],
    }));
    const a = projectPiSubagentTree(owner, branches);
    const b = projectPiSubagentTree("tool:1", branches, a.state);
    const leafId = (event: StreamEvent) => event.subagent?._innerEvent?.subagent?.taskId;
    expect(new Set([a.events[1], a.events[3], b.events[1], b.events[3]].map(leafId)).size).toBe(4);
    expect(projectPiSubagentTree(owner, [branches[0], branches[0]], a.state).events).toEqual([]);
    expect(projectPiSubagentTree(owner, [...branches].reverse(), a.state).events).toEqual([]);
  });
});
