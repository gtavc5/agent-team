import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../storage/atomic-write";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface LifecycleRecord {
  turnId: string;
  stepId: string;
  kind: "user" | "model" | "tool" | "compaction";
  at: number;
  marker:
    | "stepStart"
    | "firstDelta"
    | "stepEnd"
    | "toolStart"
    | "toolResult"
    | "compaction"
    | "nativeEntry";
  source: "pi" | "codex";
  sessionId?: string;
  trigger?: string;
  inferenceId?: string;
  piMessageKey?: string;
  piCompactionEntryId?: string;
  toolCallId?: string;
  model?: string;
  promptTokens?: number;
}

const file = (baseDir: string) => join(baseDir, ".agent-team", "lifecycle.sqlite");

const recoveryDir = (baseDir: string, workspaceId: string) =>
  join(
    baseDir,
    ".agent-team",
    "lifecycle-overflow",
    Buffer.from(workspaceId).toString("base64url"),
  );
const identity = (f: LifecycleRecord) =>
  JSON.stringify([f.source, f.sessionId, f.turnId, f.stepId, f.marker]);

export function readLifecycle(baseDir: string, workspaceId: string): LifecycleRecord[] {
  const rows = readStored(baseDir, workspaceId);
  const overflow = recoveryDir(baseDir, workspaceId);
  if (!existsSync(overflow)) return rows;
  const seen = new Set(rows.map(identity));
  for (const name of readdirSync(overflow)) {
    if (!name.endsWith(".json")) continue;
    const row = JSON.parse(readFileSync(join(overflow, name), "utf8")) as LifecycleRecord;
    const key = identity(row);
    if (!seen.has(key)) {
      rows.push(row);
      seen.add(key);
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

function readStored(baseDir: string, workspaceId: string): LifecycleRecord[] {
  const path = file(baseDir);
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true, timeout: 250 });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'lifecycle'").get()) return [];
    return db
      .prepare("SELECT fact FROM lifecycle WHERE workspace = ? ORDER BY at, rowid")
      .all(workspaceId)
      .map(({ fact }) => JSON.parse(String(fact)) as LifecycleRecord);
  } finally {
    db.close();
  }
}

type Mark = Omit<LifecycleRecord, "source" | "sessionId">;

export function lifecycleWriter(
  config: { dataDir?: string; workspaceId?: string },
  source: LifecycleRecord["source"],
  session: () => string | null,
): ((mark: Mark, nativeSessionId?: string) => void) | undefined {
  const { dataDir, workspaceId } = config;
  if (!dataDir || !workspaceId) return;
  const path = file(dataDir);
  let initialized = false;
  let warned = false;
  return (mark, nativeSessionId) => {
    const sessionId = nativeSessionId ?? session() ?? undefined;
    const fact: LifecycleRecord = { ...mark, source, sessionId };
    try {
      if (!initialized) mkdirSync(join(dataDir, ".agent-team"), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(path);
      try {
        if (!initialized) {
          chmodSync(path, 0o600);
          db.exec(`PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS lifecycle (
              workspace TEXT NOT NULL, at INTEGER NOT NULL, identity TEXT NOT NULL, fact TEXT NOT NULL,
              UNIQUE (workspace, identity)
            );
            CREATE INDEX IF NOT EXISTS lifecycle_workspace_time ON lifecycle(workspace, at);`);
          initialized = true;
        }
        db.prepare("INSERT OR IGNORE INTO lifecycle VALUES(?,?,?,?)").run(
          workspaceId,
          mark.at,
          identity(fact),
          JSON.stringify(fact),
        );
      } finally {
        db.close();
      }
    } catch {
      // Never wait for a SQLite writer on the stream thread. A separate atomic record
      // survives a process exit; stats readers union it by the same idempotency key.
      try {
        writeAtomicJson(join(recoveryDir(dataDir, workspaceId), `${randomUUID()}.json`), fact);
      } catch {
        if (!warned) console.warn("[lifecycle] Could not persist session boundary");
        warned = true;
      }
    }
  };
}
