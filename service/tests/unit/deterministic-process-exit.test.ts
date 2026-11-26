import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { expectProcessExit, waitForState } from "../e2e/pilot-assertions";

it("releases a competing file lock and rolls back when one offline child exits nonzero", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yaat 恢复-")));
  const cwd = join(root, "work tree");
  mkdirSync(cwd);
  const file = join(cwd, "状态 cache.db");
  const parent = new DatabaseSync(file);
  try {
    parent.exec("CREATE TABLE messages (content TEXT NOT NULL)");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN IMMEDIATE; INSERT INTO messages VALUES ('uncommitted')");
      process.stdin.resume();
      process.stdin.once('data', () => process.exit(17));
      console.log(process.cwd());
    `,
        file,
      ],
      { cwd, stdio: ["pipe", "pipe", "ignore"] },
    );
    const exit = expectProcessExit(child, 17);
    // Observe the promise even when a pre-exit assertion fails; reap the exact child below.
    void exit.catch(() => {});
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
    });
    try {
      // The path (with non-ASCII and a space) is printed only after acquiring the lock.
      await waitForState(
        "child acquired SQLite write lock",
        () => ({ stdout, exitCode: child.exitCode }),
        (state) => state.stdout.endsWith("\n"),
      );
      expect(realpathSync(stdout.trim())).toBe(cwd);
      expect(() => parent.exec("BEGIN IMMEDIATE")).toThrow(expect.objectContaining({ errcode: 5 }));
      child.stdin.end("exit\n");
      await exit;
      expect(parent.prepare("SELECT content FROM messages").all()).toEqual([]);
      parent.exec("BEGIN IMMEDIATE; INSERT INTO messages VALUES ('recovered'); COMMIT");
      expect(parent.prepare("SELECT content FROM messages").get()?.content).toBe("recovered");
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
      await exit.catch(() => {});
    }
  } finally {
    parent.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 20_000);
