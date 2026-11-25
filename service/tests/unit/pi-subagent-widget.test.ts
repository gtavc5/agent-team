import { describe, expect, it } from "vitest";
import {
  bindPiSubagentWidgetChildren,
  decodePiSubagentWidget,
  type PiSubagentWidgetNode,
} from "../../src/session/pi-subagent-widget";
import type { ActiveAsyncRunRecord } from "../../src/session/types";

const prefix = "PI_SUBAGENT_ASYNC_JSON:";
const widget = { method: "setWidget", widgetKey: "subagent-async" };
const snapshot = (runs: unknown[]) => ({
  kind: "pi-subagents.async-status-snapshot",
  version: 1,
  runs,
});
const decode = (payload: unknown) =>
  decodePiSubagentWidget({ ...widget, widgetLines: [prefix + JSON.stringify(payload)] });
const step = (id: string): PiSubagentWidgetNode => ({
  id,
  kind: "step",
  label: "same agent",
  state: "running",
});
const root = (children: PiSubagentWidgetNode[] = []): PiSubagentWidgetNode => ({
  id: "run-1",
  kind: "workflow",
  label: "workflow",
  state: "running",
  children,
});

// One line from the pi-subagents 0.90.0 RPC encoder, using deterministic offline job data.
const encodedSnapshot =
  'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","version":1,"generatedAt":150,"caps":{"maxRuns":20,"maxChildrenPerNode":8,"maxDepth":3,"maxStringLength":160,"maxSerializedBytes":32768},"omitted":{"runs":0,"children":0,"byteLimitExceeded":false},"runs":[{"id":"run-1","kind":"subagent","label":"builder, reviewer","state":"running","startedAt":100,"updatedAt":150,"children":[{"id":"step:0","kind":"step","label":"builder","state":"complete","startedAt":110,"updatedAt":135,"endedAt":135,"activity":{"currentTool":"read","lastActivityAt":131,"turnCount":2,"toolCount":3},"progressText":"checked files","progressUpdatedAt":129,"agent":"builder","model":"provider/test","thinking":"high"},{"id":"step:1","kind":"step","label":"reviewer","state":"queued","agent":"reviewer"}]}]}';

describe("decodePiSubagentWidget", () => {
  it("leaves unrelated requests alone and consumes inspect without reading or retaining any reply", () => {
    expect(decodePiSubagentWidget({ ...widget, widgetKey: "other" })).toBeUndefined();
    expect(decodePiSubagentWidget({ ...widget, method: "setStatus" })).toBeUndefined();
    expect(decodePiSubagentWidget({ ...widget, widgetKey: "subagent-inspect" })).toEqual({});
    expect(
      decodePiSubagentWidget({
        ...widget,
        widgetKey: "subagent-inspect",
        get widgetLines(): never {
          throw new Error("Inspect payload should not be read");
        },
      }),
    ).toEqual({});
  });

  it("distinguishes a clear or valid empty snapshot from malformed reserved updates", () => {
    expect(decodePiSubagentWidget(widget)).toEqual({ runs: [] });
    expect(decode(snapshot([]))).toEqual({ runs: [] });
    for (const widgetLines of [
      null,
      [],
      [1],
      [encodedSnapshot, ""],
      [" " + encodedSnapshot],
      [prefix + "{"],
    ]) {
      expect(decodePiSubagentWidget({ ...widget, widgetLines })).toEqual({});
    }
  });

  it("decodes the RPC encoder line including timing, execution, activity and progress metadata", () => {
    expect(encodedSnapshot.length).toBeGreaterThan(256);
    expect(decodePiSubagentWidget({ ...widget, widgetLines: [encodedSnapshot] })).toEqual({
      runs: [
        {
          id: "run-1",
          kind: "subagent",
          label: "builder, reviewer",
          state: "running",
          startedAt: 100,
          updatedAt: 150,
          children: [
            {
              id: "step:0",
              kind: "step",
              label: "builder",
              state: "completed",
              startedAt: 110,
              updatedAt: 135,
              endedAt: 135,
              activity: { currentTool: "read", lastActivityAt: 131, turnCount: 2, toolCount: 3 },
              progressText: "checked files",
              progressUpdatedAt: 129,
              agent: "builder",
              model: "provider/test",
              thinking: "high",
            },
            { id: "step:1", kind: "step", label: "reviewer", state: "queued", agent: "reviewer" },
          ],
        },
      ],
    });
  });

  it("accepts only the eight v1 wire states, normalizing complete", () => {
    const states = [
      "queued",
      "running",
      "complete",
      "failed",
      "partial",
      "paused",
      "stopped",
      "rejected",
    ];
    const runs = states.map((state) => ({ ...root(), id: state, state }));
    expect(decode(snapshot(runs))?.runs?.map(({ state }) => state)).toEqual([
      "queued",
      "running",
      "completed",
      "failed",
      "partial",
      "paused",
      "stopped",
      "rejected",
    ]);
    for (const state of ["completed", "pending", "constructor", null]) {
      expect(decode(snapshot([root(), { ...root(), state }]))).toEqual({});
    }
  });

  it("rejects malformed envelope and retained fields without accepting a partial update", () => {
    for (const payload of [
      null,
      { ...snapshot([]), kind: "other" },
      { ...snapshot([]), version: 2 },
      { ...snapshot([]), runs: {} },
      snapshot([step("not-a-root")]),
    ]) {
      expect(decode(payload)).toEqual({});
    }
    for (const fields of [
      { id: "" },
      { label: 4 },
      { children: {} },
      { startedAt: -1 },
      { updatedAt: 0.5 },
      { endedAt: Number.MAX_SAFE_INTEGER + 1 },
      { agent: [] },
      { model: null },
      { thinking: "unknown" },
      { activity: { toolCount: "5" } },
      { progressUpdatedAt: "123" },
      { progressText: "x".repeat(161) },
    ]) {
      expect(
        decode(snapshot([root(), { ...root(), children: [{ ...step("step:0"), ...fields }] }])),
      ).toEqual({});
    }
    expect(decode(snapshot([{ ...root(), asyncDir: "/private" }]))).toEqual({ runs: [root()] });
  });

  it("bounds serialized UTF-8 bytes, root count, child count, and nesting independently", () => {
    expect(decode({ ...snapshot([]), padding: "x".repeat(32 * 1024) })).toEqual({});
    expect(decode({ ...snapshot([]), padding: "界".repeat(11_000) })).toEqual({});
    expect(
      decode(snapshot(Array.from({ length: 21 }, (_, i) => ({ ...root(), id: `run-${i}` })))),
    ).toEqual({});
    expect(
      decode(snapshot([root(Array.from({ length: 9 }, (_, i) => step(`step:${i}`)))])),
    ).toEqual({});
    let branch = step("leaf");
    for (let depth = 0; depth < 2; depth++)
      branch = { ...step(`parent-${depth}`), children: [branch] };
    expect(decode(snapshot([root([branch])]))).toEqual({ runs: [root([branch])] });
    expect(decode(snapshot([root([{ ...step("too-deep"), children: [branch] }])]))).toEqual({});
  });
});

describe("bindPiSubagentWidgetChildren", () => {
  const run: ActiveAsyncRunRecord = {
    runId: "run-1",
    mode: "workflow",
    asyncDir: "/fake",
    startedAt: 1,
    ownerMessageId: "owner",
    toolCallId: "tool",
    children: [
      { taskId: "tool:0", stepIndex: 0, canonicalChildId: "build-key" },
      { taskId: "tool:1", stepIndex: 1, canonicalChildId: "check-key", childRunId: "review-run" },
      { taskId: "tool:3", stepIndex: 3, canonicalChildId: "step:3" },
    ],
  };

  it("binds workflow keys, child run IDs and explicit step indices with sparse reordered rows", () => {
    const nodes = [step("step:3"), step("build-key"), step("review-run")];
    expect(bindPiSubagentWidgetChildren(root(nodes), run)).toEqual([
      { node: nodes[0], child: run.children[2] },
      { node: nodes[1], child: run.children[0] },
      { node: nodes[2], child: run.children[1] },
    ]);
  });

  it("never guesses from labels, positions, descendants or another run", () => {
    const nodes = [
      step("unknown"),
      { ...step("check-key"), kind: "host-step" as const },
      { ...step("not-a-step"), kind: "subagent" as const, children: [step("build-key")] },
      step("step:03"),
    ];
    expect(bindPiSubagentWidgetChildren(root(nodes), run)).toEqual([]);
    expect(
      bindPiSubagentWidgetChildren({ ...root([step("build-key")]), id: "other-run" }, run),
    ).toEqual([]);
  });

  it("leaves ambiguous identities unbound in either direction", () => {
    expect(
      bindPiSubagentWidgetChildren(root([step("check-key"), step("review-run")]), run),
    ).toEqual([]);
    expect(bindPiSubagentWidgetChildren(root([step("build-key"), step("build-key")]), run)).toEqual(
      [],
    );
    expect(
      bindPiSubagentWidgetChildren(root([step("check-key")]), {
        ...run,
        children: [{ ...run.children[0], childRunId: "check-key" }, run.children[1]],
      }),
    ).toEqual([]);
  });
});
