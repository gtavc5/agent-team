// The index's full-text table writes rows of its own, some with ids past
// 2^53: a statement after one must not fail on the connection's last id.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DatabaseSync } from "node:sqlite";
import { HistoryIndex } from "../../src/workspace/history-index";
import { closeHistory, historyFile, historyIndexFile, historyOf } from "../../src/workspace/state";
import type { Message } from "../../src/workspace/workspace";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0)) c();
});

const msg = (id: string, content: string): Message => ({
  id,
  kind: "agent",
  agentId: "a",
  content,
  timestamp: 1,
  status: "done",
});

describe("indexing after the full-text table used ids past 2^53", () => {
  it("still indexes a new message", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-rowid-"));
    const index = new HistoryIndex(historyIndexFile(base), historyFile(base));
    cleanups.push(
      () => index.close(),
      () => closeHistory(base),
      () => fs.rmSync(base, { recursive: true, force: true }),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    historyOf(base).save("s", [msg("m1", "first words")], "all");
    index.markDirty();
    while (!index.sync(1000));
    expect(index.search({ terms: ["first"], limit: 5 }).hits).toHaveLength(1);

    // As FTS5 does when it writes a segment: the connection's last insert id
    // is one no JavaScript number holds.
    const db = (index as unknown as { db: DatabaseSync }).db;
    db.exec("create temp table big (x); insert into big (rowid, x) values (9007749010554880, 1)");

    // A new message: its delete touches no full-text row, so nothing else
    // sets the last id before the index's own statements run.
    historyOf(base).save("s", [msg("m1", "first words"), msg("m2", "second words")], "all");
    index.markDirty();
    while (!index.sync(1000));
    expect(errors).not.toHaveBeenCalled();
    expect(index.search({ terms: ["second"], limit: 5 }).hits).toHaveLength(1);
  });
});
