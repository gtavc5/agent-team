import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { UsageObservation } from "../../../shared/usage";
import { readWorkspaceMetadata } from "../workspace/state";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** A managed path names the candidate owner; the native header must agree with its ID. */
export function verifiesPiSession(file: string, sessionId: string): boolean {
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) return false;
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, Math.min(4096, buffer.length - length), length);
        if (!count) return false;
        const end = buffer.subarray(length, length + count).indexOf(10);
        if (end !== -1) {
          const header = JSON.parse(buffer.toString("utf8", 0, length + end)) as Record<
            string,
            unknown
          > | null;
          return (
            header?.type === "session" &&
            header.version === 3 &&
            header.id === sessionId &&
            !header.parentSession
          );
        }
        length += count;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // Absent, torn, or unreadable headers are not ownership evidence.
  }
  return false;
}

export function recordWorkspaceBinding(
  db: DatabaseSync,
  source: UsageObservation["source"],
  sessionId: string,
  workspaceId: string,
): void {
  db.prepare("INSERT OR IGNORE INTO usage_workspace(source,session,workspace) VALUES(?,?,?)").run(
    source,
    sessionId,
    workspaceId,
  );
}

export function storedCodexWorkspaceBindings(baseDir: string): Map<string, string | null> {
  const bindings = new Map<string, string | null>();
  for (const workspace of readWorkspaceMetadata(baseDir)) {
    for (const agent of workspace.agents) {
      const session = agent?.session;
      if (
        session?.config?.backend !== "codex" ||
        typeof session.sessionId !== "string" ||
        !UUID.test(session.sessionId)
      )
        continue;
      if (session.config.workspaceId != null && session.config.workspaceId !== workspace.id)
        continue;
      const previous = bindings.get(session.sessionId);
      bindings.set(
        session.sessionId,
        previous === undefined || previous === workspace.id ? workspace.id : null,
      );
    }
  }
  return bindings;
}
