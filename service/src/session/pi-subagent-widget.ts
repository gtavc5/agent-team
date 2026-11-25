import { z } from "zod";
import type { ActiveAsyncChildRecord, ActiveAsyncRunRecord } from "./types";

const ASYNC_WIDGET_KEY = "subagent-async";
const INSPECT_WIDGET_KEY = "subagent-inspect";
const ASYNC_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
// Host-side limits match the producer's RPC defaults, regardless of advertised caps.
const MAX_JSON_BYTES = 32 * 1024;
const MAX_RUNS = 20;
const MAX_CHILDREN = 8;
const MAX_DEPTH = 3;
const displayText = z.string().min(1).max(160);
const nonnegativeInteger = z.int().nonnegative();
const activitySchema = z.object({
  state: displayText.optional(),
  currentTool: displayText.optional(),
  lastActivityAt: nonnegativeInteger.optional(),
  currentToolStartedAt: nonnegativeInteger.optional(),
  turnCount: nonnegativeInteger.optional(),
  toolCount: nonnegativeInteger.optional(),
});
const nodeSchema = z.object({
  id: displayText,
  kind: z.enum(["subagent", "workflow", "step", "host-step"]),
  label: displayText,
  state: z
    .enum(["queued", "running", "complete", "failed", "partial", "paused", "stopped", "rejected"])
    .transform((state) => (state === "complete" ? "completed" : state)),
  startedAt: nonnegativeInteger.optional(),
  updatedAt: nonnegativeInteger.optional(),
  endedAt: nonnegativeInteger.optional(),
  agent: displayText.optional(),
  model: displayText.optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  activity: activitySchema.optional(),
  progressText: displayText.optional(),
  progressUpdatedAt: nonnegativeInteger.optional(),
  children: z.array(z.unknown()).max(MAX_CHILDREN).optional(),
});
const snapshotSchema = z.object({
  kind: z.literal("pi-subagents.async-status-snapshot"),
  version: z.literal(1),
  runs: z.array(z.unknown()).max(MAX_RUNS),
});

export type PiSubagentWidgetNode = Omit<z.output<typeof nodeSchema>, "children"> & {
  children?: PiSubagentWidgetNode[];
};

function isRunNode(node: PiSubagentWidgetNode): boolean {
  return node.kind === "subagent" || node.kind === "workflow";
}

function decodeNodes(values: unknown[], depth: number): PiSubagentWidgetNode[] | undefined {
  const nodes: PiSubagentWidgetNode[] = [];
  for (const value of values) {
    const parsed = nodeSchema.safeParse(value);
    if (!parsed.success) return;
    const { children, ...node } = parsed.data;
    if (depth === 0 && !isRunNode(node)) return;
    if (children !== undefined) {
      if (children.length && depth === MAX_DEPTH) return;
      const decoded = decodeNodes(children, depth + 1);
      if (!decoded) return;
      nodes.push({ ...node, children: decoded });
    } else {
      nodes.push(node);
    }
  }
  return nodes;
}

/** An omitted `runs` consumes the reserved widget without replacing the current snapshot. */
export function decodePiSubagentWidget(
  event: Record<string, unknown>,
): { runs?: PiSubagentWidgetNode[] } | undefined {
  if (event.method !== "setWidget") return;
  if (event.widgetKey === INSPECT_WIDGET_KEY) return {};
  if (event.widgetKey !== ASYNC_WIDGET_KEY) return;
  const lines = event.widgetLines;
  if (lines === undefined) return { runs: [] };
  if (!Array.isArray(lines) || lines.length !== 1) return {};
  const line: unknown = lines[0];
  if (
    typeof line !== "string" ||
    line.length > ASYNC_PREFIX.length + MAX_JSON_BYTES ||
    !line.startsWith(ASYNC_PREFIX)
  )
    return {};
  const json = line.slice(ASYNC_PREFIX.length);
  if (Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) return {};
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return {};
  }
  const runs = decodePiSubagentSnapshot(payload);
  return runs ? { runs } : {};
}

export function decodePiSubagentSnapshot(payload: unknown): PiSubagentWidgetNode[] | undefined {
  const snapshot = snapshotSchema.safeParse(payload);
  if (snapshot.success) return decodeNodes(snapshot.data.runs, 0);
}

/** Only bind uniquely paired identities on direct step children of the same run. */
export function bindPiSubagentWidgetChildren(
  root: PiSubagentWidgetNode,
  run: ActiveAsyncRunRecord,
): { node: PiSubagentWidgetNode; child: ActiveAsyncChildRecord }[] {
  if (root.id !== run.runId || !isRunNode(root)) return [];
  const candidates = (root.children ?? [])
    .filter((node) => node.kind === "step")
    .map((node) => ({
      node,
      matches: run.children.filter(
        (child) =>
          node.id === child.canonicalChildId ||
          node.id === child.childRunId ||
          node.id === `step:${child.stepIndex}`,
      ),
    }));
  const matchesPerTask = new Map<string, number>();
  for (const { matches } of candidates) {
    for (const { taskId } of matches) {
      matchesPerTask.set(taskId, (matchesPerTask.get(taskId) ?? 0) + 1);
    }
  }
  return candidates.flatMap(({ node, matches: [child, ...others] }) =>
    child && others.length === 0 && matchesPerTask.get(child.taskId) === 1 ? [{ node, child }] : [],
  );
}
