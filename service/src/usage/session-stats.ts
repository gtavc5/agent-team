import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { historyFile } from "../workspace/state";
import type { SessionStatsPage, StatsStep, StatsTurn } from "../../../shared/session-stats";
import type { JourneyEvent, UsageObservation } from "../../../shared/usage";
import { withUsageSnapshot } from "./ledger";
import { readLifecycle } from "./lifecycle";

type Fact = JourneyEvent | UsageObservation;
type Marker = ReturnType<typeof readLifecycle>[number];
type Entry = {
  step: StatsStep;
  turn: StatsTurn;
  scope: string;
  at: number | null;
  unplaced: boolean;
};
export type StatsRequest = { workspaceId: string; offset: number; limit: number };

export function statsRequest(workspaceId: string, params: URLSearchParams): StatsRequest {
  const offset = Number(params.get("offset") ?? 0),
    limit = Number(params.get("limit") ?? 20);
  if (
    [...params].some(
      ([k, v]) =>
        !["offset", "limit"].includes(k) || params.getAll(k).length !== 1 || !/^\d+$/.test(v),
    ) ||
    !Number.isSafeInteger(offset) ||
    limit < 1 ||
    limit > 100
  )
    throw new RangeError("Invalid stats page");
  return { workspaceId, offset, limit };
}

// Codex journey rows use a compound ledger key; lifecycle frames use the native item ID.
function eventStepId(event: JourneyEvent): string {
  if (event.source === "codex") {
    try {
      const key: unknown = JSON.parse(event.id);
      if (
        Array.isArray(key) &&
        key.length === 4 &&
        key[0] === "codex" &&
        key[1] === event.sessionId &&
        key[2] === event.turnId &&
        typeof key[3] === "string"
      )
        return key[3];
    } catch {
      /* Unknown historical encoding: keep its opaque identity. */
    }
  }
  return event.id;
}

/** Join by native IDs or an unambiguous match of the exact Pi assistant message. */
export function projectStats(
  markers: Marker[],
  facts: Fact[],
  offset: number,
  limit: number,
): SessionStatsPage {
  const turns = new Map<string, StatsTurn>(),
    entries = new Map<string, Entry>();
  const joins = new Map<string, Entry>();
  const piCompactions = new Map<string, Entry | null>();
  const piMessages = new Map<string, Entry | null>();
  const piMessageCounts = new Map<string, number>();
  const piMessageScope = (f: UsageObservation) => JSON.stringify([f.sessionId, f.piMessageKey]);
  for (const f of facts) {
    if ("unit" in f && f.source === "pi" && f.unit === "inference" && f.piMessageKey) {
      const key = piMessageScope(f);
      piMessageCounts.set(key, (piMessageCounts.get(key) ?? 0) + 1);
    }
  }
  function uniqueJoin(map: Map<string, Entry | null>, key: string, e: Entry) {
    if (map.get(key) !== e) map.set(key, map.has(key) ? null : e);
  }
  function entry(
    turnId: string,
    id: string,
    kind: StatsStep["kind"],
    source: NonNullable<StatsTurn["source"]>,
    sessionId: string | undefined,
    at: number | null,
    unplaced = false,
  ) {
    const scope = JSON.stringify([source, sessionId]);
    const key = JSON.stringify([scope, turnId, id, kind]);
    let result = entries.get(key);
    if (result) return result;
    const turnKey = JSON.stringify([scope, turnId]);
    let turn = turns.get(turnKey);
    if (!turn) {
      turn = {
        key: turnKey,
        source,
        sessionId,
        turnId,
        trigger: unplaced ? "Unattributed history" : "Unknown",
        steps: [],
      };
      turns.set(turnKey, turn);
    }
    result = { step: { stepId: id, kind }, turn, at, scope, unplaced };
    entries.set(key, result);
    return result;
  }
  for (const m of markers) {
    const scope = JSON.stringify([m.source, m.sessionId]);
    const e = entry(m.turnId, m.stepId, m.kind, m.source, m.sessionId, m.at);
    const s = e.step;
    if (m.trigger) {
      s.trigger ??= m.trigger;
      if (e.turn.trigger === "Unknown") e.turn.trigger = m.trigger;
    }
    if (m.marker !== "nativeEntry") s[m.marker] ??= m.at;
    if (m.source === "pi" && m.kind === "compaction") {
      if (m.marker === "compaction") s.compactionObservedAt ??= m.at;
      if (m.piCompactionEntryId)
        uniqueJoin(piCompactions, JSON.stringify([scope, m.piCompactionEntryId]), e);
    }
    if (m.source === "pi" && m.kind === "model" && m.piMessageKey)
      uniqueJoin(piMessages, JSON.stringify([m.sessionId, m.piMessageKey]), e);
    if (m.model) s.model = m.model;
    if (m.promptTokens !== undefined) s.promptTokens = m.promptTokens;
    if (m.inferenceId) {
      s.inferenceId = m.inferenceId;
      if (m.kind === "model") joins.set(JSON.stringify([scope, "model", m.inferenceId]), e);
    }
    if (m.toolCallId) {
      s.toolCallId = m.toolCallId;
      if (m.kind === "tool") joins.set(JSON.stringify([scope, "tool", m.toolCallId]), e);
    }
  }
  for (const f of facts) {
    if ("unit" in f && f.unit !== "inference") continue;
    const scope = JSON.stringify([f.source, f.sessionId]);
    const kind = "kind" in f ? f.kind : "model";
    const turnId = f.turnId ?? `Unattributed · ${f.sessionId}`;
    const id = "kind" in f ? eventStepId(f) : f.id;
    const messageKey =
      "unit" in f && f.source === "pi" && f.piMessageKey ? piMessageScope(f) : undefined;
    const e =
      (kind === "model" ? joins.get(JSON.stringify([scope, kind, f.id])) : undefined) ??
      (messageKey && piMessageCounts.get(messageKey) === 1
        ? piMessages.get(messageKey)
        : undefined) ??
      (kind === "compaction" && f.source === "pi"
        ? piCompactions.get(JSON.stringify([scope, id]))
        : undefined) ??
      entry(turnId, id, kind, f.source, f.sessionId, f.timestamp, !f.turnId);
    if (kind === "compaction" && f.source === "pi" && f.timestamp !== null)
      e.step.compaction = f.timestamp;
    if (kind === "tool" && f.source === "codex" && id !== f.id) e.step.toolCallId = id;
    if ("unit" in f) {
      e.step.inferenceId = f.id;
      e.step.promptTokens = f.input + f.cacheRead + f.cacheWrite;
      if (f.model) e.step.model = f.model;
      for (const call of f.toolCalls ?? []) {
        if (!joins.has(JSON.stringify([scope, "tool", call.id])))
          entry(
            e.turn.turnId,
            call.id,
            "tool",
            f.source,
            f.sessionId,
            e.at,
            e.unplaced,
          ).step.toolCallId = call.id;
      }
    }
  }
  const timeline = [...entries.values()].sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity));
  // An undated receipt or compaction could sit between any two dated samples.
  // Sorting it first for display must not turn an unknown predecessor into a known one.
  const ambiguous = new Set(
    timeline
      .filter((e) => e.at === null && (e.step.kind === "model" || e.step.kind === "compaction"))
      .map((e) => e.scope),
  );
  const ordered = new Set<StatsTurn>();
  const previous = new Map<string, Entry>(),
    compacted = new Set<string>();
  for (const e of timeline) {
    const { step, scope, turn } = e;
    ordered.add(turn);
    turn.steps.push(step);
    if (step.kind === "compaction" && e.at !== null) compacted.add(scope);
    if (step.kind !== "model") continue;
    const p = previous.get(scope);
    if (compacted.delete(scope)) step.boundary = "compaction";
    else if (
      !p ||
      ambiguous.has(scope) ||
      e.unplaced ||
      p.unplaced ||
      e.at === null ||
      p.at === null ||
      !step.model ||
      !p.step.model ||
      step.promptTokens === undefined ||
      p.step.promptTokens === undefined
    )
      step.boundary = "gap";
    else if (step.model !== p.step.model) step.boundary = "model switch";
    else step.promptDelta = step.promptTokens - p.step.promptTokens;
    previous.set(scope, e);
  }
  return {
    turns: [...ordered].reverse().slice(offset, offset + limit),
    total: ordered.size,
    offset,
    limit,
  };
}

export function sessionStats(baseDir: string, { workspaceId, offset, limit }: StatsRequest) {
  const markers = readLifecycle(baseDir, workspaceId);
  const facts = withUsageSnapshot(baseDir, (db) => {
    const result: Fact[] = [];
    for (const table of ["observations", "journey"]) {
      const rows = db
        .prepare(
          `SELECT u.fact FROM usage_workspace w JOIN ${table} u USING(source,session)
        WHERE w.workspace=? AND (json_extract(u.fact,'$.workspaceId')=w.workspace OR
          (json_extract(u.fact,'$.workspaceId') IS NULL AND NOT EXISTS (SELECT 1 FROM usage_workspace other
           WHERE other.source=w.source AND other.session=w.session AND other.workspace<>w.workspace))) ORDER BY u.rowid`,
        )
        .all(workspaceId);
      for (const row of rows) result.push(JSON.parse(String(row.fact)) as Fact);
    }
    return result;
  });
  const page = projectStats(markers, facts, offset, limit);
  if (page.total) return page;
  // Pre-instrumentation transcripts have panel turn IDs but no inference joins.
  // Read only the ID and model, without migrating history or treating reply time as a model clock.
  const file = historyFile(baseDir);
  if (!existsSync(file)) return page;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const query = `FROM messages WHERE session = ? AND kind = 'agent' AND status IN ('done','error') AND json_type(body,'$.turnId')='text'`;
    db.exec("BEGIN");
    const total = Number(
      db
        .prepare(`SELECT count(DISTINCT json_extract(body,'$.turnId')) AS n ${query}`)
        .get(workspaceId)?.n,
    );
    const rows = db
      .prepare(
        `WITH replies AS (SELECT seq,id,json_extract(body,'$.turnId') AS turnId,json_extract(body,'$.model') AS model ${query}),
      page AS (SELECT turnId, min(seq) AS first FROM replies GROUP BY turnId ORDER BY first DESC LIMIT ? OFFSET ?)
      SELECT replies.* FROM page JOIN replies USING(turnId) ORDER BY page.first DESC, replies.seq`,
      )
      .all(workspaceId, limit, offset);
    const turns = new Map<string, StatsTurn>();
    for (const row of rows) {
      const id = String(row.turnId);
      const turn: StatsTurn = turns.get(id) ?? { turnId: id, trigger: "Unknown", steps: [] };
      turn.steps.push({
        stepId: String(row.id),
        kind: "model",
        boundary: "gap",
        ...(typeof row.model === "string" && { model: row.model }),
      });
      turns.set(id, turn);
    }
    return { ...page, total, turns: [...turns.values()] };
  } finally {
    db.close();
  }
}
