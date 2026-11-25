import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { piUsage } from "../session/usage-observation";
import { insertObservation } from "./ledger";
import type { Prices } from "./pricing";

// Pi appends newline-terminated JSON. Commit a byte offset only after the whole line:
// a torn write is retried, and a crash before checkpointing can only replay stable IDs.
export function importPiFile(
  db: DatabaseSync,
  prices: Prices,
  file: string,
  sessionId: string,
): boolean {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return false;
    const identity = `${stat.dev}:${stat.ino}`;
    const cursor = db
      .prepare("SELECT inode,offset,partial FROM pi_cursor WHERE session=?")
      .get(sessionId);
    const same = cursor?.inode === identity && Number(cursor.offset) <= Number(stat.size);
    let offset = same ? Number(cursor.offset) : 0;
    let partial = same && Boolean(cursor.partial);
    if (offset === Number(stat.size)) return !partial;
    const buffer = Buffer.allocUnsafe(65536);
    let chunks: Buffer[] = [],
      size = 0,
      consumed = offset,
      start = offset;
    while (offset < Number(stat.size)) {
      const n = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, Number(stat.size) - offset),
        offset,
      );
      if (!n) break;
      const chunk = buffer.subarray(0, n);
      let pos = 0;
      while (pos < n) {
        const lf = chunk.indexOf(10, pos),
          end = lf === -1 ? n : lf;
        size += end - pos;
        if (size <= 8 * 1024 * 1024) chunks.push(Buffer.from(chunk.subarray(pos, end)));
        if (lf === -1) break;
        let row: Record<string, unknown> | undefined;
        if (size <= 8 * 1024 * 1024) {
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
              row = parsed as Record<string, unknown>;
          } catch {
            /* malformed record */
          }
        }
        if (start === 0) {
          // Fork files can include copied responses; do not count that ancestry as new work.
          if (
            row?.type !== "session" ||
            row.version !== 3 ||
            row.id !== sessionId ||
            row.parentSession
          )
            return false;
        } else if (!row || typeof row.id !== "string") partial = true;
        else if (row.type === "message" && row.message && typeof row.message === "object") {
          const fact = piUsage(sessionId, row.message as Record<string, unknown>, row.id);
          if (fact) insertObservation(db, fact, prices);
        } else if (row.type === "compaction") {
          const t =
            typeof row.timestamp === "number"
              ? row.timestamp
              : typeof row.timestamp === "string"
                ? Date.parse(row.timestamp)
                : NaN;
          const event = {
            id: row.id,
            source: "pi",
            sessionId,
            kind: "compaction",
            name: "Context compaction",
            timestamp: Number.isFinite(new Date(t).getTime()) ? t : null,
          };
          db.prepare("INSERT OR IGNORE INTO journey VALUES(?,?,?,?)").run(
            "pi",
            sessionId,
            row.id,
            JSON.stringify(event),
          );
        }
        consumed = offset + lf + 1;
        start = consumed;
        chunks = [];
        size = 0;
        pos = lf + 1;
      }
      offset += n;
    }
    db.prepare("INSERT OR REPLACE INTO pi_cursor VALUES(?,?,?,?)").run(
      sessionId,
      identity,
      consumed,
      Number(partial),
    );
    return !partial;
  } finally {
    closeSync(fd);
  }
}
