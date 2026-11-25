import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPiSubagentFinalOutput } from "../../src/session/pi-subagent-output";

let root: string;
let resultsDir: string;
let artifactRoot: string;
let sessionRoot: string;
let replayPath: string;
let archivePath: string;
const runId = "async:run";
const owner = "pi-session";
const createdAt = 1000;
const expiresAt = 2000;

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value));
}

function writeReplay(results: unknown[], patch: Record<string, unknown> = {}) {
  writeJson(replayPath, {
    version: 1,
    runId,
    sessionId: owner,
    completedAt: createdAt,
    expiresAt,
    completion: { runId, results, archivePath },
    archivePath,
    ...patch,
  });
}

function writeArchive(entries: unknown[], patch: Record<string, unknown> = {}) {
  writeJson(archivePath, { version: 1, runId, createdAt, entries, ...patch });
}

function read(stepIndex = 0) {
  return readPiSubagentFinalOutput({
    resultsDir,
    runId,
    stepIndex,
    ownsSession: (id) => id === owner,
    now: createdAt + 1,
    artifactRoots: [artifactRoot],
    sessionRoots: [sessionRoot],
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-output-"));
  resultsDir = path.join(root, "async-subagent-results");
  artifactRoot = path.join(root, "artifacts");
  sessionRoot = path.join(root, "sessions", "parent");
  const name = `${encodeURIComponent(runId)}.json`;
  replayPath = path.join(resultsDir, "completion-replay", name);
  archivePath = path.join(resultsDir, "output-archives", name);
  for (const dir of [
    path.dirname(replayPath),
    path.dirname(archivePath),
    artifactRoot,
    sessionRoot,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("readPiSubagentFinalOutput", () => {
  it("uses the exact result index, not the agent name, archive position or run summary", () => {
    writeReplay([{ agent: "worker" }, { agent: "worker" }]);
    writeArchive([
      { source: "result-tail", text: "aggregate" },
      { resultIndex: 1, agent: "worker", source: "result-tail", text: "second", truncated: true },
      { resultIndex: 0, agent: "worker", source: "result-tail", text: "first" },
    ]);
    expect(read()).toEqual({ text: "first", truncated: false });
    expect(read(1)).toEqual({ text: "second", truncated: true });
    expect(read(2)).toBeUndefined();
  });

  it("rejects ambiguous, unindexed, or mismatched child output", () => {
    const child = { resultIndex: 0, agent: "worker", source: "result-tail", text: "answer" };
    writeReplay([{ agent: "worker" }]);
    for (const entries of [
      [child, child],
      [{ ...child, resultIndex: undefined }],
      [{ ...child, agent: "other" }],
    ]) {
      writeArchive(entries);
      expect(read()).toBeUndefined();
    }
  });

  it("requires a current replay owned by the session and tied to the canonical archive", () => {
    const child = { resultIndex: 0, source: "result-tail", text: "answer" };
    writeArchive([child]);
    expect(read()).toBeUndefined();
    for (const patch of [
      { sessionId: "other" },
      { expiresAt: createdAt + 1 },
      { version: 2 },
      { runId: "other" },
      { archivePath: path.join(root, "other.json") },
      { completion: { runId: "other", results: [{}], archivePath } },
    ]) {
      writeReplay([{}], patch);
      expect(read()).toBeUndefined();
    }
    writeReplay([{}]);
    for (const patch of [{ runId: "other" }, { version: 2 }, { createdAt: 999 }]) {
      writeArchive([child], patch);
      expect(read()).toBeUndefined();
    }
    fs.writeFileSync(archivePath, "{");
    expect(read()).toBeUndefined();
    expect(fs.existsSync(replayPath)).toBe(true);
  });

  it("reads only the matching archived artifact and caps its UTF-8 tail", () => {
    const artifact = path.join(artifactRoot, "run_worker_output.md");
    fs.writeFileSync(artifact, "😀".repeat(30_000) + "\nlast");
    writeReplay([{ artifactPaths: { outputPath: artifact } }]);
    writeArchive([{ resultIndex: 0, source: "output-artifact", path: artifact }]);
    const result = read();
    expect(result?.truncated).toBe(true);
    expect(result?.text).toMatch(/^😀.*\nlast$/u);
    expect(Buffer.byteLength(result!.text, "utf8")).toBeLessThanOrEqual(64 * 1024);
    writeReplay([{ artifactPaths: { outputPath: path.join(artifactRoot, "different.md") } }]);
    expect(read()).toBeUndefined();
  });

  it("rejects oversized metadata and bounds inline result tails", () => {
    writeReplay([{ outputPartial: true }]);
    const entry = { resultIndex: 0, source: "result-tail", text: "x".repeat(80_000) + "end" };
    writeArchive([entry]);
    expect(read()).toEqual({ text: "x".repeat(65533) + "end", truncated: true });
    writeArchive([entry], { padding: "x".repeat(1024 * 1024) });
    expect(read()).toBeUndefined();
    writeArchive([{ ...entry, text: "partial" }]);
    expect(read()).toEqual({ text: "partial", truncated: true });
  });

  it("takes only final assistant text from the active child session branch", () => {
    const session = path.join(sessionRoot, "run.jsonl");
    const records = [
      { type: "session", id: "child", version: 3 },
      { type: "message", id: "user", parentId: null, message: { role: "user", content: "task" } },
      {
        type: "message",
        id: "final",
        parentId: "user",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [
            { type: "thinking", thinking: "not public output" },
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        },
      },
      {
        type: "message",
        id: "other",
        parentId: "user",
        message: { role: "assistant", content: "inactive reply" },
      },
      { type: "thinking_level_change", id: "leaf", parentId: "final" },
    ];
    const writeSession = () =>
      fs.writeFileSync(session, records.map((line) => JSON.stringify(line)).join("\n") + "\n");
    writeSession();
    writeReplay([{ sessionFile: session }]);
    writeArchive([{ resultIndex: 0, source: "session", path: session }]);
    expect(read()).toEqual({ text: "line one\nline two", truncated: false });
    records.push({
      type: "message",
      id: "later",
      parentId: "final",
      message: { role: "toolResult", content: "not a final answer" },
    });
    writeSession();
    expect(read()).toBeUndefined();
  });

  it("never reads an escaped, linked or non-file artifact even when both records name it", () => {
    const outside = path.join(root, "artifacts-other");
    fs.mkdirSync(outside);
    const target = path.join(outside, "secret.md");
    fs.writeFileSync(target, "secret");
    const junction = path.join(artifactRoot, "outside");
    fs.symlinkSync(outside, junction, "junction");
    const hardlink = path.join(artifactRoot, "hardlink.md");
    fs.linkSync(target, hardlink);
    for (const file of [target, path.join(junction, "secret.md"), hardlink, artifactRoot]) {
      writeReplay([{ artifactPaths: { outputPath: file } }]);
      writeArchive([{ resultIndex: 0, source: "output-artifact", path: file }]);
      expect(read()).toBeUndefined();
    }
  });

  it("rejects a canonical archive path whose parent redirects outside the result store", () => {
    writeReplay([{}]);
    const outside = path.join(root, "elsewhere");
    fs.renameSync(path.dirname(archivePath), outside);
    fs.symlinkSync(outside, path.dirname(archivePath), "junction");
    writeArchive([{ resultIndex: 0, source: "result-tail", text: "not a canonical file" }]);
    expect(read()).toBeUndefined();
  });
});
