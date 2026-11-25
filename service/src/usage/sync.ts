import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { discoverAcpUsageSources, readAcpUsage } from "./acp";
import { insertObservation, withLedger } from "./ledger";
import { importPiFile } from "./pi-history";
import { readPrices } from "./pricing";
import {
  recordWorkspaceBinding,
  storedCodexWorkspaceBindings,
  verifiesPiSession,
} from "./workspace-bindings";

function entries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

type ManagedPiSession = { file: string; workspaceId?: string | null };

function managedSessions(baseDir: string): Map<string, ManagedPiSession> {
  const sessions = new Map<string, ManagedPiSession>();
  const root = join(baseDir, "pi-sessions");
  for (const dir of entries(root)) {
    if (!dir.isDirectory()) continue;
    for (const file of entries(join(root, dir.name))) {
      const match = file.isFile() && /_([0-9a-f-]{36})\.jsonl$/i.exec(file.name);
      if (!match) continue;
      const id = match[1];
      const path = join(root, dir.name, file.name);
      const previous = sessions.get(id);
      if (verifiesPiSession(path, id)) {
        // An unscoped Pi session uses `local`; conflicting managed directories prove no owner.
        const workspaceId = dir.name === "local" ? null : dir.name;
        sessions.set(id, {
          file: path,
          workspaceId:
            previous?.workspaceId === undefined || previous.workspaceId === workspaceId
              ? workspaceId
              : null,
        });
      } else if (!previous) {
        sessions.set(id, { file: path });
      }
    }
  }
  return sessions;
}

function syncCodexWorkspaceBindings(baseDir: string): void {
  const bindings = storedCodexWorkspaceBindings(baseDir);
  if (!bindings.size) return;
  withLedger(baseDir, (db) => {
    const existing = db.prepare(`SELECT 1 FROM observations WHERE source='codex' AND session=?
      UNION ALL SELECT 1 FROM journey WHERE source='codex' AND session=? LIMIT 1`);
    for (const [sessionId, workspaceId] of bindings) {
      if (workspaceId && existing.get(sessionId, sessionId))
        recordWorkspaceBinding(db, "codex", sessionId, workspaceId);
    }
  });
}

export function syncSources(baseDir: string): number {
  syncCodexWorkspaceBindings(baseDir);
  const sessions = managedSessions(baseDir);
  return syncManagedPi(baseDir, sessions) + syncManagedAcp(baseDir, sessions);
}

export function syncPi(baseDir: string): number {
  return syncManagedPi(baseDir, managedSessions(baseDir));
}

function syncManagedPi(baseDir: string, sessions: Map<string, ManagedPiSession>): number {
  if (!sessions.size) return 0;
  const prices = readPrices(baseDir);
  return withLedger(baseDir, (db) => {
    let incomplete = 0;
    for (const [id, { file, workspaceId }] of sessions) {
      try {
        if (!importPiFile(db, prices, file, id)) incomplete++;
        if (workspaceId) recordWorkspaceBinding(db, "pi", id, workspaceId);
      } catch {
        incomplete++;
      }
    }
    return incomplete;
  });
}

export function syncAcp(baseDir: string, homeDir?: string): number {
  return syncManagedAcp(baseDir, managedSessions(baseDir), homeDir);
}

function syncManagedAcp(
  baseDir: string,
  sessions: Map<string, ManagedPiSession>,
  homeDir?: string,
): number {
  const discovery = discoverAcpUsageSources({
    dataDir: baseDir,
    homeDir,
    piSessionIds: sessions.keys(),
  });
  if (discovery.status !== "ok") return discovery.status === "missing" ? 0 : 1;
  if (!discovery.sources.length) return 0;
  const prices = readPrices(baseDir);
  return withLedger(baseDir, (db) => {
    let incomplete = 0;
    for (const source of discovery.sources) {
      const session = source.acpSessionId;
      const workspaceId = sessions.get(source.piSessionId)?.workspaceId;
      if (workspaceId) recordWorkspaceBinding(db, "acp", session, workspaceId);
      const cursor = db.prepare("SELECT idx, partial FROM acp_cursor WHERE session=?").get(session);
      let partial = Boolean(cursor?.partial);
      let afterIdx = Number(cursor?.idx ?? -1);
      while (true) {
        const page = readAcpUsage(source, { afterIdx, limit: 16 });
        if (page.status !== "ok") {
          partial = true;
          break;
        }
        if (page.nextAfterIdx === afterIdx) break;
        partial ||= page.skippedRows > 0;
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const row of page.rows)
            insertObservation(
              db,
              {
                source: "acp",
                sessionId: session,
                piSessionId: source.piSessionId,
                channel: "antigravity-acp",
                unit: "inference",
                id: String(row.idx),
                timestamp: row.timestampMs,
                model: row.modelId,
                input: row.inputTokens,
                cacheRead: row.cacheReadTokens,
                cacheWrite: row.cacheWriteTokens,
                output: row.outputTokens,
                price: { kind: "unpriced", usd: null },
              },
              prices,
            );
          db.prepare("INSERT OR REPLACE INTO acp_cursor VALUES(?,?,?)").run(
            session,
            page.nextAfterIdx,
            Number(partial),
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        afterIdx = page.nextAfterIdx;
        if (!page.hasMore) break;
      }
      if (partial) incomplete++;
    }
    return incomplete;
  });
}
