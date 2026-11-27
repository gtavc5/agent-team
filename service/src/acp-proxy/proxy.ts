import http from "node:http";
import { createHash, randomUUID, randomInt } from "node:crypto";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  ccpaObservation,
  observationCap,
  type CcpaOperation,
  type ObserveRequest,
} from "./limit-evidence";
import { UpstreamPool } from "./pool";
import { ProxyMetrics, type MetricRow, type ProxyHealth } from "./metrics";

export interface CcpaProxyOptions {
  baseDir: string;
  upstreamUrl?: string;
  port?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  maxRetries?: number;
  retryBudgetMs?: number;
  /** Optional private CA for a configured upstream. */
  ca?: string | Buffer;
}
export interface CcpaProxy {
  url: string;
  registerSession(observe: ObserveRequest): { url: string; dispose(): void };
  close(): Promise<void>;
  health(): ProxyHealth;
}

const cap = 32 * 1024 * 1024;
class FailureBudget {
  private entries = new Map<string, { attempts: number; wait: number; until: number }>();
  exhausted(key: string) {
    const item = this.entries.get(key);
    if (item && item.until > performance.now() && (item.attempts >= 2 || item.wait >= 240_000))
      return item;
  }
  fail(key: string, attemptStarted: number, elapsed: number) {
    const now = performance.now();
    const prior = this.entries.get(key);
    // An attempt admitted inside the TTL can itself take longer than the TTL.
    const item = prior && prior.until > attemptStarted ? prior : { attempts: 0, wait: 0, until: 0 };
    item.attempts++;
    item.wait += elapsed;
    item.until = now + 180_000;
    this.entries.delete(key);
    if (this.entries.size >= 512) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, item);
  }
  clear(key: string) {
    this.entries.delete(key);
  }
}

function transportError(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  if (["ping_timeout", "pre_header_eof", "tls_eof", "h2_goaway", "connect_error"].includes(code))
    return code;
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ERR_STREAM_PREMATURE_CLOSE")
    return "pre_header_eof";
  if (code === "ERR_HTTP2_GOAWAY_SESSION") return "h2_goaway";
  if (
    [
      "ERR_HTTP2_ERROR",
      "ERR_HTTP2_STREAM_ERROR",
      "ERR_HTTP2_SESSION_ERROR",
      "ERR_HTTP2_INVALID_SESSION",
      "ERR_HTTP2_STREAM_CANCEL",
      "ERR_HTTP2_INVALID_STREAM",
    ].includes(code)
  )
    return "h2_error";
  if (
    ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "EAI_AGAIN", "ENETUNREACH"].includes(
      code,
    )
  )
    return "connect_error";
  return null;
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

export async function startCcpaProxy(opts: CcpaProxyOptions): Promise<CcpaProxy> {
  const pool = new UpstreamPool({
    upstreamUrl: opts.upstreamUrl ?? "https://daily-cloudcode-pa.googleapis.com",
    pingIntervalMs: opts.pingIntervalMs ?? 25_000,
    pingTimeoutMs: opts.pingTimeoutMs ?? 10_000,
    ca: opts.ca,
  });
  const metrics = new ProxyMetrics(opts.baseDir);
  const health = () => metrics.health(pool.activeH2Sessions, pool.lastPingRttMs);
  const budget = new FailureBudget();
  const routes = new Map<string, ObserveRequest>();
  let observationSlots = 4;
  let reserved = 0;
  const tasks = new Set<Promise<void>>();
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    req.socket.setNoDelay(true);
    let path = req.url ?? "/";
    const prefix = /^\/_yaat\/([a-f0-9-]+)(?=\/)/.exec(path);
    const observer = prefix && routes.get(prefix[1]);
    if (prefix) {
      if (!observer) {
        json(res, 410, { error: "session_retired" });
        return;
      }
      path = path.slice(prefix[0].length);
    }
    if (req.method === "GET" && path === "/__health") {
      json(res, 200, health());
      return;
    }
    if (!path.startsWith("/") || path.startsWith("//")) {
      json(res, 400, { error: "invalid_path" });
      return;
    }
    const method = req.method ?? "GET";
    const start = performance.now();
    // Never persist arbitrary paths or query values; only the CCPA operation is diagnostic.
    const route = /^\/v1internal:[A-Za-z]{1,80}(?=\?|$)/.exec(path)?.[0] ?? "/other";
    const operation = route.slice("/v1internal:".length) as CcpaOperation;
    // Capture the owner at admission, never on response (which could arrive
    // after another turn started, or after the process was replaced).
    const observe =
      observer &&
      method === "POST" &&
      ["streamGenerateContent", "fetchAvailableModels", "retrieveUserQuotaSummary"].includes(
        operation,
      )
        ? observer(operation)
        : undefined;
    const row: MetricRow = {
      ts: new Date().toISOString(),
      reqId: randomUUID(),
      path: route,
      model: "unknown",
      isStream: route.endsWith(":streamGenerateContent"),
      httpProto: null,
      connReused: false,
      tlsHandshakeMs: null,
      ttfbMs: null,
      totalMs: 0,
      statusCode: 0,
      bytesIn: 0,
      bytesOut: 0,
      attempts: 0,
      proxyRetryRecovered: false,
      circuitBreakerTripped: false,
      errorClass: null,
      errorElapsedMs: null,
      pingRttMs: null,
    };
    const control = new AbortController();
    const abort = () => control.abort();
    res.once("close", abort);
    req.once("aborted", abort);
    let observingBody = false;
    let reservation = 0;
    let upload: Readable | undefined;
    try {
      const declared = Number(
        req.headers["content-length"] ?? (req.headers["transfer-encoding"] ? cap : 0),
      );
      // Reserve process-wide before reading. An excess or unknown-size upload can still flow
      // with backpressure and a single attempt, without competing for retry buffer memory.
      const bufferable = declared <= cap && reserved + declared <= 2 * cap;
      if (bufferable) {
        reservation = declared;
        reserved += reservation;
      }
      const it = req.iterator({ destroyOnReturn: false });
      let chunks: Buffer[] = [];
      let complete = false;
      if (bufferable) {
        // Pack fragments into bounded slabs; one Buffer per tiny network read would
        // leave the object count (and retained backing memory) effectively uncapped.
        let slab: Buffer | undefined;
        let offset = 0;
        for (;;) {
          const n = await it.next();
          if (n.done) {
            complete = true;
            break;
          }
          const chunk = n.value as Buffer;
          row.bytesIn += chunk.length;
          for (let i = 0; i < chunk.length;) {
            if (!slab || offset === slab.length) {
              slab = Buffer.allocUnsafe(Math.min(declared || 1, 64 * 1024));
              chunks.push(slab);
              offset = 0;
            }
            const count = chunk.copy(slab, offset, i);
            offset += count;
            i += count;
          }
          if (row.bytesIn > cap) break;
        }
        if (slab && offset < slab.length) chunks[chunks.length - 1] = slab.subarray(0, offset);
      }
      let body: Buffer | Readable;
      let key: string | undefined;
      if (complete) {
        body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, row.bytesIn);
        chunks = [];
        key = createHash("sha256")
          .update(method)
          .update("\0")
          .update(path)
          .update("\0")
          .update(body)
          .digest("hex");
        // JSON decoding multiplies peak heap usage. Fingerprint larger uploads without parsing.
        if (body.length && body.length <= 1024 * 1024) {
          try {
            const payload: unknown = JSON.parse(body.toString());
            const model =
              payload && typeof payload === "object" && "model" in payload && payload.model;
            if (typeof model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(model))
              row.model = model;
          } catch {
            /* Opaque request bodies are valid. */
          }
        }
      } else {
        upload = Readable.from(
          (async function* () {
            yield* chunks;
            chunks = [];
            for (;;) {
              const n = await it.next();
              if (n.done) return;
              const chunk = n.value as Buffer;
              row.bytesIn += chunk.length;
              yield chunk;
            }
          })(),
          { objectMode: false },
        );
        body = upload;
      }
      const retryBudget = opts.retryBudgetMs ?? 200_000;
      for (;;) {
        control.signal.throwIfAborted();
        const exhausted = key && budget.exhausted(key);
        if (exhausted) {
          row.circuitBreakerTripped = true;
          row.errorClass = "circuit_breaker";
          row.statusCode = 503;
          json(res, 503, {
            error: row.errorClass,
            model: row.model,
            attempts: exhausted.attempts,
            elapsedWaitMs: exhausted.wait,
          });
          return;
        }
        row.attempts++;
        const attempt = performance.now();
        let reply;
        try {
          reply = await pool.request(method, path, req.headers, body, control.signal);
        } catch (e) {
          control.signal.throwIfAborted();
          const kind = transportError(e);
          row.errorClass = kind ?? "upstream_error";
          row.errorElapsedMs = Math.round(performance.now() - attempt);
          if (kind && key) {
            budget.fail(key, attempt, row.errorElapsedMs);
            const backoff = randomInt(1500, 3001);
            if (
              row.attempts === 1 &&
              (opts.maxRetries ?? 1) > 0 &&
              !budget.exhausted(key) &&
              performance.now() - start + backoff < retryBudget
            ) {
              await delay(backoff, undefined, { signal: control.signal });
              if (performance.now() - start < retryBudget) continue;
            }
          }
          row.statusCode = 502;
          json(res, 502, { error: row.errorClass });
          return;
        }
        row.ttfbMs = Math.round(performance.now() - start);
        row.statusCode = reply.status;
        row.httpProto = reply.httpProto;
        row.connReused = reply.connReused;
        row.tlsHandshakeMs = reply.tlsHandshakeMs;
        if (reply.status >= 200 && reply.status < 300 && key) budget.clear(key);
        row.errorClass = null;
        res.writeHead(reply.status, reply.headers);
        res.flushHeaders();
        let sample: Buffer[] | undefined;
        if (
          observe &&
          observationSlots > 0 &&
          (row.isStream ? reply.status === 429 : reply.status === 200)
        ) {
          observationSlots--;
          observingBody = true;
          sample = [];
        }
        for await (const chunk of reply.stream as AsyncIterable<Buffer>) {
          row.bytesOut += chunk.length;
          if (sample && row.bytesOut <= observationCap) sample.push(chunk);
          else sample = undefined;
          if (!res.write(chunk)) await once(res, "drain", { signal: control.signal });
        }
        if (observe)
          observe(
            ccpaObservation(
              operation,
              row.model,
              reply.status,
              reply.headers,
              sample && Buffer.concat(sample),
            ),
          );
        res.end();
        row.proxyRetryRecovered = row.attempts > 1 && reply.status >= 200 && reply.status < 300;
        return;
      }
    } catch {
      row.errorClass = control.signal.aborted
        ? "client_abort"
        : res.headersSent
          ? "mid_stream_eof"
          : "proxy_error";
      row.errorElapsedMs = Math.round(performance.now() - start);
      if (!res.headersSent && !res.destroyed) {
        row.statusCode = 502;
        json(res, 502, { error: row.errorClass });
      } else res.destroy();
    } finally {
      abort();
      upload?.destroy();
      req.resume();
      res.off("close", abort);
      req.off("aborted", abort);
      if (observingBody) observationSlots++;
      reserved -= reservation;
      row.totalMs = Math.round(performance.now() - start);
      row.pingRttMs = pool.lastPingRttMs;
      metrics.record(row);
    }
  };
  const server = http.createServer((req, res) => {
    const task = handle(req, res);
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => {
        tasks.delete(task);
        res.destroy();
      },
    );
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.listen(opts.port ?? 0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback TCP listener");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    registerSession(observe) {
      const key = randomUUID();
      routes.set(key, observe);
      return {
        url: `${url}/_yaat/${key}`,
        dispose: () => {
          routes.delete(key);
        },
      };
    },
    health,
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      pool.close();
      await closed;
      await Promise.allSettled(tasks);
      await metrics.close();
    },
  };
}
