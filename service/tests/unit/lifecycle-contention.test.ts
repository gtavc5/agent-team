import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { it, expect } from "vitest";
import { readLifecycle, lifecycleWriter } from "../../src/usage/lifecycle";

it("waits for the initial exclusive schema transaction on the reader thread", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "stats-schema-"));
  const dir = join(baseDir, ".agent-team");
  mkdirSync(dir);
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(
    `const {parentPort,workerData}=require('node:worker_threads');
 const db=new (require('node:sqlite').DatabaseSync)(workerData.file);
 db.exec('BEGIN EXCLUSIVE');parentPort.postMessage('locked');
 Atomics.wait(workerData.signal,0,0,2000);Atomics.wait(workerData.signal,0,1,20);db.close();`,
    { eval: true, workerData: { file: join(dir, "lifecycle.sqlite"), signal } },
  );
  try {
    await once(worker, "message");
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    expect(readLifecycle(baseDir, "ws")).toEqual([]);
  } finally {
    await worker.terminate();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

it("retains a boundary after another writer holds the lifecycle database", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "stats-contention-"));
  const write = lifecycleWriter({ dataDir: baseDir, workspaceId: "ws" }, "pi", () => "thread")!;
  const step = { turnId: "turn", stepId: "step", kind: "model" as const };
  try {
    write({ ...step, marker: "stepStart", at: 1 });
    const db = new DatabaseSync(join(baseDir, ".agent-team", "lifecycle.sqlite"));
    try {
      db.exec("BEGIN IMMEDIATE");
      write({ ...step, marker: "firstDelta", at: 2 });
    } finally {
      db.close();
    }
    await expect
      .poll(() => readLifecycle(baseDir, "ws").map((m) => m.marker))
      .toEqual(["stepStart", "firstDelta"]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
