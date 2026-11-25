import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { expect, it } from "vitest";
import { PiRpcClient } from "../../src/session/pi-rpc";
import type { PiFrame } from "./fixture";

const recording = new URL("./pi/messages/subagents-widgets.jsonl", import.meta.url);
const payload = (frame: PiFrame, prefix: string): unknown => {
  const lines = frame.widgetLines as string[];
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(new RegExp(`^${prefix}`));
  return JSON.parse(lines[0].slice(prefix.length)) as unknown;
};

it("replays native subagent RPC widgets, busy completion and the subsequent wake", async () => {
  const [metadata, ...rows] = readFileSync(recording, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown) as Array<{
    header?: { source: string };
    sent?: PiFrame;
    frame?: PiFrame;
  }>;
  expect(metadata.header?.source).toContain("Offline pi --mode rpc / installed pi-subagents");
  const stdout = new PassThrough();
  const sent: PiFrame[] = [];
  const trace: PiFrame[] = [];
  const rpc = new PiRpcClient({
    stdout,
    stdin: new Writable({
      write(chunk: Buffer, _, done) {
        sent.push(JSON.parse(chunk.toString("utf8")) as PiFrame);
        done();
      },
    }),
  });
  rpc.on("event", (frame: PiFrame) => trace.push(frame));

  let pending: Promise<unknown> | undefined;
  let requestIndex = 0;
  let inspections = 0;
  try {
    for (const row of rows) {
      if (row.sent) {
        expect(pending).toBeUndefined();
        requestIndex = trace.length;
        const { type, message } = row.sent;
        if (type === "prompt") pending = rpc.prompt(String(message));
        else {
          expect(type).toBe("get_session_stats");
          pending = rpc.getSessionStats();
        }
        await expect.poll(() => sent.length).toBe(1);
        const { id, ...request } = sent[0];
        expect(request).toEqual(row.sent);
        expect(id).toBeTypeOf("string");
      } else {
        const frame = row.frame!;
        if (frame.type === "response") {
          const [request] = sent.splice(0, 1);
          expect(request?.type).toBe(frame.command);
          stdout.write(JSON.stringify({ ...frame, id: request.id }) + "\n");
          await expect(pending).resolves.toEqual(frame.data);
          if (
            request.message ===
            "/subagents-inspect-rpc fixture-request fixture-run step:0 --lines 2"
          ) {
            inspections++;
            const events = trace.slice(requestIndex);
            expect(events).toHaveLength(2);
            const [reply, clear] = events;
            expect(frame.data).toEqual({ disposition: "handled" });
            expect(reply).toMatchObject({
              type: "extension_ui_request",
              method: "setWidget",
              widgetKey: "subagent-inspect",
            });
            expect(payload(reply, "PI_SUBAGENT_INSPECT_JSON:")).toMatchObject({
              kind: "pi-subagents.inspect-reply",
              version: 1,
              requestId: "fixture-request",
              asyncId: "fixture-run",
              childId: "step:0",
              status: "running",
              label: "child-1",
              messages: [{ role: "user", kind: "text" }],
            });
            expect(clear).toMatchObject({
              type: reply.type,
              method: reply.method,
              widgetKey: reply.widgetKey,
            });
            expect(clear).not.toHaveProperty("widgetLines");
          }
          pending = undefined;
        } else stdout.write(JSON.stringify(frame) + "\n");
      }
    }
    expect(pending).toBeUndefined();
    expect(sent).toEqual([]);
    expect(inspections).toBe(1);
  } finally {
    stdout.end();
  }

  const lifecycle = trace.filter((f) =>
    ["agent_start", "agent_end", "agent_settled"].includes(f.type),
  );
  expect(lifecycle.map((f) => f.type)).toEqual(
    Array.from({ length: 3 }, () => ["agent_start", "agent_end", "agent_settled"]).flat(),
  );
  const updates = trace.filter((f) => f.widgetKey === "subagent-async");
  const snapshots = updates.map((f) => payload(f, "PI_SUBAGENT_ASYNC_JSON:"));
  expect(snapshots).toMatchObject(
    ["queued", "running", "complete"].map((state) => ({
      kind: "pi-subagents.async-status-snapshot",
      version: 1,
      runs: [{ id: "fixture-run", state }],
    })),
  );
  expect(snapshots.at(-1)).toMatchObject({
    runs: [{ children: ["child-1", "child-2"].map((id) => ({ id, state: "complete" })) }],
  });
  const complete = trace.indexOf(updates.at(-1)!);
  expect(complete).toBeGreaterThan(trace.indexOf(lifecycle[3])); // Held user turn starts.
  expect(complete).toBeLessThan(trace.indexOf(lifecycle[4])); // Held user turn has not ended.
  const wake = trace.filter((f) => f.type === "message_start");
  expect(wake).toMatchObject([
    {
      message: {
        customType: "subagent-notify",
        details: {
          runs: [
            {
              runId: "fixture-run",
              status: "completed",
              childRuns: ["child-1", "child-2"].map((workflowKey) => ({
                workflowKey,
                status: "completed",
              })),
            },
          ],
        },
      },
    },
  ]);
  expect(trace.indexOf(wake[0])).toBeGreaterThan(trace.indexOf(lifecycle[6])); // Separate wake starts.
  expect(trace.indexOf(wake[0])).toBeLessThan(trace.indexOf(lifecycle[8]));
});
