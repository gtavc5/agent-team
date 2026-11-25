import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncAcp } from "../../src/usage/sync";
import { queryUsage } from "../usage-fixtures";
import { withLedger } from "../../src/usage/ledger";
import { journey, overview } from "../../src/usage/queries";
import { discoverAcpUsageSources, readAcpUsage } from "../../src/usage/acp";

const piId = "00000000-0000-0000-0000-000000000001";
const otherPi = "00000000-0000-0000-0000-000000000002";
const acpId = "26e2c834-0000-0000-0000-000000000001";
const otherAcp = "be7d71fc-0000-0000-0000-000000000002";
const model = "gemini-4-neon-high";
const sensitive = "private-transcript-placeholder";

function varint(value: number | bigint): Buffer {
  const bytes = [];
  let remaining = BigInt(value);
  do {
    bytes.push(Number(remaining & 0x7fn) | (remaining > 127n ? 128 : 0));
    remaining >>= 7n;
  } while (remaining);
  return Buffer.from(bytes);
}

function scalar(field: number, value: number | bigint): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function nested(field: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([varint(field * 8 + 2), varint(body.length), body]);
}

// Reconstructed from diagnostic fields only; no native database or transcript is copied.
function metadata(seconds: number, nanos: number, ...usage: Buffer[]): Buffer {
  return nested(
    1,
    nested(1, Buffer.from(sensitive)),
    nested(4, ...usage),
    nested(9, nested(4, scalar(1, seconds), scalar(2, nanos))),
    nested(21, Buffer.from(model)),
  );
}

let home: string;
let registry: string;
let conversations: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaat-acp-usage-"));
  vi.stubEnv("AGENT_TEAM_BASE_DIR", undefined);
  registry = join(home, ".yaat/pi-agent-home/antigravity-acp-provider/sessions.json");
  conversations = join(home, ".gemini/antigravity-acp/conversations");
  mkdirSync(dirname(registry), { recursive: true });
  mkdirSync(conversations, { recursive: true });
  writeRegistry([
    { piSessionId: piId, acpSessionId: acpId, acpModelId: "stale-model", cwd: sensitive },
    { piSessionId: otherPi, acpSessionId: otherAcp },
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function writeRegistry(entries: unknown): void {
  writeFileSync(registry, JSON.stringify(entries));
}

function source(id = piId) {
  const discovery = discoverAcpUsageSources({ homeDir: home, piSessionIds: [id] });
  if (discovery.status !== "ok" || discovery.sources.length !== 1)
    throw new Error("Missing source");
  return discovery.sources[0];
}

function createDb(id: string, rows: Array<[number, Buffer, number?]>): string {
  const path = join(conversations, `${id}.db`);
  using db = new DatabaseSync(path);
  db.exec(`CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER);
           CREATE TABLE transcript (text TEXT); INSERT INTO transcript VALUES ('${sensitive}');`);
  const insert = db.prepare("INSERT INTO gen_metadata VALUES (?, ?, ?)");
  for (const [idx, blob, size = blob.length] of rows) insert.run(idx, blob, size);
  return path;
}

describe("discoverAcpUsageSources", () => {
  it("exposes only allowlisted Pi bindings, not registry content or unbound databases", () => {
    writeFileSync(join(conversations, "unbound.db"), sensitive);
    expect(discoverAcpUsageSources({ homeDir: home, piSessionIds: [piId, "unbound"] })).toEqual({
      status: "ok",
      sources: [{ piSessionId: piId, acpSessionId: acpId }],
    });
    expect(readAcpUsage({ ...source() })).toEqual({ status: "invalid-source" });
  });

  it("rejects traversal and bindings ambiguous across Pi sessions", () => {
    writeRegistry([
      { piSessionId: piId, acpSessionId: "../../secret" },
      { piSessionId: otherPi, acpSessionId: otherAcp },
      { piSessionId: "00000000-0000-0000-0000-000000000003", acpSessionId: otherAcp },
    ]);
    expect(discoverAcpUsageSources({ homeDir: home, piSessionIds: [piId, otherPi] })).toEqual({
      status: "ok",
      sources: [],
    });
  });

  it("supports the YAAT base directory and fails closed on missing, malformed, or huge registries", () => {
    vi.stubEnv("AGENT_TEAM_BASE_DIR", join(home, ".yaat"));
    const discover = () => discoverAcpUsageSources({ homeDir: home, piSessionIds: [piId] });
    expect(discover().status).toBe("ok");
    writeFileSync(registry, sensitive);
    expect(discover()).toEqual({ status: "invalid-registry" });
    writeFileSync(registry, Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(discover()).toEqual({ status: "invalid-registry" });
    rmSync(registry);
    expect(discover()).toEqual({ status: "missing" });
    expect(discoverAcpUsageSources({ homeDir: home, piSessionIds: [] })).toEqual({
      status: "ok",
      sources: [],
    });
  });
});

describe("readAcpUsage", () => {
  it("reopens the same unpriced observations after syncing both native databases twice", () => {
    const base = join(home, ".yaat");
    const sessions = join(base, "pi-sessions", "ws-sample");
    mkdirSync(sessions, { recursive: true });
    for (const id of [piId, otherPi]) writeFileSync(join(sessions, `sample_${id}.jsonl`), "");
    createDb(acpId, [[1, metadata(1795572937, 358159062, scalar(2, 75065), scalar(3, 323))]]);
    createDb(otherAcp, [
      [70, metadata(1795578754, 153589659, scalar(2, 23325), scalar(3, 207), scalar(5, 143166))],
    ]);
    expect(syncAcp(base, home)).toBe(0);
    const rows = queryUsage(base);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "1",
          source: "acp",
          input: 75065,
          cacheRead: 0,
          price: { kind: "unpriced", usd: null },
        }),
        expect.objectContaining({
          id: "70",
          source: "acp",
          input: 23325,
          cacheRead: 143166,
          price: { kind: "unpriced", usd: null },
        }),
      ]),
    );
    const bindings = () =>
      withLedger(base, (db) => db.prepare("SELECT * FROM usage_workspace").all());
    expect(bindings()).toEqual([]);
    writeFileSync(
      join(sessions, `sample_${piId}.jsonl`),
      JSON.stringify({ type: "session", version: 3, id: piId }) + "\n",
    );
    expect(syncAcp(base, home)).toBe(0);
    expect(queryUsage(base)).toEqual(rows);
    expect(bindings()).toEqual([{ source: "acp", session: acpId, workspace: "ws-sample" }]);
    const q = { since: 1795572937358, until: 1795578754154, unit: "inference", model } as const;
    expect(overview(base, q)).toMatchObject({
      count: 2,
      eligible: 2,
      at96: 0,
      unpriced: 2,
      input: 98390,
      cacheRead: 143166,
      cacheWrite: 0,
      output: 530,
      ranking: [{ model, tokens: 242086 }],
    });
    expect(journey(base, q)).toEqual({
      rows: [rows.find((row) => row.id === "1"), rows.find((row) => row.id === "70")],
      nextCursor: null,
    });
    expect(overview(base, { ...q, workspace: "ws-sample" }).count).toBe(1);
  });

  it("keeps usage with unknown generation time and model", () => {
    createDb(acpId, [[1, nested(1, nested(4, scalar(2, 10)))]]);
    expect(readAcpUsage(source())).toMatchObject({
      rows: [{ inputTokens: 10, timestampMs: null, modelId: null }],
    });
  });
  it("projects 26e2c834 idx 1 Neon counters without adding output breakdown or returning text", () => {
    const path = createDb(acpId, [
      [
        1,
        metadata(
          1795572937,
          358159062,
          scalar(2, 75065),
          scalar(3, 323),
          scalar(9, 93),
          scalar(10, 230),
        ),
      ],
    ]);
    const before = readFileSync(path);
    expect(readAcpUsage(source())).toEqual({
      status: "ok",
      rows: [
        {
          idx: 1,
          modelId: model,
          timestampMs: 1795572937358,
          inputTokens: 75065,
          outputTokens: 323,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
        },
      ],
      nextAfterIdx: 1,
      hasMore: false,
      skippedRows: 0,
    });
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("projects be7d71fc idx 70 Neon cached tokens from field 5", () => {
    createDb(otherAcp, [
      [
        70,
        metadata(
          1795578754,
          153589659,
          scalar(2, 23325),
          scalar(3, 207),
          scalar(5, 143166),
          scalar(9, 111),
          scalar(10, 96),
        ),
      ],
    ]);
    expect(readAcpUsage(source(otherPi), { afterIdx: 69 })).toEqual({
      status: "ok",
      rows: [
        {
          idx: 70,
          modelId: model,
          timestampMs: 1795578754153,
          inputTokens: 23325,
          outputTokens: 207,
          cacheWriteTokens: 0,
          cacheReadTokens: 143166,
        },
      ],
      nextAfterIdx: 70,
      hasMore: false,
      skippedRows: 0,
    });
  });

  it("pages from idx zero, advancing over malformed, mismatched, or oversized rows", () => {
    createDb(acpId, [
      [8, Buffer.alloc(4 * 1024 * 1024 + 1)],
      [0, metadata(1, 0, scalar(4, 27))],
      [2, Buffer.from([10, 4, 2])],
      [3, metadata(1, 0, scalar(3, 1n << 53n))],
      [5, metadata(1, 0), 1],
      [10, metadata(2, 0, scalar(2, 4))],
    ]);
    const binding = source();
    expect(readAcpUsage(binding, { limit: 5 })).toEqual({
      status: "ok",
      rows: [
        {
          idx: 0,
          modelId: model,
          timestampMs: 1000,
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 27,
          cacheReadTokens: 0,
        },
      ],
      nextAfterIdx: 8,
      hasMore: true,
      skippedRows: 4,
    });
    expect(readAcpUsage(binding, { afterIdx: 8, limit: 1 })).toMatchObject({
      status: "ok",
      rows: [{ idx: 10 }],
      nextAfterIdx: 10,
      hasMore: false,
      skippedRows: 0,
    });
    expect(readAcpUsage(binding, { afterIdx: 10 })).toEqual({
      status: "ok",
      rows: [],
      nextAfterIdx: 10,
      hasMore: false,
      skippedRows: 0,
    });
  });

  it("reports redacted errors without opening missing, symlinked, or invalid databases", () => {
    const binding = source();
    expect(readAcpUsage(binding, { limit: 101 })).toEqual({ status: "invalid-query" });
    expect(readAcpUsage(binding, { afterIdx: NaN })).toEqual({ status: "invalid-query" });
    expect(readAcpUsage(binding)).toEqual({ status: "missing" });
    const target = createDb(otherAcp, []);
    const path = join(conversations, `${acpId}.db`);
    symlinkSync(target, path);
    expect(readAcpUsage(binding)).toEqual({ status: "unavailable" });
    rmSync(path);
    writeFileSync(path, sensitive);
    expect(readAcpUsage(binding)).toEqual({ status: "unavailable" });
  });
});
