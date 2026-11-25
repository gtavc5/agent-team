import { expect, it } from "vitest";
import {
  readTracePage,
  TRACE_MAX_BYTES,
  TRACE_MAX_DEPTH,
  TRACE_MAX_EVENTS,
  traceBytes,
} from "../../../shared/subagent-trace";

function history(events: Array<{ kind: string; content: string; toolResult?: string }>) {
  return [
    {
      kind: "subagent_start",
      content: "",
      subagent: {
        taskId: "t",
        description: "Child",
        transcriptRevision: 10,
        events,
      },
    },
  ];
}

it("clamps the requested count and walks 10,000 rows in both directions without gaps", () => {
  const events = Array.from({ length: 10_000 }, (_, i) => ({ kind: "text", content: `row ${i}` }));
  const stored = history(events);
  for (const direction of ["before", "after"] as const) {
    const seen: string[] = [];
    let cursor: number | undefined;
    while (true) {
      const page = readTracePage(1, stored, "t", {
        direction,
        cursor,
        limit: 1_000_000,
        maxBytes: 9_999_999,
      });
      expect(page.events.length).toBeLessThanOrEqual(TRACE_MAX_EVENTS);
      expect(traceBytes(page)).toBeLessThanOrEqual(TRACE_MAX_BYTES);
      expect(page.totalEvents).toBe(events.length);
      expect(page.revision).toBe(10);
      const rows = page.events.map((row) => row.content);
      if (direction === "before") seen.unshift(...rows);
      else seen.push(...rows);
      if (!page.hasMore) break;
      cursor = direction === "before" ? page.start : page.end;
    }
    expect(seen).toEqual(events.map((row) => row.content));
  }
});

it("counts UTF-8 and JSON escaping across the whole reply, and advances past an oversized event", () => {
  const body = '\u0000🧪"\\'.repeat(100_000);
  const events = [
    { kind: "tool_use", content: body, toolResult: body },
    { kind: "text", content: "next" },
  ];
  const stored = history(events);
  const page = readTracePage(1, stored, "t", { direction: "after", maxBytes: 4096 });
  expect(page.truncated).toBe(true);
  expect(page.events[0].truncated).toBe(true);
  expect(page.events[0].content.length).toBeLessThan(body.length);
  expect(page.end).toBeGreaterThan(0);
  expect(traceBytes(page)).toBeLessThanOrEqual(4096);
  const tiny = readTracePage(1, stored, "t", { direction: "after", limit: 1, maxBytes: 512 });
  expect(tiny.events).toHaveLength(1);
  expect(traceBytes(tiny)).toBeLessThanOrEqual(512);
  expect(tiny).toMatchObject({ end: 1, hasMore: true });
  expect(
    readTracePage(2, stored, "t", { direction: "after", cursor: tiny.end }).events[0].content,
  ).toBe("next");
});

it("returns full markdown and terminal usage when the wire budget has room", () => {
  const prompt = `# Review\n\n${"Read ".repeat(270)}`;
  const result = `## Result\n\n${"Done ".repeat(390)}`;
  const usage = { totalTokens: 16_000, toolUses: 3, durationMs: 1_201 };
  const start = history([{ kind: "text", content: "Found it" }])[0];
  const stored = [
    { ...start, subagent: { ...start.subagent, prompt } },
    { kind: "subagent_done", content: "", subagent: { ...start.subagent, summary: result, usage } },
  ];
  expect(readTracePage(1, stored, "t", {})).toMatchObject({
    prompt,
    result,
    usage,
    truncated: false,
    events: [{ content: "Found it" }],
  });
});

it("shrinks escaped metadata inside the UTF-8 budget without stalling the cursor", () => {
  const text = '\u0000🧪"\\'.repeat(4_000);
  const start = history(
    Array.from({ length: 12 }, (_, i) => ({ kind: "text", content: `${i}` })),
  )[0];
  const stored = [{ ...start, subagent: { ...start.subagent, prompt: text, summary: text } }];
  for (const maxBytes of [256, 512, 1024, TRACE_MAX_BYTES]) {
    const page = readTracePage(Number.MAX_SAFE_INTEGER, stored, "t", {
      maxBytes,
      direction: "before",
      cursor: 10,
    });
    expect(traceBytes(page)).toBeLessThanOrEqual(maxBytes);
    expect(page.end).toBe(10);
    expect(page.start).toBeLessThan(10);
    expect(page.truncated).toBe(true);
    if (maxBytes >= 512) {
      expect(page.prompt).toMatch(/…$/);
      expect(page.result).toMatch(/…$/);
    }
  }
});

it("reads terminal-only legacy traces and never embeds a child's trace in its parent's page", () => {
  const leaf = {
    kind: "subagent_done",
    content: "",
    subagent: {
      taskId: "nested",
      description: "Nested",
      status: "completed" as const,
      summary: "Result",
      events: [{ kind: "text", content: "nested body" }],
    },
  };
  const root = {
    kind: "subagent_done",
    content: "",
    subagent: {
      taskId: "root",
      description: "Root",
      prompt: "Do work",
      events: [leaf],
    },
  };
  const page = readTracePage(1, [root], "root", {});
  expect(page).toMatchObject({ prompt: "Do work", totalEvents: 1, revision: 0 });
  expect(page.events[0].child).toMatchObject({ taskId: "nested", status: "completed" });
  expect(JSON.stringify(page)).not.toContain("nested body");
  expect(readTracePage(2, [root], "root", { path: ["nested"] })).toMatchObject({
    events: [{ kind: "text", content: "nested body" }],
    result: "Result",
  });
  expect(readTracePage(2, [root], "root", { path: ["foreign"] })).toMatchObject({
    unavailable: true,
  });
});

it("keeps nested targets requestable through the depth limit and retains tool presentation metadata", () => {
  let branch: NonNullable<Parameters<typeof readTracePage>[1]>[number] = {
    kind: "subagent_start",
    content: "",
    subagent: { taskId: "deep", description: "Too deep", events: [] },
  };
  for (let depth = TRACE_MAX_DEPTH; depth >= 0; depth--) {
    const tool = {
      kind: "tool_use",
      content: "**Read** `file`",
      toolName: "Read",
      toolResult: "**Failed**",
      toolResultIsMarkdown: true,
      toolResultIsError: true,
    };
    branch = {
      ...branch,
      subagent: { taskId: `${depth}`, description: `Child ${depth}`, events: [branch, tool] },
    };
  }
  const path = Array.from({ length: TRACE_MAX_DEPTH }, (_, i) => `${i + 1}`);
  expect(readTracePage(1, [branch], "0", { path: path.slice(0, -1) }).events[0].child?.taskId).toBe(
    path.at(-1),
  );
  const deepest = readTracePage(2, [branch], "0", { path });
  expect(deepest.events[0].child).toBeUndefined();
  expect(deepest.events[1]).toMatchObject({
    toolName: "Read",
    toolResultIsMarkdown: true,
    failed: true,
  });
  expect(readTracePage(3, [branch], "0", { path: [...path, "deep"] }).unavailable).toBe(true);
});
