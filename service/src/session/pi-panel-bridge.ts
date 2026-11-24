import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Type, type TSchema } from "typebox";

type JsonObject = Record<string, unknown>;
type Unsubscribe = () => void;

interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  message?: {
    role?: string;
    content?: unknown;
  };
}

interface SessionManager {
  getHeader(): { id?: string; cwd?: string; parentSession?: string } | null;
  getSessionId(): string | null;
  getSessionFile(): string | undefined;
  getCwd(): string;
  getEntries(): SessionEntry[];
  getBranch(): SessionEntry[];
  getLeafId(): string | null;
}

interface ExtensionContext {
  cwd: string;
  sessionManager: SessionManager;
}

interface PromptOptions {
  sections?: Record<string, string>;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
}

interface BeforeAgentStartEvent {
  systemPromptOptions?: PromptOptions;
}

interface ToolInfo {
  name: string;
  description: string;
}

interface PanelToolDefinition {
  name: string;
  description: string;
  promptSnippet?: string;
  schema: RestrictedJsonSchema;
}

interface PanelToolset {
  version: number;
  instructions: string;
  tools: PanelToolDefinition[];
}

interface PiExtensionApi {
  events: {
    on(channel: string, handler: (data: unknown) => void): Unsubscribe;
    emit(channel: string, data: unknown): void;
  };
  on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => void): Unsubscribe;
  on(
    event: "before_agent_start",
    handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => void | Promise<void>,
  ): Unsubscribe;
  on(
    event: "session_shutdown",
    handler: (event: unknown, ctx: ExtensionContext) => void,
  ): Unsubscribe;
  getAllTools(): ToolInfo[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    parameters: TSchema;
    execute: (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>;
  }): void;
}

type JsonSchemaType = "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";

interface RestrictedJsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, RestrictedJsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: RestrictedJsonSchema;
  anyOf?: RestrictedJsonSchema[];
  enum?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  description?: string;
  default?: unknown;
}

interface BoundedSessionProof {
  sessionId: string | null;
  sessionFile: string | null;
  cwd: string;
  headerCwd: string | null;
  entryCount: number;
  leafId: string | null;
  anchorOnActiveBranch: boolean;
  anchorExistsInFile: boolean;
}

interface SubagentsReply {
  version?: number;
  requestId?: string;
  success?: boolean;
  data?: unknown;
  error?: { message?: string };
}

interface RequiredChildExtensionsModule {
  registerRequiredChildExtensions(input: {
    sessionId: string;
    extensions: Array<{ id: string; path: string }>;
  }): { dispose(): void };
}

function schemaOptions(schema: RestrictedJsonSchema): JsonObject {
  const options: JsonObject = {};
  if (schema.description !== undefined) options.description = schema.description;
  if (schema.default !== undefined) options.default = schema.default;
  if (schema.minimum !== undefined) options.minimum = schema.minimum;
  if (schema.maximum !== undefined) options.maximum = schema.maximum;
  return options;
}

// Kept inline deliberately: Pi loads this single file through jiti, including
// when it is copied to dist without the service's other source modules.
function jsonSchemaToTypeBox(schema: RestrictedJsonSchema): TSchema {
  const options = schemaOptions(schema);
  if (schema.anyOf) return Type.Union(schema.anyOf.map(jsonSchemaToTypeBox), options);
  if (schema.enum) {
    return Type.Union(
      schema.enum.map((value) => Type.Literal(value)),
      options,
    );
  }
  if (Array.isArray(schema.type)) {
    return Type.Union(
      schema.type.map((type) => jsonSchemaToTypeBox({ ...schema, type, anyOf: undefined })),
      options,
    );
  }
  switch (schema.type) {
    case "object": {
      const required = new Set(schema.required ?? []);
      const properties = Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([name, property]) => {
          const converted = jsonSchemaToTypeBox(property);
          return [name, required.has(name) ? converted : Type.Optional(converted)];
        }),
      );
      return Type.Object(properties, { ...options, additionalProperties: false });
    }
    case "string":
      return Type.String(options);
    case "number":
      return Type.Number(options);
    case "integer":
      return Type.Integer(options);
    case "boolean":
      return Type.Boolean(options);
    case "array":
      if (!schema.items)
        throw new Error(`Panel array schema has no items: ${JSON.stringify(schema)}`);
      return Type.Array(jsonSchemaToTypeBox(schema.items), options);
    case "null":
      return Type.Null();
    default:
      throw new Error(`Unsupported panel schema: ${JSON.stringify(schema)}`);
  }
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = asObject(part);
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("\n");
}

function boundedProof(ctx: ExtensionContext, expectedAnchorId: string | null): BoundedSessionProof {
  const manager = ctx.sessionManager;
  const entries = manager.getEntries();
  const branch = manager.getBranch();
  const header = manager.getHeader();
  return {
    sessionId: manager.getSessionId() || null,
    sessionFile: manager.getSessionFile() ?? null,
    cwd: ctx.cwd,
    headerCwd: header?.cwd ?? null,
    entryCount: entries.length,
    leafId: manager.getLeafId(),
    anchorOnActiveBranch:
      expectedAnchorId === null || branch.some((entry) => entry.id === expectedAnchorId),
    anchorExistsInFile:
      expectedAnchorId !== null && entries.some((entry) => entry.id === expectedAnchorId),
  };
}

function checkpoint(ctx: ExtensionContext): JsonObject {
  return {
    leafId: ctx.sessionManager.getLeafId(),
    entryCount: ctx.sessionManager.getEntries().length,
    sessionId: ctx.sessionManager.getSessionId() || null,
    sessionFile: ctx.sessionManager.getSessionFile() ?? null,
  };
}

function probeDispatchedInputs(
  ctx: ExtensionContext,
  beforeLeafId: string | null,
  reportId: string,
): JsonObject {
  const branch = ctx.sessionManager.getBranch();
  let start = 0;
  if (beforeLeafId !== null) {
    const anchor = branch.findIndex((entry) => entry.id === beforeLeafId);
    if (anchor < 0) return { found: false, anchorMissing: true };
    start = anchor + 1;
  }
  const marker = `[agent-team:report:${reportId}]`;
  for (const entry of branch.slice(start)) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    if (textContent(entry.message.content).includes(marker)) {
      return { found: true, anchorMissing: false, matchedEntryId: entry.id };
    }
  }
  return { found: false, anchorMissing: false };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function piPanelBridge(pi: PiExtensionApi): void {
  const panelUrl = process.env.YAAT_PANEL_URL?.replace(/\/$/, "");
  const panelToken = process.env.YAAT_PANEL_TOKEN;
  if (!panelUrl || !panelToken) return;
  const panelKey = process.env.YAAT_PANEL_KEY ?? "";
  const expectedAnchorId = process.env.YAAT_PANEL_EXPECTED_ANCHOR || null;
  const piSubagentsRoot = process.env.YAAT_PI_SUBAGENTS_ROOT;
  const antigravityEntry = process.env.YAAT_PI_ANTIGRAVITY_ENTRY;

  let stopped = false;
  let generation = 0;
  let requiredExtReg: { dispose(): void } | undefined;
  let requiredExtensionsRegistered = false;
  let controlAbort: AbortController | undefined;
  let currentToolset: PanelToolset = { version: -1, instructions: "", tools: [] };
  let activePanelToolNames = new Set<string>();
  const bridgeOwnedToolNames = new Set<string>();
  const readyWaiters = new Set<() => void>();
  const rpcWaiters = new Set<Unsubscribe>();
  let subagentsReady = false;

  const notifyReady = () => {
    for (const notify of [...readyWaiters]) notify();
  };
  const offReady = pi.events.on("subagents:rpc:v1:ready", () => {
    subagentsReady = true;
    notifyReady();
  });

  const endpoint = (suffix: string) =>
    `${panelUrl}/v1/sessions/${encodeURIComponent(panelKey)}/${suffix}`;

  async function requestJson(
    suffix: string,
    options: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const timeout = new AbortController();
    const timeoutMs = options.timeoutMs ?? 5_000;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => timeout.abort(new Error(`Panel HTTP ${suffix} timed out`)), timeoutMs)
        : undefined;
    const signal = options.signal;
    const onExternalAbort = () => timeout.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      const response = await fetch(endpoint(suffix), {
        method: options.method ?? "GET",
        headers: {
          authorization: `Bearer ${panelToken}`,
          ...(options.body !== undefined && { "content-type": "application/json" }),
        },
        ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
        signal: timeout.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Panel HTTP ${response.status}: ${text}`);
      return text ? (JSON.parse(text) as unknown) : undefined;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  async function fetchToolset(): Promise<PanelToolset> {
    return (await requestJson("toolset", { timeoutMs: 5_000 })) as PanelToolset;
  }

  function registerTools(toolset: PanelToolset): Set<string> {
    const existing = new Map(pi.getAllTools().map((tool) => [tool.name, tool.description]));
    const desired = new Set<string>();
    for (const def of toolset.tools) {
      const owned = bridgeOwnedToolNames.has(def.name);
      if (!owned && existing.has(def.name)) continue;
      if (!owned || existing.get(def.name) !== def.description) {
        pi.registerTool({
          name: def.name,
          label: def.name,
          description: def.description,
          ...(def.promptSnippet && { promptSnippet: def.promptSnippet }),
          parameters: jsonSchemaToTypeBox(def.schema),
          execute: async (toolCallId, params, signal) => {
            const result = asObject(
              await requestJson("call", {
                method: "POST",
                body: { name: def.name, params, callId: toolCallId },
                signal,
                timeoutMs: 0,
              }),
            );
            return {
              content: [{ type: "text", text: typeof result.text === "string" ? result.text : "" }],
              ...(result.isError === true && { isError: true }),
            };
          },
        });
        bridgeOwnedToolNames.add(def.name);
      }
      desired.add(def.name);
    }
    return desired;
  }

  function applyToolset(toolset: PanelToolset, event?: BeforeAgentStartEvent): void {
    currentToolset = toolset;
    const desired = registerTools(toolset);
    const options = event?.systemPromptOptions;
    for (const def of toolset.tools) {
      if (def.promptSnippet && options?.toolSnippets) {
        options.toolSnippets[def.name] = def.promptSnippet;
      }
    }
    if (!event) {
      activePanelToolNames = desired;
      return;
    }

    const active = new Set(pi.getActiveTools());
    for (const name of bridgeOwnedToolNames) active.delete(name);
    for (const name of desired) active.add(name);
    pi.setActiveTools([...active]);

    if (Array.isArray(options?.selectedTools)) {
      const selected = new Set(options.selectedTools);
      for (const name of bridgeOwnedToolNames) selected.delete(name);
      for (const name of desired) selected.add(name);
      options.selectedTools = [...selected];
    }
    if (options?.toolSnippets) {
      for (const name of bridgeOwnedToolNames) {
        if (!desired.has(name)) delete options.toolSnippets[name];
      }
    }
    if (options?.sections) {
      if (toolset.instructions) options.sections.agent_team_panel = toolset.instructions;
      else delete options.sections.agent_team_panel;
    }
    activePanelToolNames = desired;
  }

  function waitForSubagentsReady(timeoutMs: number): Promise<boolean> {
    if (subagentsReady) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ready: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        readyWaiters.delete(onReady);
        resolve(ready);
      };
      const onReady = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      readyWaiters.add(onReady);
    });
  }

  async function subagentsRpc(
    method: string,
    params?: unknown,
    timeoutMs = 3_000,
  ): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: Error, data?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        rpcWaiters.delete(off);
        if (error) reject(error);
        else resolve(data);
      };
      const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (raw) => {
        const reply = asObject(raw) as SubagentsReply;
        if (reply.success === true) finish(undefined, reply.data);
        else finish(new Error(reply.error?.message ?? "Subagents RPC failed"));
      });
      rpcWaiters.add(off);
      const timer = setTimeout(
        () => finish(new Error(`Subagents RPC ${method} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      pi.events.emit("subagents:rpc:v1:request", {
        version: 1,
        requestId,
        method,
        ...(params !== undefined && { params }),
      });
    });
  }

  async function reportReady(ctx: ExtensionContext, proof: BoundedSessionProof): Promise<void> {
    const deadline = Date.now() + 3_000;
    const pingSessionId = (data: JsonObject): string | null => {
      const value = asObject(data.session).sessionId;
      return typeof value === "string" && value.length > 0 ? value : null;
    };
    let ping: JsonObject = {};
    let resolvedSessionId: string | null = null;
    try {
      ping = asObject(await subagentsRpc("ping", undefined, Math.max(1, deadline - Date.now())));
      resolvedSessionId = pingSessionId(ping);
    } catch {
      // A later subagents session_start handler may not have installed the RPC
      // request listener yet. The ready event below is the retry boundary.
    }
    if (!resolvedSessionId) {
      await waitForSubagentsReady(Math.max(0, deadline - Date.now()));
      try {
        ping = asObject(await subagentsRpc("ping", undefined, Math.max(1, deadline - Date.now())));
        resolvedSessionId = pingSessionId(ping);
      } catch {
        resolvedSessionId = null;
      }
    }
    await requestJson("ready", {
      method: "POST",
      body: {
        sessionProof: proof,
        ownerToolNames: [...activePanelToolNames],
        requiredExtensionsRegistered,
        subagentsRpcReady: resolvedSessionId !== null,
        subagentsSessionId: resolvedSessionId,
      },
      timeoutMs: 5_000,
    });
  }

  async function replyControl(
    controlId: unknown,
    result?: unknown,
    error?: unknown,
  ): Promise<void> {
    if (typeof controlId !== "string") return;
    await requestJson("control-reply", {
      method: "POST",
      body: {
        controlId,
        ...(error !== undefined ? { error: errorMessage(error) } : { result }),
      },
    });
  }

  async function handleControl(raw: JsonObject, ctx: ExtensionContext): Promise<void> {
    const type = raw.type;
    try {
      if (type === "toolset_changed") return;
      if (type === "session_checkpoint") {
        await replyControl(raw.controlId, checkpoint(ctx));
      } else if (type === "probe_dispatched_inputs") {
        await replyControl(
          raw.controlId,
          probeDispatchedInputs(
            ctx,
            typeof raw.beforeLeafId === "string" ? raw.beforeLeafId : null,
            typeof raw.reportId === "string" ? raw.reportId : "",
          ),
        );
      } else if (type === "subagents_rpc") {
        const result = await subagentsRpc(
          typeof raw.method === "string" ? raw.method : "",
          raw.params,
        );
        await replyControl(raw.controlId, result);
      } else {
        throw new Error(`Unknown panel control message: ${String(type)}`);
      }
    } catch (error) {
      await replyControl(raw.controlId, undefined, error);
    }
  }

  async function runControl(
    ctx: ExtensionContext,
    ownGeneration: number,
    onConnected?: () => void,
  ): Promise<void> {
    const abort = new AbortController();
    controlAbort = abort;
    let signaledConnected = false;
    while (!stopped && ownGeneration === generation && !abort.signal.aborted) {
      try {
        const response = await fetch(endpoint("control"), {
          headers: { authorization: `Bearer ${panelToken}`, accept: "text/event-stream" },
          signal: abort.signal,
        });
        if (!response.ok || !response.body)
          throw new Error(`Panel control HTTP ${response.status}`);
        if (!signaledConnected) {
          signaledConnected = true;
          onConnected?.();
        }
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        let dataLines: string[] = [];
        const dispatch = () => {
          if (dataLines.length === 0) return;
          const raw = asObject(JSON.parse(dataLines.join("\n")));
          dataLines = [];
          void handleControl(raw, ctx).catch(() => undefined);
        };
        while (!abort.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            if (line === "" || line === "\r") dispatch();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
        }
        dispatch();
      } catch {
        if (stopped || abort.signal.aborted || ownGeneration !== generation) break;
      }
      if (!stopped && ownGeneration === generation && !abort.signal.aborted) await delay(250);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.sessionManager.getHeader()?.parentSession) return;
    const ownGeneration = ++generation;
    controlAbort?.abort();
    requiredExtReg?.dispose();
    requiredExtReg = undefined;
    requiredExtensionsRegistered = false;
    if (ownGeneration > 1) subagentsReady = false;

    // Deliberately fire-and-forget. Pi serializes session_start handlers, so
    // this handler itself must return before network I/O and the RPC ping.
    void (async () => {
      if (piSubagentsRoot && antigravityEntry) {
        const module = (await import(
          pathToFileURL(path.join(piSubagentsRoot, "bundle/required-child-extensions.js")).href
        )) as RequiredChildExtensionsModule;
        requiredExtReg = module.registerRequiredChildExtensions({
          sessionId: ctx.sessionManager.getSessionId()!,
          extensions: [{ id: "antigravity-acp", path: fs.realpathSync(antigravityEntry) }],
        });
        requiredExtensionsRegistered = true;
      }
      applyToolset(await fetchToolset());
      const proof = boundedProof(ctx, expectedAnchorId);
      let markConnected!: () => void;
      const controlConnected = new Promise<void>((resolve) => {
        markConnected = resolve;
      });
      void runControl(ctx, ownGeneration, markConnected);
      await Promise.race([controlConnected, delay(1_000)]);
      await reportReady(ctx, proof);
    })().catch(() => undefined);
  });

  pi.on("before_agent_start", async (event) => {
    const latest = await fetchToolset();
    if (stopped || latest.version === currentToolset.version) {
      if (event.systemPromptOptions?.sections) {
        if (currentToolset.instructions) {
          event.systemPromptOptions.sections.agent_team_panel = currentToolset.instructions;
        } else delete event.systemPromptOptions.sections.agent_team_panel;
      }
      return;
    }
    applyToolset(latest, event);
  });

  pi.on("session_shutdown", () => {
    stopped = true;
    generation += 1;
    controlAbort?.abort();
    requiredExtReg?.dispose();
    requiredExtReg = undefined;
    offReady();
    for (const off of rpcWaiters) off();
    rpcWaiters.clear();
    for (const notify of readyWaiters) notify();
    readyWaiters.clear();
  });
}
