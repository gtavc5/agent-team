import { randomBytes, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  providerId,
  piSnapshotSchema,
  type QuotaSnapshot,
  type PiQuotaReader,
} from "./quota-schema";
import { z } from "zod";
import type { PanelToolset } from "../project/tools";
import type { BoundedSessionProof } from "./types";
import {
  assertNoEmptyEnum,
  forGeminiSchema,
  zodShapeToRestrictedJsonSchema,
  type RestrictedJsonSchema,
} from "./panel-schema";

export interface PanelHttpAddress {
  baseUrl: string;
  port: number;
}

export interface PanelSessionRegistration {
  sessionKey: string;
  getToolset: () => PanelToolset | null;
  onQuota?: (snapshot: QuotaSnapshot) => void;
  restoreExpectation?: { expectedAnchorId: string | null };
  onAnswer?: (tool: string, args: unknown, text: string, isError: boolean) => void;
}

export interface PanelToolDefinition {
  name: string;
  description: string;
  promptSnippet?: string;
  schema: RestrictedJsonSchema;
}

export interface PanelReadyReport {
  sessionProof: BoundedSessionProof;
  ownerToolNames: string[];
  quotaProviders?: string[];
  requiredExtensionsRegistered: boolean;
  subagentsRpcReady: boolean;
  subagentsSessionId: string | null;
}

export interface SessionCheckpoint {
  leafId: string | null;
  entryCount: number;
  sessionId: string | null;
  sessionFile: string | null;
}

export interface DispatchedInputProbe {
  found: boolean;
  anchorMissing: boolean;
  matchedEntryId?: string;
}

type PendingControl = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type SessionRoute = PanelSessionRegistration & {
  token: string;
  version: number;
  ready?: PanelReadyReport;
  readyWaiters: Array<{
    resolve: (report: PanelReadyReport) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>;
  controlWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>;
  control?: http.ServerResponse;
  pendingControls: Map<string, PendingControl>;
};

const readySchema = z.object({
  sessionProof: z.object({
    sessionId: z.string().nullable(),
    sessionFile: z.string().nullable(),
    cwd: z.string(),
    headerCwd: z.string().nullable(),
    entryCount: z.number().int().nonnegative(),
    leafId: z.string().nullable(),
    anchorOnActiveBranch: z.boolean(),
    anchorExistsInFile: z.boolean(),
  }),
  ownerToolNames: z.array(z.string()),
  quotaProviders: z.array(providerId).max(32).optional(),
  requiredExtensionsRegistered: z.boolean(),
  subagentsRpcReady: z.boolean(),
  subagentsSessionId: z.string().nullable(),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutError(operation: string, timeoutMs: number): Error {
  return new Error(`${operation} timed out after ${timeoutMs}ms`);
}

export class PanelHttpServer {
  private readonly server = http.createServer((req, res) => void this.handle(req, res));
  private readonly sessions = new Map<string, SessionRoute>();
  private readonly sockets = new Set<import("node:net").Socket>();
  private address?: PanelHttpAddress;
  private closing = false;

  constructor(private readonly onQuotaReaderReady?: (providers: string[]) => void) {
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  listen(): Promise<PanelHttpAddress> {
    if (this.address) return Promise.resolve(this.address);
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address() as AddressInfo;
        this.address = { baseUrl: `http://127.0.0.1:${address.port}`, port: address.port };
        resolve(this.address);
      });
    });
  }

  registerSession(options: PanelSessionRegistration): string {
    if (this.closing) throw new Error("PanelHttpServer is closed");
    if (this.sessions.has(options.sessionKey)) {
      throw new Error(`Panel session is already registered: ${options.sessionKey}`);
    }
    const token = randomBytes(32).toString("hex");
    this.sessions.set(options.sessionKey, {
      ...options,
      token,
      version: 0,
      readyWaiters: [],
      controlWaiters: [],
      pendingControls: new Map(),
    });
    return token;
  }

  quotaReader(): PiQuotaReader | undefined {
    const sessions = [...this.sessions.values()]
      .filter((s) => s.onQuota && s.ready && this.isControlConnected(s.sessionKey))
      .sort(
        (a, b) => (b.ready?.quotaProviders?.length ?? 0) - (a.ready?.quotaProviders?.length ?? 0),
      );
    if (!sessions.length) return;
    const routes = new Map<string, string>();
    for (const session of sessions) {
      for (const provider of session.ready?.quotaProviders ?? []) {
        if (!routes.has(provider)) routes.set(provider, session.sessionKey);
      }
    }
    return {
      configured: [...routes.keys()],
      read: async (provider) => {
        const key = routes.get(provider);
        if (key === undefined) throw new Error("Quota provider is not configured");
        const result = piSnapshotSchema.parse(
          await this.controlRequest(key, "refresh_quota", { provider }, 50_000),
        );
        if (result.provider !== provider) throw new Error("Unexpected quota provider");
        return result;
      },
    };
  }

  private notifyQuotaReaderReady(previous: PiQuotaReader | undefined): void {
    if (!this.onQuotaReaderReady) return;
    const current = this.quotaReader();
    if (!current) return;
    const added = current.configured.filter((id) => !previous?.configured.includes(id));
    if (!previous || added.length) this.onQuotaReaderReady(added);
  }

  notifyToolsetChanged(key: string): void {
    const session = this.requireSession(key);
    session.version += 1;
    this.writeControl(session, { type: "toolset_changed", version: session.version });
  }

  isControlConnected(key: string): boolean {
    const control = this.sessions.get(key)?.control;
    return Boolean(control && !control.destroyed && !control.writableEnded);
  }

  waitForControl(key: string, timeoutMs: number): Promise<void> {
    const session = this.requireSession(key);
    if (this.isControlConnected(key)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          session.controlWaiters = session.controlWaiters.filter((item) => item !== waiter);
          reject(timeoutError(`Panel session ${key} control channel`, timeoutMs));
        }, timeoutMs),
      };
      session.controlWaiters.push(waiter);
    });
  }

  waitForReady(key: string, timeoutMs: number): Promise<PanelReadyReport> {
    const session = this.requireSession(key);
    if (session.ready) return Promise.resolve(session.ready);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          session.readyWaiters = session.readyWaiters.filter((item) => item !== waiter);
          reject(timeoutError(`Panel session ${key} ready`, timeoutMs));
        }, timeoutMs),
      };
      session.readyWaiters.push(waiter);
    });
  }

  sendSubagentsRpc(
    key: string,
    method: string,
    params?: unknown,
    timeoutMs = 3_000,
  ): Promise<unknown> {
    return this.controlRequest(key, "subagents_rpc", { method, params }, timeoutMs);
  }

  requestSessionCheckpoint(key: string, timeoutMs = 3_000): Promise<SessionCheckpoint> {
    return this.controlRequest(
      key,
      "session_checkpoint",
      {},
      timeoutMs,
    ) as Promise<SessionCheckpoint>;
  }

  async probeDispatchedReport(
    key: string,
    beforeLeafId: string | null,
    reportId: string,
    timeoutMs = 3_000,
  ): Promise<DispatchedInputProbe> {
    const deadline = Date.now() + timeoutMs;
    if (!this.isControlConnected(key)) {
      await this.waitForControl(key, Math.max(1, deadline - Date.now()));
    }
    return (await this.controlRequest(
      key,
      "probe_dispatched_inputs",
      { beforeLeafId, reportId },
      Math.max(1, deadline - Date.now()),
    )) as DispatchedInputProbe;
  }

  unregisterSession(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    const error = new Error(`Panel session is no longer registered: ${key}`);
    this.failWaiters(session, error);
    session.control?.end();
  }

  close(): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.closing = true;
    const error = new Error("PanelHttpServer is closed");
    for (const session of this.sessions.values()) {
      this.failWaiters(session, error);
      session.control?.end();
    }
    this.sessions.clear();
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server.close((closeError) => (closeError ? reject(closeError) : resolve()));
    });
  }

  private requireSession(key: string): SessionRoute {
    const session = this.sessions.get(key);
    if (!session) throw new Error(`Unknown panel session: ${key}`);
    return session;
  }

  private failWaiters(session: SessionRoute, error: Error): void {
    for (const waiter of session.readyWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    for (const waiter of session.controlWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    for (const pending of session.pendingControls.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pendingControls.clear();
  }

  private writeControl(session: SessionRoute, message: Record<string, unknown>): boolean {
    if (!this.isControlConnected(session.sessionKey)) return false;
    session.control!.write(`data: ${JSON.stringify(message)}\n\n`);
    return true;
  }

  private controlRequest(
    key: string,
    type: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const session = this.requireSession(key);
    if (!this.isControlConnected(key)) {
      return Promise.reject(new Error(`Panel control channel is not connected: ${key}`));
    }
    const controlId = randomBytes(16).toString("hex");
    return new Promise((resolve, reject) => {
      const pending: PendingControl = {
        resolve,
        reject,
        timer: setTimeout(() => {
          session.pendingControls.delete(controlId);
          reject(timeoutError(`Panel control ${type}`, timeoutMs));
        }, timeoutMs),
      };
      session.pendingControls.set(controlId, pending);
      if (!this.writeControl(session, { type, controlId, ...payload })) {
        clearTimeout(pending.timer);
        session.pendingControls.delete(controlId);
        reject(new Error(`Panel control channel is not connected: ${key}`));
      }
    });
  }

  private authorized(req: http.IncomingMessage, session: SessionRoute): boolean {
    const value = req.headers.authorization;
    const prefix = "Bearer ";
    if (!value?.startsWith(prefix)) return false;
    const supplied = Buffer.from(value.slice(prefix.length));
    const expected = Buffer.from(session.token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private json(res: http.ServerResponse, status: number, value: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(value);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
  }

  private async body(req: http.IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req as AsyncIterable<Uint8Array>) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > limit) throw new Error(`Request body exceeds ${limit} bytes`);
      chunks.push(bytes);
    }
    if (length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const match =
        /^\/v1\/sessions\/([^/]+)\/(toolset|call|ready|control|control-reply|quota)$/.exec(
          url.pathname,
        );
      if (!match) {
        this.json(res, 404, { error: "Not found" });
        return;
      }
      const key = decodeURIComponent(match[1]);
      const endpoint = match[2];
      const session = this.sessions.get(key);
      if (!session) {
        this.json(res, 403, { error: "Session is not registered" });
        return;
      }
      if (!this.authorized(req, session)) {
        this.json(res, 401, { error: "Invalid bearer token" });
        return;
      }
      if (req.method === "POST" && endpoint === "quota") {
        const result = piSnapshotSchema.safeParse(await this.body(req, 96 * 1024));
        if (this.sessions.get(key) !== session || !session.onQuota)
          this.json(res, 403, { error: "Quota route unavailable" });
        else if (!result.success) this.json(res, 400, { error: "Invalid quota snapshot" });
        else {
          session.onQuota(result.data);
          this.json(res, 200, { ok: true });
        }
      } else if (req.method === "GET" && endpoint === "toolset") {
        this.sendToolset(res, session);
      } else if (req.method === "POST" && endpoint === "call") {
        await this.callTool(req, res, session);
      } else if (req.method === "POST" && endpoint === "ready") {
        await this.receiveReady(req, res, session);
      } else if (req.method === "GET" && endpoint === "control") {
        this.receiveControl(req, res, session);
      } else if (req.method === "POST" && endpoint === "control-reply") {
        await this.receiveControlReply(req, res, session);
      } else {
        this.json(res, 405, { error: "Method not allowed" });
      }
    } catch (error) {
      this.json(res, 400, { error: errorMessage(error) });
    }
  }

  private sendToolset(res: http.ServerResponse, session: SessionRoute): void {
    const toolset = session.getToolset();
    if (!toolset) {
      this.json(res, 200, {
        version: session.version,
        instructions: "",
        tools: [],
      });
      return;
    }
    const tools = toolset.tools.map((tool) => {
      const schema = forGeminiSchema(zodShapeToRestrictedJsonSchema(tool.shape));
      assertNoEmptyEnum(schema);
      return {
        name: tool.name,
        description: tool.description,
        ...("promptSnippet" in tool &&
          typeof tool.promptSnippet === "string" && { promptSnippet: tool.promptSnippet }),
        schema,
      };
    });
    this.json(res, 200, {
      version: session.version,
      instructions: toolset.instructions,
      tools,
    });
  }

  private async callTool(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    session: SessionRoute,
  ): Promise<void> {
    const body = await this.body(req);
    if (this.sessions.get(session.sessionKey) !== session || !this.authorized(req, session)) {
      this.json(res, 403, { error: "Session is not registered" });
      return;
    }
    const input = z
      .object({
        name: z.string(),
        params: z.unknown().optional(),
        callId: z.string().min(1).optional(),
      })
      .safeParse(body);
    if (!input.success) {
      this.json(res, 400, { error: z.prettifyError(input.error) });
      return;
    }

    // Re-read the live toolset after parsing the body: revocation during a
    // running turn (including codemode calls) takes effect on the next call.
    const tool = session
      .getToolset()
      ?.tools.find((candidate) => candidate.name === input.data.name);
    if (!tool) {
      this.json(res, 403, { error: `${input.data.name} is not available to this session` });
      return;
    }
    const parsed = z.object(tool.shape).safeParse(input.data.params ?? {});
    if (!parsed.success) {
      const text = z.prettifyError(parsed.error);
      session.onAnswer?.(tool.name, input.data.params, text, true);
      this.json(res, 200, { text, isError: true });
      return;
    }

    const abort = new AbortController();
    const onAborted = () => abort.abort(new Error("Panel tool HTTP request was aborted"));
    req.once("aborted", onAborted);
    res.once("close", onAborted);
    try {
      const text = await tool.handler(parsed.data, abort.signal, input.data.callId);
      session.onAnswer?.(tool.name, parsed.data, text, false);
      this.json(res, 200, { text, isError: false });
    } catch (error) {
      if (abort.signal.aborted) return;
      const text = errorMessage(error);
      session.onAnswer?.(tool.name, parsed.data, text, true);
      this.json(res, 200, { text, isError: true });
    } finally {
      req.off("aborted", onAborted);
      res.off("close", onAborted);
    }
  }

  private async receiveReady(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    session: SessionRoute,
  ): Promise<void> {
    const parsed = readySchema.safeParse(await this.body(req));
    if (this.sessions.get(session.sessionKey) !== session) {
      this.json(res, 403, { error: "Session is not registered" });
      return;
    }
    if (!parsed.success) {
      this.json(res, 400, { error: z.prettifyError(parsed.error) });
      return;
    }
    const previousReader = this.onQuotaReaderReady ? this.quotaReader() : undefined;
    session.ready = parsed.data;
    for (const waiter of session.readyWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(parsed.data);
    }
    this.json(res, 200, { ok: true });
    this.notifyQuotaReaderReady(previousReader);
  }

  private receiveControl(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    session: SessionRoute,
  ): void {
    const previousReader = this.onQuotaReaderReady ? this.quotaReader() : undefined;
    session.control?.end();
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    res.write(": panel-control\n\n");
    session.control = res;
    for (const waiter of session.controlWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    req.on("close", () => {
      if (session.control === res) session.control = undefined;
      const error = new Error(`Panel control channel closed: ${session.sessionKey}`);
      for (const [id, pending] of session.pendingControls) {
        clearTimeout(pending.timer);
        pending.reject(error);
        session.pendingControls.delete(id);
      }
    });
    this.notifyQuotaReaderReady(previousReader);
  }

  private async receiveControlReply(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    session: SessionRoute,
  ): Promise<void> {
    const parsed = z
      .object({
        controlId: z.string(),
        result: z.unknown().optional(),
        error: z.string().optional(),
      })
      .safeParse(await this.body(req));
    if (this.sessions.get(session.sessionKey) !== session) {
      this.json(res, 403, { error: "Session is not registered" });
      return;
    }
    if (!parsed.success) {
      this.json(res, 400, { error: z.prettifyError(parsed.error) });
      return;
    }
    const pending = session.pendingControls.get(parsed.data.controlId);
    if (!pending) {
      this.json(res, 404, { error: "Unknown or expired controlId" });
      return;
    }
    session.pendingControls.delete(parsed.data.controlId);
    clearTimeout(pending.timer);
    if (parsed.data.error !== undefined) pending.reject(new Error(parsed.data.error));
    else pending.resolve(parsed.data.result);
    this.json(res, 200, { ok: true });
  }
}
