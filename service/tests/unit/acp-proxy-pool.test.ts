import { once } from "node:events";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import tls from "node:tls";
import { afterEach, expect, it } from "vitest";
import { UpstreamPool } from "../../src/acp-proxy/pool";

// Public test credentials for loopback servers only.
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgxLwv+mMoar7etZz1
yyxvGGV7UNvJs+h7YJGgepoxNcKhRANCAARAJCsGqbqfYxOeq6EwYlpAzYQwKcY4
TMbVSBcBVydVZwhJXeEZ8e4HvtCvPPVdeikb5BQyYchqbl99W7cDpHiA
-----END PRIVATE KEY-----
`;
const cert = `-----BEGIN CERTIFICATE-----
MIIBmDCCAT+gAwIBAgIUDSxi06uCDso4rfQgesK4cJYaq5swCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTIwMDEwMTAwMDAwMFoXDTQwMDEwMTAw
MDAwMFowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEQCQrBqm6n2MTnquhMGJaQM2EMCnGOEzG1UgXAVcnVWcISV3hGfHuB77Q
rzz1XXopG+QUMmHIam5ffVu3A6R4gKNvMG0wHQYDVR0OBBYEFGREKrtxBTLkfRtc
BijhiArFapQJMB8GA1UdIwQYMBaAFGREKrtxBTLkfRtcBijhiArFapQJMA8GA1Ud
EwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAoGCCqGSM49
BAMCA0cAMEQCIDKrXAGENYGDSb4PJUQHLAwITS71Db5qcFmCL3VCKAsgAiAj6PYH
JAQ8pt9jK/wxfxzCbCCt73PGTGJzOXlHlRVPQg==
-----END CERTIFICATE-----
`;

const credentials = { key, cert };
const empty = Buffer.alloc(0);
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
});

async function listen(server: net.Server, protocol = "https") {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `${protocol}://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function makePool(upstreamUrl: string, pingIntervalMs = 1000, pingTimeoutMs = 1000) {
  const pool = new UpstreamPool({ upstreamUrl, ca: cert, pingIntervalMs, pingTimeoutMs });
  cleanup.push(() => pool.close());
  return pool;
}

function get(pool: UpstreamPool, path = "/", signal = new AbortController().signal) {
  return pool.request("GET", path, {}, empty, signal);
}

function frame(type: number, flags: number, streamId = 0, payload = empty): Buffer {
  const header = Buffer.alloc(9);
  header.writeUIntBE(payload.length, 0, 3);
  header[3] = type;
  header[4] = flags;
  header.writeUInt32BE(streamId, 5);
  return Buffer.concat([header, payload]);
}

// Minimal wire peer for behavior Node's normal server API can't produce: suppress
// automatic PING ACKs or send RST_STREAM without first ending the response.
function rawH2(socket: tls.TLSSocket, onFrame: (type: number, streamId: number) => void) {
  socket.on("error", () => {});
  socket.write(frame(4, 0)); // SETTINGS
  let input = empty;
  let seenPreface = false;
  socket.on("data", (chunk: Buffer) => {
    input = Buffer.concat([input, chunk]);
    if (!seenPreface) {
      if (input.length < 24) return;
      seenPreface = true;
      input = input.subarray(24);
    }
    while (input.length >= 9) {
      const size = input.readUIntBE(0, 3) + 9;
      if (input.length < size) break;
      const type = input[3];
      if (type === 4 && input[4] === 0) socket.write(frame(4, 1)); // SETTINGS ACK
      onFrame(type, input.readUInt32BE(5));
      input = input.subarray(size);
    }
  });
}

it("pools concurrent HTTP/2 streams and waits for response headers, not the response body", async () => {
  const server = http2.createSecureServer({
    ...credentials,
    settings: { maxConcurrentStreams: 2 },
  });
  let sessions = 0;
  const streams: http2.ServerHttp2Stream[] = [];
  server.on("session", () => sessions++);
  server.on("stream", (stream: http2.ServerHttp2Stream) => {
    stream.on("error", () => {});
    streams.push(stream);
    stream.respond({ ":status": 201, "x-origin": "loopback" });
  });
  const pool = makePool(await listen(server));
  const results = await Promise.all([get(pool, "/first"), get(pool, "/second")]);
  expect(sessions).toBe(1);
  expect(pool.activeH2Sessions).toBe(1);
  expect(results.map(({ connReused }) => connReused)).toEqual([false, true]);
  expect(results[0]).toMatchObject({
    status: 201,
    headers: { "x-origin": "loopback" },
    httpProto: "h2",
  });
  expect(typeof results[0].tlsHandshakeMs).toBe("number");
  expect(results[0].headers).not.toHaveProperty(":status");
  expect(results[1].tlsHandshakeMs).toBeNull();

  const third = await get(pool, "/third");
  expect(sessions).toBe(2);
  expect(third.connReused).toBe(false);
  for (const stream of streams) stream.end("done");
  expect(await Promise.all([...results, third].map(({ stream }) => text(stream)))).toEqual([
    "done",
    "done",
    "done",
  ]);
  const reused = await get(pool);
  streams.at(-1)!.end("reused");
  expect(reused.connReused).toBe(true);
  expect(await text(reused.stream)).toBe("reused");
});

it("evicts an active HTTP/2 session on PING timeout and negotiates a healthy replacement", async () => {
  const healthy = http2.createServer();
  healthy.on("stream", (stream: http2.ServerHttp2Stream) => {
    stream.respond({ ":status": 200 });
    stream.end("healthy");
  });
  let connections = 0;
  let pings = 0;
  const front = tls.createServer({ ...credentials, ALPNProtocols: ["h2"] }, (socket) => {
    if (++connections > 1) {
      healthy.emit("connection", socket);
      return;
    }
    // The peer ignores PING while a request is awaiting headers.
    rawH2(socket, (type) => {
      if (type === 6) pings++;
    });
  });
  const pool = makePool(await listen(front), 30, 200);
  await expect(get(pool)).rejects.toMatchObject({ code: "ping_timeout" });
  expect(pings).toBe(1);
  expect(pool.activeH2Sessions).toBe(0);
  expect(pool.lastPingRttMs).toBeNull();
  const result = await get(pool);
  expect(await text(result.stream)).toBe("healthy");
  expect(result.connReused).toBe(false);
  expect(pool.activeH2Sessions).toBe(1);
  await expect.poll(() => pool.lastPingRttMs).toEqual(expect.any(Number));
});

it("falls back to a keep-alive HTTPS connection after TLS ALPN selects HTTP/1.1", async () => {
  const server = https.createServer({ ...credentials, ALPNProtocols: ["http/1.1"] }, (req, res) => {
    res.setHeader("connection", "keep-alive, x-local-response");
    res.setHeader("x-local-response", "hidden");
    res.setHeader("x-origin", "loopback");
    void text(req).then(
      (body) => res.end(JSON.stringify({ headers: req.headers, body })),
      () => res.destroy(),
    );
  });
  const selections: Array<string | false | null> = [];
  server.on("secureConnection", (socket) => selections.push(socket.alpnProtocol));
  const url = await listen(server);
  const pool = makePool(url);
  const result = await pool.request(
    "POST",
    "/echo",
    {
      Host: "not-the-upstream.invalid",
      Connection: "keep-alive, X-Local-Request",
      "x-local-request": "hidden",
      "x-forwarded": "retained",
      "transfer-encoding": "chunked",
      ":path": "/wrong",
    },
    Readable.from(["stream", "ed"]),
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    status: 200,
    httpProto: "http/1.1",
    connReused: false,
  });
  expect(typeof result.tlsHandshakeMs).toBe("number");
  expect(result.headers).toMatchObject({ "x-origin": "loopback" });
  expect(result.headers).not.toHaveProperty("connection");
  expect(result.headers).not.toHaveProperty("x-local-response");
  expect(result.headers).not.toHaveProperty("transfer-encoding");
  const received = JSON.parse(await text(result.stream)) as {
    body: string;
    headers: http.IncomingHttpHeaders;
  };
  expect(received.body).toBe("streamed");
  expect(received.headers).toMatchObject({ host: new URL(url).host, "x-forwarded": "retained" });
  expect(received.headers).not.toHaveProperty("x-local-request");
  const next = await get(pool);
  expect(next).toMatchObject({ connReused: true, tlsHandshakeMs: null });
  await text(next.stream);
  expect(selections).toEqual(["http/1.1"]);
  expect(pool.activeH2Sessions).toBe(0);
});

it("supports plaintext HTTP and cancels its response after headers", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200).flushHeaders();
  });
  const pool = makePool(await listen(server, "http"));
  const controller = new AbortController();
  const response = await get(pool, "/", controller.signal);
  expect(response).toMatchObject({ httpProto: "http/1.1", tlsHandshakeMs: null });
  const consuming = text(response.stream);
  controller.abort();
  await expect(consuming).rejects.toMatchObject({ code: "ABORT_ERR" });
});

it("sends an HTTP/2 CANCEL on abort after headers", async () => {
  let lastStream: http2.ServerHttp2Stream;
  const server = http2.createSecureServer(credentials);
  server.on("stream", (stream: http2.ServerHttp2Stream) => {
    lastStream = stream;
    stream.on("error", () => {});
    stream.respond({ ":status": 200 });
  });
  const pool = makePool(await listen(server));
  const controller = new AbortController();
  const aborted = await get(pool, "/", controller.signal);
  const serverClose = once(lastStream!, "close");
  const consuming = text(aborted.stream);
  controller.abort();
  await expect(consuming).rejects.toMatchObject({ code: "ABORT_ERR" });
  await serverClose;
  expect(lastStream!.rstCode).toBe(http2.constants.NGHTTP2_CANCEL);
});

it("reports a peer HTTP/2 CANCEL reset after headers instead of a successful EOF", async () => {
  let reset!: () => void;
  const server = tls.createServer({ ...credentials, ALPNProtocols: ["h2"] }, (socket) => {
    rawH2(socket, (type, streamId) => {
      if (type !== 1) return;
      // HEADERS + END_HEADERS; static HPACK index 8 is :status 200.
      socket.write(frame(1, 4, streamId, Buffer.from([0x88])));
      reset = () => socket.write(frame(3, 0, streamId, Buffer.from([0, 0, 0, 8])));
    });
  });
  const pool = makePool(await listen(server));
  const response = await get(pool);
  reset();
  await expect(text(response.stream)).rejects.toMatchObject({ code: "ERR_HTTP2_STREAM_ERROR" });
});

it("destroys pending TLS sockets on close and rejects outstanding and future requests", async () => {
  const server = net.createServer((socket) => socket.resume());
  const pool = makePool(await listen(server));
  const connected = once(server, "connection");
  const result = get(pool);
  const settled = expect(result).rejects.toMatchObject({ code: "ERR_UPSTREAM_POOL_CLOSED" });
  const [socket] = (await connected) as [net.Socket];
  const socketClosed = once(socket, "close");
  pool.close();
  await settled;
  await socketClosed;
  await expect(get(pool)).rejects.toMatchObject({ code: "ERR_UPSTREAM_POOL_CLOSED" });
});

it("streams a GET upload over HTTP/2 and uses the configured authority", async () => {
  const server = http2.createSecureServer(credentials, (req, res) => {
    void text(req).then(
      (body) => res.end(`${req.headers[":authority"] ?? ""}:${req.url}:${body}`),
      () => res.destroy(),
    );
  });
  const url = await listen(server);
  const pool = makePool(url);
  const result = await pool.request(
    "GET",
    "/stream?q=1",
    { host: "discarded.invalid", ":authority": "discarded.invalid" },
    Readable.from(["one", "two"]),
    new AbortController().signal,
  );
  expect(await text(result.stream)).toBe(`${new URL(url).host}:/stream?q=1:onetwo`);
});

it("classifies HTTP/2 GOAWAY for a request the upstream did not accept", async () => {
  const server = tls.createServer({ ...credentials, ALPNProtocols: ["h2"] }, (socket) => {
    rawH2(socket, (type) => {
      if (type === 1) socket.write(frame(7, 0, 0, Buffer.alloc(8))); // Last stream ID 0, NO_ERROR.
    });
  });
  const pool = makePool(await listen(server));
  await expect(get(pool)).rejects.toMatchObject({ code: "h2_goaway" });
  expect(pool.activeH2Sessions).toBe(0);
});
