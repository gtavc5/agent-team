import type { UsageObservation, JourneyEvent } from "../../shared/usage";
import { maintainUsageLedger, observationFromRow, withUsageSnapshot } from "../src/usage/ledger";

// Fixture assertions inspect an entire scratch ledger, including undated facts.
export function queryUsage(baseDir: string): UsageObservation[] {
  maintainUsageLedger(baseDir);
  return withUsageSnapshot(baseDir, (db) =>
    db
      .prepare(
        "SELECT fact, dated, usd FROM observations LEFT JOIN receipts USING(source,session,id) ORDER BY observations.rowid",
      )
      .all()
      .map(({ fact, dated, usd }) => observationFromRow({ fact, dated, usd })),
  );
}

export function queryJourney(baseDir: string): JourneyEvent[] {
  maintainUsageLedger(baseDir);
  return withUsageSnapshot(baseDir, (db) =>
    db
      .prepare("SELECT fact FROM journey ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row.fact)) as JourneyEvent),
  );
}
