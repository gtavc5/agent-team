import { chmodSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../storage/atomic-write";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { JourneyEvent, UsageObservation, UsagePrice } from "../../../shared/usage";
import { entryPrice, readPrices, type Prices } from "./pricing";

export function withLedger<T>(baseDir: string, work: (db: DatabaseSync) => T): T {
  const dir = join(baseDir, ".agent-team");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "usage.sqlite");
  const db = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
    db.exec("PRAGMA busy_timeout=50");
    if (schemaVersion(db) < 2) migrate(db);
    return work(db);
  } finally {
    db.close();
  }
}

const schemaVersion = (db: DatabaseSync) =>
  Number(db.prepare("PRAGMA user_version").get()?.user_version);

function migrate(db: DatabaseSync): void {
  if (schemaVersion(db) === 0) db.exec("PRAGMA journal_mode=WAL");
  db.exec("BEGIN IMMEDIATE");
  // Recheck under the write lock: both the service and import worker can open a fresh ledger.
  const version = schemaVersion(db);
  if (version === 0)
    db.exec(`CREATE TABLE IF NOT EXISTS observations (
      source TEXT NOT NULL, session TEXT NOT NULL, id TEXT NOT NULL, fact TEXT NOT NULL,
      PRIMARY KEY (source,session,id)
    ); CREATE TABLE IF NOT EXISTS acp_cursor (session TEXT PRIMARY KEY, idx INTEGER NOT NULL, partial INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pi_cursor(session TEXT PRIMARY KEY, inode TEXT NOT NULL, offset INTEGER NOT NULL, partial INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS journey (
      source TEXT NOT NULL, session TEXT NOT NULL, id TEXT NOT NULL, fact TEXT NOT NULL,
      PRIMARY KEY (source,session,id)
    ); CREATE TABLE IF NOT EXISTS receipts (
      source TEXT NOT NULL, session TEXT NOT NULL, id TEXT NOT NULL, dated TEXT NOT NULL, usd REAL NOT NULL,
      PRIMARY KEY (source,session,id)
    );`);
  if (version < 2)
    db.exec(`ALTER TABLE observations ADD COLUMN timestamp REAL AS (json_extract(fact,'$.timestamp'));
    ALTER TABLE observations ADD COLUMN unit TEXT AS (json_extract(fact,'$.unit'));
    ALTER TABLE journey ADD COLUMN timestamp REAL AS (json_extract(fact,'$.timestamp'));
    CREATE INDEX observations_unit_time ON observations(unit,timestamp,source,session,id);
    CREATE INDEX journey_time ON journey(timestamp,source,session,id);
    CREATE INDEX observations_session_time ON observations(session,unit,timestamp,source,id);
    CREATE INDEX journey_session_time ON journey(session,timestamp,source,id);
    CREATE TABLE IF NOT EXISTS usage_workspace (
      source TEXT NOT NULL, session TEXT NOT NULL, workspace TEXT NOT NULL,
      PRIMARY KEY (source,session,workspace)
    );
    CREATE INDEX IF NOT EXISTS usage_workspace_workspace ON usage_workspace(workspace,source,session);
    PRAGMA user_version=2;`);
  db.exec("COMMIT");
}

export function insertObservation(db: DatabaseSync, obs: UsageObservation, prices: Prices): void {
  if (
    ![obs.input, obs.cacheRead, obs.cacheWrite, obs.output].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    return;
  insertLive(db, { ...obs, price: entryPrice(obs, prices) });
}

/** An unavailable observer must not interrupt a running assistant turn. */
export function recordUsage(baseDir: string, obs: UsageObservation): void {
  storeLive(baseDir, { ...obs, price: entryPrice(obs, readPrices(baseDir)) });
}

export function recordJourney(baseDir: string, event: JourneyEvent): void {
  storeLive(baseDir, event);
}

type Fact = UsageObservation | JourneyEvent;
function insertLive(db: DatabaseSync, fact: Fact) {
  if (fact.workspaceId !== undefined)
    db.prepare("INSERT OR IGNORE INTO usage_workspace(source,session,workspace) VALUES(?,?,?)").run(
      fact.source,
      fact.sessionId,
      fact.workspaceId,
    );
  const table = "kind" in fact ? "journey" : "observations";
  db.prepare(`INSERT OR IGNORE INTO ${table} VALUES(?,?,?,?)`).run(
    fact.source,
    fact.sessionId,
    fact.id,
    JSON.stringify(fact),
  );
}

// A lengthy external writer lock must neither stall a turn nor lose its only receipt.
function storeLive(baseDir: string, fact: Fact) {
  try {
    withLedger(baseDir, (db) => insertLive(db, fact));
  } catch {
    try {
      writeAtomicJson(join(baseDir, ".agent-team", "usage-pending", `${randomUUID()}.json`), fact);
    } catch {
      console.warn("[usage] Could not persist native fact or its recovery record");
    }
  }
}

function recover(baseDir: string, db: DatabaseSync) {
  const dir = join(baseDir, ".agent-team", "usage-pending");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const file = join(dir, name);
    const fact = JSON.parse(readFileSync(file, "utf8")) as Fact;
    insertLive(db, fact);
    // INSERT OR IGNORE also makes a crash between commit and unlink replay-safe.
    unlinkSync(file);
  }
}

/** Collector maintenance: replay pending writes and reconcile the configured receipts. */
export function maintainUsageLedger(baseDir: string): void {
  const prices = readPrices(baseDir);
  withLedger(baseDir, (db) => {
    recover(baseDir, db);
    if (!prices.receipts.length) return;
    const reconcile = db.prepare(`INSERT INTO receipts VALUES(?,?,?,?,?)
      ON CONFLICT(source,session,id) DO UPDATE SET dated=excluded.dated,usd=excluded.usd
      WHERE dated < excluded.dated OR (dated = excluded.dated AND usd <> excluded.usd)`);
    db.exec("BEGIN IMMEDIATE");
    for (const receipt of prices.receipts)
      reconcile.run(receipt.source, receipt.sessionId, receipt.id, receipt.asOf, receipt.usd);
    db.exec("COMMIT");
  });
}

/** Keep a consistent snapshot without doing collector maintenance on every page. */
export function withUsageSnapshot<T>(baseDir: string, work: (db: DatabaseSync) => T): T {
  return withLedger(baseDir, (db) => {
    db.exec("BEGIN");
    const result = work(db);
    db.exec("COMMIT");
    return result;
  });
}

export function observationFromRow(row: {
  fact: SQLOutputValue;
  dated: SQLOutputValue;
  usd: SQLOutputValue;
}): UsageObservation {
  const obs = JSON.parse(String(row.fact)) as UsageObservation;
  // The estimate stays in the ledger, but the payable amount is only the matched receipt.
  const price: UsagePrice =
    row.dated === null
      ? obs.price
      : { kind: "reported", usd: Number(row.usd), asOf: String(row.dated) };
  return { ...obs, price };
}
