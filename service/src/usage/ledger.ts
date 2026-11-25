import { chmodSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../storage/atomic-write";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    if (!db.prepare("PRAGMA user_version").get()?.user_version)
      db.exec(`PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS observations (
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
    ); PRAGMA user_version=1; COMMIT;`);
    return work(db);
  } finally {
    db.close();
  }
}

export function insertObservation(db: DatabaseSync, obs: UsageObservation, prices: Prices): void {
  if (
    ![obs.input, obs.cacheRead, obs.cacheWrite, obs.output].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    return;
  const fact = { ...obs, price: entryPrice(obs, prices) };
  db.prepare("INSERT OR IGNORE INTO observations VALUES (?, ?, ?, ?)").run(
    obs.source,
    obs.sessionId,
    obs.id,
    JSON.stringify(fact),
  );
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

export function queryJourney(baseDir: string): JourneyEvent[] {
  return withLedger(baseDir, (db) => {
    recover(baseDir, db);
    return db
      .prepare("SELECT fact FROM journey ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row.fact)) as JourneyEvent);
  });
}

export function queryUsage(baseDir: string): UsageObservation[] {
  const prices = readPrices(baseDir);
  return withLedger(baseDir, (db) => {
    recover(baseDir, db);
    const reconcile = db.prepare(
      `INSERT INTO receipts VALUES(?,?,?,?,?) ON CONFLICT(source,session,id) DO UPDATE SET dated=excluded.dated,usd=excluded.usd WHERE dated <= excluded.dated`,
    );
    for (const receipt of prices.receipts)
      reconcile.run(receipt.source, receipt.sessionId, receipt.id, receipt.asOf, receipt.usd);
    return db
      .prepare(
        `SELECT fact, dated, usd FROM observations LEFT JOIN receipts USING(source,session,id) ORDER BY observations.rowid`,
      )
      .all()
      .map((row) => {
        const obs = JSON.parse(String(row.fact)) as UsageObservation;
        // The estimate stays in the ledger, but the payable amount is only the matched receipt.
        const price: UsagePrice =
          row.dated === null
            ? obs.price
            : { kind: "reported", usd: Number(row.usd), asOf: String(row.dated) };
        return { ...obs, price };
      });
  });
}
