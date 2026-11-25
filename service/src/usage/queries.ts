import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import type {
  JourneyEvent,
  UsageFilters,
  UsageJourney,
  UsageOverview,
} from "../../../shared/usage";
import { readWorkspaceMetadata } from "../workspace/state";
import { observationFromRow, withUsageSnapshot } from "./ledger";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
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
  where.push("u.timestamp >= ?");
  args.push(q.since);
  if (after) {
    // Within one table, isEvent is constant; include equality only on the other side of the tie.
    const op = !event && after[4] === 1 ? "<=" : "<";
    where.push(`(${journeyKey}) ${op} (?,?,?,?)`);
    args.push(after[0], after[1], after[2], after[3]);
  }
  const match = (expression: string, value: string | undefined) => {
    if (value === undefined) return;
    where.push(`${expression} = ?`);
    args.push(value);
  };
  const contains = (value: string | undefined, ...expressions: string[]) => {
    if (value === undefined) return;
    where.push(`(${expressions.join(" OR ")})`);
    args.push(...expressions.map(() => value.toLowerCase()));
  };
  if (!event) {
    match("u.unit", q.unit);
    contains(q.model, "usage_contains(json_extract(u.fact,'$.model'), ?)");
    contains(q.channel, "usage_contains(json_extract(u.fact,'$.channel'), ?)");
  }
  match("u.source", q.source);
  contains(
    q.session,
    "usage_contains(u.session, ?)",
    "usage_contains(json_extract(u.fact,'$.piSessionId'), ?)",
  );
  match("json_extract(u.fact,'$.turnId')", q.turn);
  contains(
    q.workspace,
    `usage_workspace_matches(${factWorkspace}, ?)`,
    `EXISTS (
    SELECT 1 FROM usage_workspace w WHERE ${workspaceBinding} AND usage_workspace_matches(w.workspace, ?)
  )`,
  );
  return { where, args };
}

// SQLite can use the chronological index or the narrower session/time index.
const observations = "observations AS u";
const events = "journey AS u";
const receipts = "LEFT JOIN receipts AS r USING(source,session,id)";
const factWorkspace = "json_extract(u.fact,'$.workspaceId')";
const workspaceBinding = "w.source=u.source AND w.session=u.session";

function registerFilters(db: DatabaseSync, workspaceNames: ReadonlyMap<string, string>) {
  const contains = (value: SQLOutputValue, needle: SQLOutputValue) =>
    typeof value === "string" && value.toLowerCase().includes(String(needle));
  db.function("usage_contains", { deterministic: true }, (value, needle) =>
    Number(contains(value, needle)),
  );
  db.function("usage_workspace_matches", { deterministic: true }, (id, needle) =>
    Number(
      contains(id, needle) ||
        (typeof id === "string" && contains(workspaceNames.get(id) ?? null, needle)),
    ),
  );
}

function readWorkspaceNames(baseDir: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const { id, name } of readWorkspaceMetadata(baseDir)) {
    if (typeof name === "string" && name) names.set(id, name);
  }
  return names;
}

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
  const workspaceNames = q.workspace === undefined ? new Map() : readWorkspaceNames(baseDir);
  return withUsageSnapshot(baseDir, (db) => {
    registerFilters(db, workspaceNames);
    db.function("usage_model_family", { deterministic: true }, (value) =>
      typeof value === "string"
        ? value.replace(/-(minimal|low|medium|high|xhigh|max)$/i, "")
        : null,
    );
    const modelFamily = "usage_model_family(json_extract(u.fact,'$.model'))";
    const bucketMs = q.granularity === "hour" ? HOUR : DAY;
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
    const ranking = db
      .prepare(
        `
      SELECT ${modelFamily} AS model, total(${prompt} + ${output}) AS tokens
      FROM ${observations} ${selection} GROUP BY model ORDER BY tokens DESC, model LIMIT 6
    `,
      )
      .all(...args)
      .map((row) => ({
        model: row.model === null ? null : String(row.model),
        tokens: Number(row.tokens),
      }));
    const families = new Set(ranking.map(({ model }) => model));
    const buckets = new Map<number, UsageOverview["trend"][number]>();
    const grouped = db.prepare(`
      SELECT floor(u.timestamp / ${bucketMs}) * ${bucketMs} AS bucket, ${modelFamily} AS model, ${sums}
      FROM ${observations} ${selection} GROUP BY bucket,model ORDER BY bucket,model
    `);
    for (const row of grouped.iterate(...args)) {
      const start = Number(row.bucket);
      let bucket = buckets.get(start);
      if (!bucket) {
        const iso = new Date(start).toISOString();
        bucket = {
          day: q.granularity === "hour" ? iso.replace(".000Z", "Z") : iso.split("T")[0],
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          models: [],
          other: 0,
        };
        buckets.set(start, bucket);
      }
      const model = row.model === null ? null : String(row.model);
      let tokens = 0;
      for (const key of ["input", "cacheRead", "cacheWrite", "output"] as const) {
        const n = Number(row[key]);
        bucket[key] += n;
        tokens += n;
      }
      if (families.has(model)) bucket.models.push({ model, tokens });
      else bucket.other += tokens;
    }
    const trend = [...buckets.values()];
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

const journeyColumns = ["timestamp", "source", "session", "id"];
const journeyKey = journeyColumns.map((column) => `u.${column}`).join(",");
const journeyOrder = [...journeyColumns, "isEvent"].map((column) => `${column} DESC`).join(",");
const cursorKey = z.tuple([
  z.number(), // timestamp
  z.string(), // source
  z.string(), // session
  z.string(), // id
  z.union([z.literal(0), z.literal(1)]), // event sorts before an observation of the same identity
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

export function journey(
  baseDir: string,
  q: UsageFilters,
  cursor?: string,
  requestedPage = 1,
): UsageJourney {
  validateWindow(q);
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  const workspaceNames = readWorkspaceNames(baseDir);
  return withUsageSnapshot(baseDir, (db) => {
    registerFilters(db, workspaceNames);
    // Events have no unit, model, or channel. Never infer a model/channel from nearby observations.
    const branches: (0 | 1)[] = q.model === undefined && q.channel === undefined ? [0, 1] : [0];
    const count = (key?: z.infer<typeof cursorKey>) =>
      branches.reduce<number>((n, isEvent) => {
        const { where, args } = filter(q, Boolean(isEvent), key);
        return (
          n +
          Number(
            db
              .prepare(
                `SELECT count(*) AS count
        FROM ${isEvent ? events : observations} WHERE ${where.join(" AND ")}`,
              )
              .get(...args)!.count,
          )
        );
      }, 0);
    const total = count();
    const ahead = after ? total - count(after) : 0;
    const page = Math.max(
      1,
      Math.min(
        Math.ceil(total / PAGE_SIZE),
        after ? Math.floor(ahead / PAGE_SIZE) + 1 : requestedPage,
      ),
    );
    const offset = after ? 0 : (page - 1) * PAGE_SIZE;
    const args: (number | string)[] = [];
    const scans = branches.map((isEvent) => {
      const scope = filter(q, Boolean(isEvent), after);
      args.push(...scope.args);
      return `SELECT * FROM (
        SELECT ${journeyKey}, u.fact, ${isEvent} AS isEvent, ${isEvent ? "NULL AS dated, NULL AS usd" : "r.dated,r.usd"}
        FROM ${isEvent ? events : `${observations} ${receipts}`}
        WHERE ${scope.where.join(" AND ")}
        ORDER BY ${journeyOrder} LIMIT ${offset + PAGE_SIZE + 1}
      )`;
    });
    const rows = db
      .prepare(
        `
      SELECT u.*, coalesce(${factWorkspace}, (SELECT min(w.workspace) FROM usage_workspace w
        WHERE ${workspaceBinding} HAVING count(*) = 1)) AS workspaceId
      FROM (${scans.join(" UNION ALL ")}
        ORDER BY ${journeyOrder} LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}) AS u
      ORDER BY ${journeyOrder}
    `,
      )
      .all(...args);
    const visible = rows.slice(0, PAGE_SIZE);
    const last = visible.at(-1);
    return {
      total,
      page,
      pageSize: PAGE_SIZE,
      rows: visible.map(({ isEvent, fact, dated, usd, workspaceId }) => {
        const row = isEvent
          ? (JSON.parse(String(fact)) as JourneyEvent)
          : observationFromRow({ fact, dated, usd });
        if (typeof workspaceId !== "string") return row;
        const workspaceName = workspaceNames.get(workspaceId);
        return { ...row, workspaceId, ...(workspaceName === undefined ? {} : { workspaceName }) };
      }),
      nextCursor:
        last && rows.length > PAGE_SIZE
          ? Buffer.from(
              JSON.stringify([last.timestamp, last.source, last.session, last.id, last.isEvent]),
            ).toString("base64url")
          : null,
    };
  });
}
