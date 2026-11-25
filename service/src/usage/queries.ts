import { z } from "zod";
import type {
  JourneyEvent,
  UsageFilters,
  UsageJourney,
  UsageOverview,
} from "../../../shared/usage";
import { observationFromRow, withUsageSnapshot } from "./ledger";

const DAY = 86_400_000;
const PAGE_SIZE = 30;

function validateWindow({ since, until }: UsageFilters) {
  if (
    ![since, until].every(
      (value) => Number.isFinite(value) && Number.isFinite(new Date(value).getTime()),
    ) ||
    since >= until ||
    until - since > 90 * DAY
  )
    throw new RangeError("Usage window must be positive and at most 90 days");
}

function filter(q: UsageFilters, event = false, after?: z.infer<typeof cursorKey>) {
  // A NULL timestamp has no position in a dated view and is excluded by the range.
  const where = ["u.timestamp < ?"];
  const args: (number | string)[] = [q.until];
  if (after && after[0] >= q.since) {
    // Replacing rather than supplementing `since` lets SQLite seek the full index key.
    const op = event && after[4] === 0 ? ">=" : ">";
    where.push(`(${journeyKey}) ${op} (?,?,?,?)`);
    args.push(after[0], after[1], after[2], after[3]);
  } else {
    where.push("u.timestamp >= ?");
    args.push(q.since);
  }
  const match = (expression: string, value: string | undefined) => {
    if (value === undefined) return;
    where.push(`${expression} = ?`);
    args.push(value);
  };
  if (!event) {
    match("u.unit", q.unit);
    match("json_extract(u.fact,'$.model')", q.model);
    match("json_extract(u.fact,'$.channel')", q.channel);
  }
  match("u.source", q.source);
  match("u.session", q.session);
  match("json_extract(u.fact,'$.turnId')", q.turn);
  if (q.workspace !== undefined) {
    where.push(`EXISTS (SELECT 1 FROM usage_workspace w
      WHERE w.source=u.source AND w.session=u.session AND w.workspace=?)`);
    args.push(q.workspace);
  }
  return { where, args };
}

// SQLite can use the chronological index or the narrower session/time index.
const observations = "observations AS u";
const events = "journey AS u";
const receipts = "LEFT JOIN receipts AS r USING(source,session,id)";
const input = "json_extract(u.fact,'$.input')";
const cacheRead = "json_extract(u.fact,'$.cacheRead')";
const cacheWrite = "json_extract(u.fact,'$.cacheWrite')";
const output = "json_extract(u.fact,'$.output')";
const prompt = `(${input} + ${cacheRead} + ${cacheWrite})`;
const sums = `total(${input}) AS input, total(${cacheRead}) AS cacheRead,
  total(${cacheWrite}) AS cacheWrite, total(${output}) AS output`;

export function overview(baseDir: string, q: UsageFilters): UsageOverview {
  validateWindow(q);
  const { where, args } = filter(q);
  return withUsageSnapshot(baseDir, (db) => {
    const selection = `WHERE ${where.join(" AND ")}`;
    const totals = db
      .prepare(
        `
      SELECT count(*) AS count, ${sums}, count(*) FILTER (WHERE ${prompt} > 0) AS promptBearing,
        count(*) FILTER (WHERE u.unit='inference' AND ${prompt} > 0) AS eligible,
        count(*) FILTER (WHERE u.unit='inference' AND ${prompt} > 0
          AND ${cacheRead} * 100 >= ${prompt} * 96) AS at96,
        count(*) FILTER (WHERE r.dated IS NULL AND (priceKind='unpriced' OR priceUsd IS NULL)) AS unpriced,
        sum(CASE WHEN r.dated IS NOT NULL THEN r.usd WHEN priceKind='reported' THEN priceUsd END) AS reported,
        sum(priceUsd) FILTER (WHERE r.dated IS NULL AND priceKind='channel-estimate') AS channelEstimate,
        sum(priceUsd) FILTER (WHERE r.dated IS NULL AND priceKind='api-equivalent') AS apiEquivalent
      FROM (
        SELECT u.*, json_extract(u.fact,'$.price.kind') AS priceKind,
          json_extract(u.fact,'$.price.usd') AS priceUsd
        FROM ${observations} ${selection}
      ) AS u ${receipts}
    `,
      )
      .get(...args)!;
    const trend = db
      .prepare(
        `
      SELECT floor(u.timestamp / ${DAY}) AS utcDay, ${sums}
      FROM ${observations} ${selection} GROUP BY utcDay ORDER BY utcDay
    `,
      )
      .all(...args)
      .map((row) => ({
        day: new Date(Number(row.utcDay) * DAY).toISOString().split("T")[0],
        input: Number(row.input),
        cacheRead: Number(row.cacheRead),
        cacheWrite: Number(row.cacheWrite),
        output: Number(row.output),
      }));
    const ranking = db
      .prepare(
        `
      SELECT json_extract(u.fact,'$.model') AS model, total(${prompt} + ${output}) AS tokens
      FROM ${observations} ${selection} GROUP BY model ORDER BY tokens DESC, model LIMIT 6
    `,
      )
      .all(...args)
      .map((row) => ({
        model: row.model === null ? null : String(row.model),
        tokens: Number(row.tokens),
      }));
    const amount = (key: string) => (totals[key] === null ? null : Number(totals[key]));
    return {
      count: Number(totals.count),
      input: Number(totals.input),
      cacheRead: Number(totals.cacheRead),
      cacheWrite: Number(totals.cacheWrite),
      output: Number(totals.output),
      promptBearing: Number(totals.promptBearing),
      eligible: Number(totals.eligible),
      at96: Number(totals.at96),
      unpriced: Number(totals.unpriced),
      costs: {
        reported: amount("reported"),
        "channel-estimate": amount("channelEstimate"),
        "api-equivalent": amount("apiEquivalent"),
      },
      trend,
      ranking,
    };
  });
}

const journeyKey = "u.timestamp,u.source,u.session,u.id";
const cursorKey = z.tuple([
  z.number(), // timestamp
  z.string(), // source
  z.string(), // session
  z.string(), // id
  z.union([z.literal(0), z.literal(1)]), // event sorts after an observation of the same identity
]);

function decodeCursor(cursor: string) {
  try {
    const buf = Buffer.from(cursor, "base64url");
    if (buf.toString("base64url") !== cursor) throw new Error();
    return cursorKey.parse(JSON.parse(buf.toString("utf8")));
  } catch {
    throw new RangeError("Invalid usage Journey cursor");
  }
}

export function journey(baseDir: string, q: UsageFilters, cursor?: string): UsageJourney {
  validateWindow(q);
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  return withUsageSnapshot(baseDir, (db) => {
    const args: (number | string)[] = [];
    const scan = (isEvent: 0 | 1) => {
      const scope = filter(q, Boolean(isEvent), after);
      args.push(...scope.args);
      return `SELECT * FROM (
        SELECT ${journeyKey}, u.fact, ${isEvent} AS isEvent, ${isEvent ? "NULL AS dated, NULL AS usd" : "r.dated,r.usd"}
        FROM ${isEvent ? events : `${observations} ${receipts}`}
        WHERE ${scope.where.join(" AND ")}
        ORDER BY ${journeyKey} LIMIT ${PAGE_SIZE + 1}
      )`;
    };
    const scans = [scan(0)];
    // Events have no unit, model, or channel. Never infer a model/channel from nearby observations.
    if (q.model === undefined && q.channel === undefined) scans.push(scan(1));
    const rows = db
      .prepare(
        `${scans.join(" UNION ALL ")}
      ORDER BY timestamp,source,session,id,isEvent LIMIT ${PAGE_SIZE + 1}`,
      )
      .all(...args);
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      rows: page.map(({ isEvent, fact, dated, usd }) =>
        isEvent
          ? (JSON.parse(String(fact)) as JourneyEvent)
          : observationFromRow({ fact, dated, usd }),
      ),
      nextCursor:
        last && rows.length > PAGE_SIZE
          ? Buffer.from(
              JSON.stringify([last.timestamp, last.source, last.session, last.id, last.isEvent]),
            ).toString("base64url")
          : null,
    };
  });
}
