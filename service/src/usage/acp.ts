import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_SIZE = 100;
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;

export type AcpUsageSource = Readonly<{ piSessionId: string; acpSessionId: string }>;

export type AcpUsageDiscovery =
  | { status: "ok"; sources: AcpUsageSource[] }
  | { status: "missing" | "unavailable" | "invalid-registry" };

export interface AcpUsageRow {
  idx: number;
  modelId: string | null;
  timestampMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export type AcpUsagePage =
  | {
      status: "ok";
      rows: AcpUsageRow[];
      nextAfterIdx: number;
      hasMore: boolean;
      skippedRows: number;
    }
  | { status: "missing" | "unavailable" | "invalid-source" | "invalid-query" };

// The reader accepts only bindings returned by discovery; paths never leave this module.
const sourcePaths = new WeakMap<AcpUsageSource, string>();

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function readRegistry(path: string): AcpUsageDiscovery | unknown[] {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_REGISTRY_BYTES) return { status: "invalid-registry" };
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length !== stat.size) return { status: "invalid-registry" };
      try {
        const registry: unknown = JSON.parse(bytes.toString("utf8", 0, length));
        return Array.isArray(registry) ? registry : { status: "invalid-registry" };
      } catch {
        return { status: "invalid-registry" };
      }
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return { status: isMissing(error) ? "missing" : "unavailable" };
  }
}

/** Discover native databases only through the controlled Pi home's explicit session bindings. */
export function discoverAcpUsageSources(options: {
  piSessionIds: Iterable<string>;
  dataDir?: string;
  homeDir?: string;
}): AcpUsageDiscovery {
  const allowed = new Set(options.piSessionIds);
  if (!allowed.size) return { status: "ok", sources: [] };
  const home = options.homeDir ?? homedir();
  const dataDir = options.dataDir ?? process.env.AGENT_TEAM_BASE_DIR ?? join(home, ".yaat");
  const registry = readRegistry(
    join(dataDir, "pi-agent-home/antigravity-acp-provider/sessions.json"),
  );
  if (!Array.isArray(registry)) return registry;

  const bindings = new Map<string, string>();
  const ambiguousPi = new Set<string>();
  const acpOwners = new Map<string, string>();
  const ambiguousAcp = new Set<string>();
  for (const entry of registry) {
    if (!entry || typeof entry !== "object") continue;
    const { piSessionId, acpSessionId } = entry as Record<string, unknown>;
    if (typeof piSessionId !== "string" || !UUID.test(piSessionId)) continue;
    if (typeof acpSessionId !== "string" || !UUID.test(acpSessionId)) continue;
    const previous = bindings.get(piSessionId);
    if (previous && previous !== acpSessionId) ambiguousPi.add(piSessionId);
    bindings.set(piSessionId, acpSessionId);
    const canonicalAcp = acpSessionId.toLowerCase();
    const owner = acpOwners.get(canonicalAcp);
    if (owner && owner !== piSessionId) ambiguousAcp.add(canonicalAcp);
    acpOwners.set(canonicalAcp, piSessionId);
  }

  const sources: AcpUsageSource[] = [];
  for (const piSessionId of allowed) {
    const acpSessionId = bindings.get(piSessionId);
    if (
      !acpSessionId ||
      ambiguousPi.has(piSessionId) ||
      ambiguousAcp.has(acpSessionId.toLowerCase())
    ) {
      continue;
    }
    const source = Object.freeze({ piSessionId, acpSessionId });
    sourcePaths.set(
      source,
      resolve(home, ".gemini/antigravity-acp/conversations", `${acpSessionId}.db`),
    );
    sources.push(source);
  }
  return { status: "ok", sources };
}

type Field = bigint | Uint8Array;

function fields(bytes: Uint8Array, wanted: readonly number[]): Map<number, Field> {
  const result = new Map<number, Field>();
  let offset = 0;
  function varint(): bigint {
    let value = 0n;
    for (let shift = 0n; shift <= 63n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) break;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("Invalid protobuf varint");
  }
  while (offset < bytes.length) {
    const tag = varint();
    if (tag < 8n || tag > 0xffff_ffffn) throw new Error("Invalid protobuf tag");
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    const selected = wanted.includes(field);
    let value: Field | undefined;
    if (wire === 0) {
      value = varint();
    } else if (wire === 2) {
      const length = varint();
      if (length > BigInt(bytes.length - offset)) throw new Error("Invalid protobuf length");
      const end = offset + Number(length);
      if (selected) value = bytes.subarray(offset, end);
      offset = end;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error("Truncated protobuf field");
    } else {
      throw new Error("Unsupported protobuf wire type");
    }
    if (selected) {
      if (value === undefined || result.has(field)) throw new Error("Invalid selected field");
      result.set(field, value);
    }
  }
  return result;
}

function bytes(field: Field | undefined): Uint8Array {
  if (!(field instanceof Uint8Array)) throw new Error("Expected protobuf bytes");
  return field;
}

function counter(field: Field | undefined): number {
  if (field === undefined) return 0; // Protobuf omits zero-valued scalars.
  if (typeof field !== "bigint" || field > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid protobuf counter");
  }
  return Number(field);
}

// The embedded ACP descriptor identifies the storage and envelope fields.
// Sanitized Neon gen_metadata fixtures confirm the numeric projection:
// usage fields 9/10 subdivide field 3, not extra tokens.
function decodeRow(idx: number, data: Uint8Array): AcpUsageRow {
  const chat = fields(bytes(fields(data, [1]).get(1)), [4, 9, 21]);
  const usage = fields(bytes(chat.get(4)), [2, 3, 4, 5]);
  const timing = chat.has(9) && fields(bytes(chat.get(9)), [4]).get(4);
  const stamp = timing ? fields(bytes(timing), [1, 2]) : new Map<number, Field>();
  const model = chat.get(21);
  const label =
    model instanceof Uint8Array && model.length <= 128 ? Buffer.from(model).toString("utf8") : "";
  const modelId = MODEL_ID.test(label) ? label : null;
  const seconds = counter(stamp.get(1));
  const nanos = counter(stamp.get(2));
  const timestampMs = seconds * 1000 + Math.floor(nanos / 1_000_000);
  return {
    idx,
    modelId,
    timestampMs:
      stamp.has(1) && nanos < 1_000_000_000 && timestampMs <= 8.64e15 ? timestampMs : null,
    inputTokens: counter(usage.get(2)),
    outputTokens: counter(usage.get(3)),
    cacheWriteTokens: counter(usage.get(4)),
    cacheReadTokens: counter(usage.get(5)),
  };
}

/** Read a bounded page in idx order. The cursor advances past non-decodable rows. */
export function readAcpUsage(
  source: AcpUsageSource,
  options: { afterIdx?: number; limit?: number } = {},
): AcpUsagePage {
  const path = sourcePaths.get(source);
  if (!path) return { status: "invalid-source" };
  const { afterIdx = -1, limit = MAX_PAGE_SIZE } = options;
  if (
    !Number.isSafeInteger(afterIdx) ||
    afterIdx < -1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE_SIZE
  ) {
    return { status: "invalid-query" };
  }

  try {
    if (!lstatSync(path).isFile()) return { status: "unavailable" };
    using db = new DatabaseSync(path, { readOnly: true });
    const query = db.prepare(`
      SELECT idx, CASE
        WHEN typeof(data) = 'blob' AND length(data) = size AND size <= ? THEN data
      END AS data
      FROM gen_metadata WHERE idx > ? ORDER BY idx LIMIT ?
    `);
    const rows: AcpUsageRow[] = [];
    let skippedRows = 0;
    let nextAfterIdx = afterIdx;
    let hasMore = false;
    for (const { idx, data } of query.iterate(MAX_METADATA_BYTES, afterIdx, limit + 1)) {
      if (rows.length + skippedRows === limit) {
        hasMore = true;
        break;
      }
      if (typeof idx !== "number" || !Number.isSafeInteger(idx)) return { status: "unavailable" };
      nextAfterIdx = idx;
      try {
        rows.push(decodeRow(idx, bytes(data instanceof Uint8Array ? data : undefined)));
      } catch {
        skippedRows++;
      }
    }
    return { status: "ok", rows, nextAfterIdx, hasMore, skippedRows };
  } catch (error) {
    return { status: isMissing(error) ? "missing" : "unavailable" };
  }
}
