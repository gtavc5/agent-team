import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { isIP, type Socket } from "node:net";
import { PassThrough, Readable } from "node:stream";
import tls from "node:tls";

interface UpstreamPoolOptions {
  upstreamUrl: string;
  pingIntervalMs: number;
  pingTimeoutMs: number;
  ca?: string | Buffer;
}

interface UpstreamResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: Readable;
  httpProto: string;
  connReused: boolean;
  tlsHandshakeMs: number | null;
}

interface H2Connection {
  session: http2.ClientHttp2Session;
  limit: number;
  active: number;
  used: boolean;
  ready: boolean;
  goaway?: { code: number; lastStreamId: number };
  tlsHandshakeMs: number;
}

const keepAliveMs = 15_000;
const setupTimeoutMs = 10_000;

const hopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function cleanHeaders(
  headers: http.IncomingHttpHeaders,
  outgoing = false,
): http.IncomingHttpHeaders {
  const blocked = new Set(hopHeaders);
  if (outgoing) blocked.add("host");
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "connection") continue;
    for (const token of [value].flat().join(",").split(","))
      blocked.add(token.trim().toLowerCase());
  }
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .filter(
        ([name, value]) => value !== undefined && !name.startsWith(":") && !blocked.has(name),
      ),
  );
}

function upstreamError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function classify(error: unknown): NodeJS.ErrnoException {
  if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string")
    return error;
  return upstreamError(
    "ERR_UPSTREAM_REQUEST",
    error instanceof Error ? error.message : String(error),
  );
}

function disconnected(): NodeJS.ErrnoException {
  return upstreamError("ECONNRESET", "Upstream connection closed before the response completed");
}

function configureSocket<T extends Socket>(socket: T): T {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, keepAliveMs);
  return socket;
}

function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(classify(signal.reason));
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function writeBody(body: Buffer | Readable, request: http.ClientRequest | http2.ClientHttp2Stream) {
  if (Buffer.isBuffer(body)) {
    request.end(body);
    return () => {};
  }
  body.pipe(request);
  return () => {
    body.unpipe(request);
    if (!body.readableEnded) body.destroy();
  };
}

export class UpstreamPool {
  private readonly url: URL;
  private readonly shutdown = new AbortController();
  private readonly pendingSockets = new Set<tls.TLSSocket>();
  private readonly h2Connections = new Set<H2Connection>();
  private readonly handshakeTimes = new WeakMap<Socket, number>();
  private h1Agent?: http.Agent;
  private opening?: Promise<void>;
  private pingRtt: number | null = null;

  constructor(private readonly opts: UpstreamPoolOptions) {
    this.url = new URL(opts.upstreamUrl);
    if (this.url.protocol === "http:")
      this.h1Agent = new http.Agent({ keepAlive: true, keepAliveMsecs: keepAliveMs });
    else if (this.url.protocol !== "https:")
      throw upstreamError("ERR_INVALID_PROTOCOL", "Expected an HTTP(S) upstream");
  }

  get activeH2Sessions(): number {
    return [...this.h2Connections].filter(
      ({ session, goaway, ready }) => ready && !goaway && !session.closed && !session.destroyed,
    ).length;
  }

  get lastPingRttMs(): number | null {
    return this.pingRtt;
  }

  close(): void {
    if (this.shutdown.signal.aborted) return;
    const error = upstreamError("ERR_UPSTREAM_POOL_CLOSED", "Upstream pool is closed");
    this.shutdown.abort(error);
    for (const socket of this.pendingSockets) socket.destroy();
    for (const { session } of this.h2Connections) session.destroy(error);
    this.h1Agent?.destroy();
  }

  async request(
    method: string,
    path: string,
    headers: http.IncomingHttpHeaders,
    body: Buffer | Readable,
    signal: AbortSignal,
  ): Promise<UpstreamResponse> {
    const cancellation = new AbortController();
    const abortRequest = () =>
      cancellation.abort(upstreamError("ABORT_ERR", "Upstream request was aborted"));
    if (signal.aborted) abortRequest();
    else signal.addEventListener("abort", abortRequest, { once: true });
    const upload = body instanceof Readable ? body : undefined;
    const abortUpload = (error: Error) => cancellation.abort(classify(error));
    upload?.on("error", abortUpload);
    const combined = AbortSignal.any([this.shutdown.signal, cancellation.signal]);
    const cleanup = () => {
      signal.removeEventListener("abort", abortRequest);
      upload?.removeListener("error", abortUpload);
    };
    try {
      const forwarded = cleanHeaders(headers, true);
      for (;;) {
        combined.throwIfAborted();
        if (this.h1Agent)
          return await this.requestH1(method, path, forwarded, body, combined, cleanup);
        for (const connection of this.h2Connections) {
          const { session, goaway, limit, active } = connection;
          if (!goaway && !session.closed && !session.destroyed && active < limit) {
            return await this.requestH2(
              connection,
              method,
              path,
              forwarded,
              body,
              combined,
              cleanup,
            );
          }
        }
        this.opening ??= this.openTls().finally(() => {
          this.opening = undefined;
        });
        await untilAbort(this.opening, combined);
      }
    } catch (error) {
      cleanup();
      if (body instanceof Readable && !body.readableEnded) body.destroy();
      throw classify(error);
    }
  }

  private async openTls(): Promise<void> {
    const host = this.url.hostname.replace(/^\[|\]$/g, "");
    const started = performance.now();
    const socket = configureSocket(
      tls.connect({
        host,
        port: Number(this.url.port || 443),
        servername: isIP(host) ? undefined : host,
        ca: this.opts.ca,
        ALPNProtocols: ["h2", "http/1.1"],
      }),
    );
    this.pendingSockets.add(socket);
    socket.once("close", () => this.pendingSockets.delete(socket));
    // The negotiated H1 socket can be idle before the first request takes ownership.
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => socket.destroy(upstreamError("ETIMEDOUT", "Upstream TLS handshake timed out")),
        setupTimeoutMs,
      ).unref();
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("secureConnect", connected);
        socket.off("error", failed);
        socket.off("close", closed);
      };
      const connected = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const closed = () => failed(disconnected());
      socket.once("secureConnect", connected).once("error", failed).once("close", closed);
    });
    this.shutdown.signal.throwIfAborted();
    const elapsed = performance.now() - started;
    if (socket.alpnProtocol !== "h2") {
      this.useHttps(socket, elapsed);
      return;
    }

    const session = http2.connect(this.url.origin, { createConnection: () => socket });
    this.pendingSockets.delete(socket);
    const connection: H2Connection = {
      session,
      limit: 0,
      active: 0,
      used: false,
      ready: false,
      tlsHandshakeMs: elapsed,
    };
    this.h2Connections.add(connection);
    await new Promise<void>((resolve, reject) => {
      let stopPing: (() => void) | undefined;
      const timeout = setTimeout(
        () =>
          session.destroy(
            upstreamError("ETIMEDOUT", "Upstream HTTP/2 SETTINGS negotiation timed out"),
          ),
        setupTimeoutMs,
      ).unref();
      session.on("remoteSettings", (settings: http2.Settings) => {
        stopPing ??= this.startPing(session);
        connection.limit = settings.maxConcurrentStreams ?? Infinity;
        connection.ready = true;
        if (connection.limit > 0) {
          clearTimeout(timeout);
          resolve();
        }
      });
      session.on("goaway", (code: number, lastStreamId: number) => {
        connection.goaway = { code, lastStreamId };
        clearTimeout(timeout);
        stopPing?.();
        reject(upstreamError("h2_goaway", "Upstream HTTP/2 session received GOAWAY"));
      });
      session.on("error", reject);
      session.once("close", () => {
        clearTimeout(timeout);
        stopPing?.();
        this.h2Connections.delete(connection);
        reject(disconnected());
      });
    });
  }

  private useHttps(socket: tls.TLSSocket, elapsed: number): void {
    this.handshakeTimes.set(socket, elapsed);
    const agent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: keepAliveMs,
      ca: this.opts.ca,
      ALPNProtocols: ["http/1.1"],
    });
    const dial = agent.createConnection.bind(agent);
    let firstSocket: tls.TLSSocket | undefined = socket;
    agent.createConnection = (options, callback) => {
      const seed = firstSocket;
      firstSocket = undefined;
      if (seed && this.pendingSockets.delete(seed) && !seed.destroyed) return seed;
      const started = performance.now();
      const next = dial(options, callback);
      if (next instanceof tls.TLSSocket) {
        const timeout = setTimeout(
          () => next.destroy(upstreamError("ETIMEDOUT", "Upstream TLS handshake timed out")),
          setupTimeoutMs,
        ).unref();
        next.once("close", () => clearTimeout(timeout));
        next.once("secureConnect", () => {
          clearTimeout(timeout);
          this.handshakeTimes.set(next, performance.now() - started);
        });
      }
      return next;
    };
    this.h1Agent = agent;
  }

  private startPing(session: http2.ClientHttp2Session): () => void {
    let timeout: NodeJS.Timeout | undefined;
    const interval = setInterval(() => {
      if (timeout || session.closed || session.destroyed) return;
      timeout = setTimeout(() => {
        session.destroy(upstreamError("ping_timeout", "Upstream HTTP/2 PING timed out"));
      }, this.opts.pingTimeoutMs).unref();
      session.ping((error, duration) => {
        clearTimeout(timeout);
        timeout = undefined;
        if (!error) this.pingRtt = duration;
        else if (!session.closed && !session.destroyed) session.destroy(error);
      });
    }, this.opts.pingIntervalMs).unref();
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }

  private requestH2(
    connection: H2Connection,
    method: string,
    path: string,
    headers: http.IncomingHttpHeaders,
    body: Buffer | Readable,
    signal: AbortSignal,
    cleanup: () => void,
  ): Promise<UpstreamResponse> {
    return new Promise((resolve, reject) => {
      const stream = connection.session.request(
        {
          ...headers,
          ":method": method,
          ":path": path,
          ":authority": this.url.host,
        },
        { endStream: false },
      );
      const connReused = connection.used;
      connection.active++;
      connection.used = true;
      let responseBody: PassThrough | undefined;
      const abort = () => {
        const error = classify(signal.reason);
        responseBody?.destroy(error);
        if (!stream.destroyed) {
          stream.close(http2.constants.NGHTTP2_CANCEL);
          stream.destroy(error);
        }
      };
      const detach = () => {
        if (stream.closed && (!responseBody || responseBody.closed)) {
          signal.removeEventListener("abort", abort);
          cleanup();
        }
      };
      const fail = (cause: Error) => {
        const { goaway } = connection;
        const error = signal.aborted
          ? classify(signal.reason)
          : goaway &&
              (goaway.code !== http2.constants.NGHTTP2_NO_ERROR ||
                (stream.id ?? Infinity) > goaway.lastStreamId)
            ? upstreamError("h2_goaway", "Upstream HTTP/2 session rejected the stream with GOAWAY")
            : cause;
        reject(error);
        responseBody?.destroy(error);
      };
      const reset = () =>
        upstreamError("ERR_HTTP2_STREAM_ERROR", `Upstream HTTP/2 stream reset (${stream.rstCode})`);
      stream.once("error", fail);
      stream.once("close", () => {
        connection.active--;
        detach();
        stopUpload();
        if (stream.rstCode !== http2.constants.NGHTTP2_NO_ERROR) fail(reset());
        else if (!responseBody || !stream.readableEnded) fail(disconnected());
      });
      stream.once("response", (response) => {
        const readable = new PassThrough();
        responseBody = readable;
        readable.on("error", () => {});
        readable.once("close", () => {
          detach();
          if (!readable.readableEnded && !stream.closed)
            stream.close(http2.constants.NGHTTP2_CANCEL);
        });
        // Node does not emit an error for a peer RST_STREAM with CANCEL.
        stream.once("end", () => {
          if (stream.rstCode !== http2.constants.NGHTTP2_NO_ERROR) fail(reset());
          else readable.end();
        });
        stream.pipe(readable, { end: false });
        resolve({
          status: Number(response[":status"]),
          headers: cleanHeaders(response),
          stream: readable,
          httpProto: "h2",
          connReused,
          tlsHandshakeMs: connReused ? null : connection.tlsHandshakeMs,
        });
      });
      signal.addEventListener("abort", abort, { once: true });
      const stopUpload = writeBody(body, stream);
    });
  }

  private requestH1(
    method: string,
    path: string,
    headers: http.IncomingHttpHeaders,
    body: Buffer | Readable,
    signal: AbortSignal,
    cleanup: () => void,
  ): Promise<UpstreamResponse> {
    return new Promise((resolve, reject) => {
      if (headers["content-length"] === undefined) {
        if (!Buffer.isBuffer(body)) headers["transfer-encoding"] = "chunked";
        else if (body.length > 0) headers["content-length"] = String(body.length);
      }
      const transport = this.url.protocol === "https:" ? https : http;
      const request = transport.request(this.url.origin, {
        method,
        path,
        headers,
        agent: this.h1Agent,
      });
      let response: http.IncomingMessage | undefined;
      const abort = () => {
        const error = classify(signal.reason);
        response?.destroy(error);
        request.destroy(error);
      };
      const finish = () => {
        signal.removeEventListener("abort", abort);
        cleanup();
        stopUpload();
      };
      request.once("socket", configureSocket);
      request.once("error", reject);
      request.once("close", () => {
        if (!response) finish();
        reject(disconnected());
      });
      request.once("response", (incoming) => {
        response = incoming;
        incoming.on("error", () => {});
        incoming.once("close", () => {
          finish();
          if (!request.writableEnded) request.destroy();
        });
        resolve({
          status: incoming.statusCode!,
          headers: cleanHeaders(incoming.headers),
          stream: incoming,
          httpProto: `http/${incoming.httpVersion}`,
          connReused: request.reusedSocket,
          tlsHandshakeMs: request.reusedSocket
            ? null
            : (this.handshakeTimes.get(request.socket!) ?? null),
        });
      });
      signal.addEventListener("abort", abort, { once: true });
      const stopUpload = writeBody(body, request);
    });
  }
}
