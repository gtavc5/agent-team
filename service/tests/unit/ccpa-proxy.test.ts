import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { startCcpaProxy, type CcpaProxyOptions } from "../../src/acp-proxy/proxy";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (clean.length) await clean.pop()!();
});
async function setup(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
  opts: Partial<CcpaProxyOptions> = {},
) {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "yaat-ccpa-"));
  clean.push(() => rm(baseDir, { recursive: true, force: true }));
  const origin = http.createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => res.destroy());
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  clean.push(
    () =>
      new Promise((resolve) => {
        origin.close(resolve);
        origin.closeAllConnections();
      }),
  );
  const addr = origin.address();
  if (!addr || typeof addr === "string") throw Error();
  const proxy = await startCcpaProxy({
    baseDir,
    upstreamUrl: `http://127.0.0.1:${addr.port}`,
    ...opts,
  });
  let open = true;
  const close = async () => {
    if (open) {
      open = false;
      await proxy.close();
    }
  };
  clean.push(close);
  const post = (body = JSON.stringify({ model: "carbon-high", prompt: "secret-prompt" })) =>
    fetch(proxy.url + "/v1internal:generateContent?token=secret-query", {
      method: "POST",
      headers: { authorization: "Bearer secret-auth", cookie: "secret-cookie" },
      body,
    });
  return { proxy, post, close, log: path.join(baseDir, ".agent-team/ccpa-proxy-metrics.jsonl") };
}

it("retries exactly one pre-header reset, forwards the original request, and records only redacted metrics", async () => {
  const seen: { url: string | undefined; body: string; auth: string | undefined }[] = [];
  const { post, proxy, close, log } = await setup(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({
      url: req.url,
      body: Buffer.concat(chunks).toString(),
      auth: req.headers.authorization,
    });
    if (seen.length === 1) req.socket.destroy();
    else res.end("secret-response");
  });
  expect(await (await post()).text()).toBe("secret-response");
  expect(seen).toHaveLength(2);
  expect(seen[0]).toEqual(seen[1]);
  expect(seen[0].url).toContain("?token=secret-query");
  expect(seen[0].auth).toBe("Bearer secret-auth");
  const health: unknown = await (await fetch(proxy.url + "/__health")).json();
  expect(health).toMatchObject({ retryRecoveries: 1, perModel: { "carbon-high": 1 } });
  await close();
  const logText = await readFile(log, "utf8");
  expect(logText + JSON.stringify(health)).not.toMatch(/secret-/);
  expect(JSON.parse(logText.trim())).toMatchObject({
    attempts: 2,
    proxyRetryRecovered: true,
    bytesOut: 15,
  });
  if (process.platform !== "win32") expect((await stat(log)).mode & 0o777).toBe(0o600);
}, 10000);

it("forwards headers and SSE chunks before completion and cancels on client disconnect", async () => {
  const cancelled = latch();
  const { proxy } = await setup((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: live\n\n");
    res.once("close", () => cancelled.resolve());
  });
  const resp = await fetch(proxy.url + "/v1internal:streamGenerateContent?alt=sse");
  const reader = resp.body!.getReader();
  expect(Buffer.from((await reader.read()).value!).toString()).toBe("data: live\n\n");
  await reader.cancel();
  await cancelled.promise;
});

it("never retries after response headers or bytes", async () => {
  let calls = 0;
  const cut = latch();
  const { post, close, log } = await setup(async (_req, res) => {
    calls++;
    res.write("incomplete");
    await cut.promise;
    res.destroy();
  });
  const resp = await post();
  const reader = resp.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  cut.resolve();
  await expect(reader.read()).rejects.toThrow();
  await close();
  expect(calls).toBe(1);
  expect(JSON.parse((await readFile(log, "utf8")).trim())).toMatchObject({
    errorClass: "mid_stream_eof",
    attempts: 1,
  });
});

it.each([400, 401, 403, 429])("passes through HTTP %i without a retry", async (status) => {
  let calls = 0;
  const { post } = await setup((_req, res) => {
    calls++;
    res.writeHead(status);
    res.end("upstream");
  });
  const response = await post();
  expect(response.status).toBe(status);
  expect(await response.text()).toBe("upstream");
  expect(calls).toBe(1);
});

it("clears partial failure budgets on success, then short-circuits repeated failures", async () => {
  let calls = 0;
  const { post } = await setup(
    (req, res) => {
      if (++calls === 2) res.end("ok");
      else req.socket.destroy();
    },
    { maxRetries: 0 },
  );
  for (const status of [502, 200, 502, 502]) {
    const r = await post();
    expect(r.status).toBe(status);
    await r.text();
  }
  const start = performance.now();
  const r = await post();
  expect(r.status).toBe(503);
  expect(await r.json()).toMatchObject({
    error: "circuit_breaker",
    model: "carbon-high",
    attempts: 2,
  });
  expect(performance.now() - start).toBeLessThan(50);
  expect(calls).toBe(4);
});

it("retains a prior failure when a retry outlasts the TTL, and admits traffic again after expiry", async () => {
  let time = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => time);
  try {
    let calls = 0;
    const { post } = await setup(
      (req, res) => {
        if (++calls <= 2) {
          time += calls === 1 ? 10 : 181_000;
          req.socket.destroy();
        } else res.end("ok");
      },
      { maxRetries: 0 },
    );
    for (const expected of [502, 502, 503]) {
      const r = await post();
      expect(r.status).toBe(expected);
      await r.text();
    }
    time += 180_001;
    expect(await (await post()).text()).toBe("ok");
    expect(calls).toBe(3);
  } finally {
    clock.mockRestore();
  }
});

it("charges a single long pre-header wait to the breaker without starting another attempt", async () => {
  let time = 0,
    calls = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => time);
  try {
    const { post } = await setup((req) => {
      calls++;
      time += 241_000;
      req.socket.destroy();
    });
    expect((await post()).status).toBe(502);
    expect(await (await post()).json()).toMatchObject({
      error: "circuit_breaker",
      attempts: 1,
      elapsedWaitMs: 241_000,
    });
    expect(calls).toBe(1);
  } finally {
    clock.mockRestore();
  }
});

it("cancels before headers without retrying or charging the breaker", async () => {
  const received = latch(),
    cancelled = latch();
  const { proxy, close, log } = await setup((_req, res) => {
    res.once("close", cancelled.resolve);
    received.resolve();
  });
  const controller = new AbortController();
  const response = fetch(proxy.url + "/v1internal:generateContent", {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  });
  await received.promise;
  controller.abort();
  await expect(response).rejects.toThrow();
  await cancelled.promise;
  await close();
  expect(JSON.parse((await readFile(log, "utf8")).trim())).toMatchObject({
    attempts: 1,
    errorClass: "client_abort",
    circuitBreakerTripped: false,
  });
});

it("streams uploads over the retry cap before the client finishes sending", async () => {
  const observed = latch();
  let size = 0;
  const { proxy } = await setup(async (req, res) => {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      observed.resolve();
    }
    res.end(String(size));
  });
  const length = 32 * 1024 * 1024 + 1;
  const req = http.request(proxy.url + "/upload", {
    method: "POST",
    headers: { "content-length": length },
  });
  const response = once(req, "response");
  req.write("x");
  await observed.promise;
  const block = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 32; i++) if (!req.write(block)) await once(req, "drain");
  req.end();
  const [resp] = (await response) as [http.IncomingMessage];
  const chunks = [];
  for await (const c of resp) chunks.push(c);
  expect(Buffer.concat(chunks).toString()).toBe(String(length));
});
