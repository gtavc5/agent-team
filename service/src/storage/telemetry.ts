import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  TELEMETRY_ACTIONS,
  TELEMETRY_BATCH_MAX,
  TELEMETRY_LAYOUTS,
  TELEMETRY_OUTCOMES,
  type TelemetryBatch,
} from "../../../shared/telemetry";
import type { TelemetryConfig } from "../config/config";

const DAY = 86_400_000;
const PRUNE_INTERVAL = 3600_000;
// Tolerate ordinary clock skew without letting future-dated rows evade retention.
const MAX_CLOCK_SKEW = 5 * 60_000;
export const telemetryBatchSchema = z.strictObject({
  tab_run_id: z.string().regex(/^[a-f0-9]{32}$/),
  events: z
    .array(
      z.strictObject({
        ts: z.number().int().min(0).max(8_640_000_000_000_000),
        layout: z.enum(TELEMETRY_LAYOUTS),
        action: z.enum(TELEMETRY_ACTIONS),
        outcome: z.enum(TELEMETRY_OUTCOMES),
      }),
    )
    .min(1)
    .max(TELEMETRY_BATCH_MAX),
});

export class TelemetryStore {
  private file: string;
  private db?: DatabaseSync;
  private timer?: ReturnType<typeof setInterval>;
  private config: TelemetryConfig = { enabled: false, retention_days: 30 };

  constructor(dataDir: string, config: TelemetryConfig) {
    this.file = join(dataDir, "telemetry.db");
    this.configure(config);
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  configure(config: TelemetryConfig): void {
    if (!config.enabled) this.close();
    this.config = config;
    if (!this.enabled) return;
    this.maintain();
    this.timer ??= setInterval(() => this.maintain(), PRUNE_INTERVAL).unref();
  }

  private open(create: boolean): DatabaseSync | undefined {
    if (!this.enabled) return;
    if (this.db) return this.db;
    if (!create && !existsSync(this.file)) return;
    const db = new DatabaseSync(this.file);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS ui_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          tab_run_id TEXT NOT NULL,
          layout TEXT NOT NULL,
          action TEXT NOT NULL,
          outcome TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ui_events_ts ON ui_events(ts);
      `);
      this.prune(db, Date.now());
      return (this.db = db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private prune(db: DatabaseSync, now: number): void {
    db.prepare("DELETE FROM ui_events WHERE ts < ?").run(now - this.config.retention_days * DAY);
  }

  private maintain(): void {
    try {
      const db = this.open(false);
      if (db) this.prune(db, Date.now());
    } catch {
      console.error("[telemetry] Could not prune UI events");
    }
  }

  append(batch: TelemetryBatch, now = Date.now()): void {
    const db = this.open(true);
    if (!db) return;
    const insert = db.prepare(
      "INSERT INTO ui_events (ts, tab_run_id, layout, action, outcome) VALUES (?, ?, ?, ?, ?)",
    );
    db.exec("BEGIN");
    try {
      for (const { ts, layout, action, outcome } of batch.events) {
        if (ts >= now - this.config.retention_days * DAY && ts <= now + MAX_CLOCK_SKEW)
          insert.run(ts, batch.tab_run_id, layout, action, outcome);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  summary(days: number, now = Date.now()) {
    const cutoff = now - Math.min(days, this.config.retention_days) * DAY;
    const db = this.open(false);
    if (!db) return { enabled: this.enabled, days, counts: [], transitions: [], recentChains: [] };
    const counts = db
      .prepare(
        `
      SELECT layout, action, outcome, count(*) AS count FROM ui_events
      WHERE ts >= ? GROUP BY layout, action, outcome ORDER BY layout, action, outcome
    `,
      )
      .all(cutoff);
    const transitions = db
      .prepare(
        `
      WITH steps AS (
        SELECT layout, action, outcome,
          lag(layout) OVER visit AS from_layout, lag(action) OVER visit AS from_action,
          lag(outcome) OVER visit AS from_outcome, ts - lag(ts) OVER visit AS gap
        FROM ui_events WHERE ts >= ? WINDOW visit AS (PARTITION BY tab_run_id ORDER BY ts, id)
      )
      SELECT from_layout, from_action, from_outcome, layout AS to_layout,
        action AS to_action, outcome AS to_outcome,
        CASE WHEN gap < 2000 THEN '<2s' WHEN gap < 10000 THEN '2-10s' ELSE '10-60s' END AS gap_bucket,
        count(*) AS count
      FROM steps WHERE gap BETWEEN 0 AND 60000
      GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY count DESC, 1, 2, 3, 4, 5, 6, 7 LIMIT 30
    `,
      )
      .all(cutoff);
    // Group a bounded recent sample without exposing the ephemeral tab tokens.
    const recent = db
      .prepare(
        `
      SELECT tab_run_id, ts, layout, action, outcome FROM ui_events
      WHERE ts >= ? ORDER BY ts DESC, id DESC LIMIT 100
    `,
      )
      .all(cutoff);
    const chains = new Map<unknown, Omit<(typeof recent)[number], "tab_run_id">[]>();
    for (const { tab_run_id, ...event } of recent) {
      const chain = chains.get(tab_run_id);
      if (chain) chain.push(event);
      else if (chains.size < 10) chains.set(tab_run_id, [event]);
    }
    return {
      enabled: true,
      days,
      counts,
      transitions,
      recentChains: [...chains.values()].map((chain) => chain.reverse()),
    };
  }

  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.db?.close();
    this.db = undefined;
    this.config = { ...this.config, enabled: false };
  }
}
