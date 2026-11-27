import { lifecycleWriter } from "../usage/lifecycle";
import { estimatedContext } from "../../../shared/context-usage";
import { createHash } from "node:crypto";
import { EventEmitter } from "events";
import * as os from "os";
import { z } from "zod";
import { isTokenCount, type UsageRecorder } from "./usage-observation";
import {
  type CodexRecoveryProof,
  ContextUsage,
  RunState,
  StreamEvent,
  UsageStats,
  SessionConfig,
  SessionState,
  PromptEnvelope,
  InputTrigger,
  SendHooks,
  SendReceipt,
  fenced,
  formatToolUse,
} from "./types";
import {
  AppServerClient,
  RpcRequestError,
  codexBinary,
  spawnAppServer,
  type CodexThread,
  type CodexTurn,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
  type GetAccountResponse,
  type RateLimitSnapshot,
  type RateLimitWindow,
  type ThreadItem,
  type ThreadTokenUsage,
  type Transport,
  type TurnError,
  type UserInput,
} from "./codex-rpc";
import { applyNonInteractiveGitEnv } from "./git-env";
import type { PanelToolset } from "../project/tools";
import { classifyNetworkFailure } from "../project/network-failure";
import {
  codexContextWindow,
  codexFastTier,
  codexModelId,
  defaultEffortForModel,
} from "../config/presets";

// The panel's tools reach Codex as client-defined tools of this namespace,
// declared when the thread starts (the thread keeps them across resumes;
// snap fixture codex/resume) and answered here. A subagent's thread does not
// get them (codex/tools), so nothing needs refusing to subagents.
const PANEL_NAMESPACE = "panel";

type ModelLifecycle = {
  trigger: InputTrigger | "continuation" | "subagent";
  step?: { turnId: string; id: string; itemIds: Set<string>; firstDelta: boolean };
};
type ChildLifecycle = ModelLifecycle & { turnId?: string };

type UsageThreadModel = { model?: string; modelProvider?: string };
type OpenThreadResponse = UsageThreadModel & { thread: CodexThread };

type RecoveryAttempt = {
  outageId: string;
  inputId: string;
  textHash: string | null;
  userItemId?: string;
  acknowledgedTurnId?: string;
};

const codexRecoveryProof = z.strictObject({
  outageId: z.string().min(1),
  inputId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  userItem: z.strictObject({ id: z.string().min(1), textHash: z.hash("sha256") }).nullable(),
});

const RECOVERY_REJECTED: SendReceipt = {
  disposition: "rejected",
  error: "Codex recovery was not sent: cannot safely continue the exact previous failed batch.",
};

function recoveryTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function matchesRecoveryUserItem(item: ThreadItem, inputId: string, textHash: string): boolean {
  if (
    item.type !== "userMessage" ||
    item.clientId !== inputId ||
    !Array.isArray(item.content) ||
    item.content.length !== 1
  )
    return false;
  const text = item.content[0] as UserInput | null;
  return (
    text?.type === "text" &&
    typeof text.text === "string" &&
    recoveryTextHash(text.text) === textHash
  );
}

// "no rollout found for thread id …" (codex 0.153): the thread is gone from
// ~/.codex/sessions.
const THREAD_GONE = /no rollout found|thread not found/i;

// "Selected model is at capacity" fails the turn at once, often after work
// was done, and passes in minutes. The prompt is in the thread by then (its
// rollout records it before the model is asked), so a retry asks to carry on
// rather than sending it again.
const CAPACITY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
const CAPACITY_CONTINUE = [
  "Continue from where you left off.",
  "The previous turn was interrupted because the selected model was at capacity.",
  "Inspect the current conversation and workspace state, preserve completed work, and do not repeat commands or edits that already succeeded.",
].join(" ");

// A Codex session is one long-lived `codex app-server` (JSON-RPC over stdio,
// see codex-rpc.ts) holding one thread, started on the first message and
// resumed by thread id after a restart. A turn runs from turn/start to
// turn/completed; a message sent meanwhile is steered into it (turn/steer),
// and Stop is turn/interrupt, which leaves the process up. Frame facts are
// in the stream-debug skill; every case below has a recording in
// tests/snap/codex.
export class CodexSession extends EventEmitter {
  sessionId: string | null = null;
  config: SessionConfig;
  usage: UsageStats = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    turns: 0,
    duration_ms: 0,
  };

  // Replaced by the tests: the connection a session opens (a recording
  // played back, an in-memory server) instead of a real app-server.
  static hooks: {
    transport?: (session: CodexSession, env: NodeJS.ProcessEnv) => Transport;
    capacityRetryDelaysMs?: number[];
  } | null = null;

  private client: AppServerClient | null = null;
  private connecting: Promise<AppServerClient> | null = null;
  // What the running process was started with; a change takes effect by
  // restarting it (the thread resumes) before the next turn.
  private launched: string | null = null;
  private panelTools: PanelToolset | null = null;

  private busy = false;
  private readonly commandsInFlight = new Set<string>();
  private panelCalls = 0;
  private readonly retiring = new Set<Promise<void>>();
  // Every turn and every abort: what an older one's requests answer later
  // is no business of the current one.
  private generation = 0;
  private turnId: string | null = null;
  // Codex announced the turn (turn/started): it can be interrupted.
  private turnStarted = false;
  private turnStartedAt = 0;
  private interruptRequested = false;
  private interruptSent = false;
  // Steers waiting for the turn's id (turn/start not answered yet).
  private turnWaiters: Array<() => void> = [];
  // The turn's error (an `error` notification); turn/completed follows.
  private turnError: TurnError | null = null;
  // The panel's turn runs on in a new one of codex's once this fires.
  private capacityRetry: NodeJS.Timeout | null = null;
  private capacityRetries = 0;
  private roomDiscussion = false;
  private compacting = false;
  private recoveryAttempt: RecoveryAttempt | null = null;
  // Only settled proof survives process replacement, and reuse still requires a history read.
  private recoveryProof: CodexRecoveryProof | null = null;
  // The turn was started with a prompt: its first userMessage item is that
  // prompt, any later one a message steered in.
  private awaitingPrompt = false;
  private steers: string[] = [];
  private textEmitted = false;
  private itemText = new Map<string, number>();
  private itemStartedAt = new Map<string, number>();
  private openTools = new Set<string>();
  private context: ContextUsage | null = null;
  private turnContext: ContextUsage | null = null;
  private rateLimits: RateLimitSnapshot | null = null;
  // Codex repeats a warning on every turn (a model without metadata): each
  // is shown once.
  private warned = new Set<string>();
  // Subagent threads by id, as cards of the turn that spawned them.
  private subagents = new Map<
    string,
    { description: string; startedAt: number; lastText: string; done: boolean }
  >();

  private readonly lifecycle: ReturnType<typeof lifecycleWriter>;
  private inputTrigger: InputTrigger = "auto";
  private rootLifecycle: ModelLifecycle = { trigger: "auto" };
  private readonly childLifecycles = new Map<string, ChildLifecycle>();
  private readonly steerTriggers = new Map<string, InputTrigger>();

  private readonly usageThreads = new Map<string, UsageThreadModel>();
  private readonly recordedUsageIds = new Set<string>();

  constructor(
    config: SessionConfig,
    private readonly usageRecorder?: UsageRecorder,
  ) {
    super();
    this.config = config;
    this.lifecycle = lifecycleWriter(config, "codex", () => this.sessionId);
  }

  get isRunning(): boolean {
    return this.busy;
  }

  get runState(): RunState {
    return this.busy ? "working" : "idle";
  }

  get effectiveEffort(): string | null {
    return (
      this.config.effort ?? (this.config.model ? defaultEffortForModel(this.config.model) : null)
    );
  }

  get canSteer(): boolean {
    return !this.capacityRetry;
  }

  get interruptPending(): boolean {
    return this.interruptRequested;
  }

  // Effort, model and Fast are turn/start parameters: they apply from the
  // next turn without touching the process.
  setEffort(level: string): void {
    this.config.effort = level;
  }

  setFastMode(on: boolean): void {
    this.config.fast = on || undefined;
  }

  setModel(model: string, effort: string | undefined, fast: boolean): void {
    this.config.model = model;
    this.config.effort = effort;
    this.config.fast = fast || undefined;
  }

  setGoal(goal: string | null): void {
    this.config.goal = goal ?? undefined;
  }

  // Codex retains tool declarations in the thread. Refresh project
  // instructions on start/resume, without mutating an active turn.
  setPanelTools(tools: PanelToolset | null): void {
    this.panelTools = tools;
  }

  private launchKey(): string {
    return JSON.stringify(this.config.model ? codexContextWindow(this.config.model) : null);
  }

  private env(): NodeJS.ProcessEnv {
    return applyNonInteractiveGitEnv(codexProcessEnv());
  }

  private connect(requireExistingThread = false): Promise<AppServerClient> {
    if (this.client && !this.client.closed && !this.connecting) {
      return Promise.resolve(this.client);
    }
    if (!this.connecting) {
      const opening = this.open(requireExistingThread);
      this.connecting = opening;
      void opening
        .finally(() => {
          if (this.connecting === opening) this.connecting = null;
        })
        .catch(() => {});
    }
    return this.connecting;
  }

  private async open(requireExistingThread: boolean): Promise<AppServerClient> {
    const key = this.launchKey();
    const env = this.env();
    const transport =
      CodexSession.hooks?.transport?.(this, env) ?? spawnAppServer({ cwd: this.config.cwd, env });
    const client: AppServerClient = new AppServerClient(transport, {
      notification: (method, params, emittedAtMs) => {
        if (client === this.client) this.onNotification(method, params, emittedAtMs);
      },
      // A process being shut down calls no panel tool any more.
      request: (method, params) =>
        client === this.client
          ? this.onRequest(method, params)
          : Promise.reject(new Error("This session's app-server is shutting down.")),
      close: (reason) => this.onClose(client, reason),
    });
    this.client = client;
    try {
      await client.initialize();
      const opened = await this.openThread(client, requireExistingThread);
      const { threadId } = opened;
      if (client !== this.client) throw new Error("The app-server was replaced while starting.");
      if (this.usageRecorder || this.lifecycle) {
        if (this.sessionId !== threadId) {
          this.usageThreads.clear();
          this.childLifecycles.clear();
        }
        this.usageThreads.set(threadId, {
          model: opened.model,
          modelProvider: opened.modelProvider,
        });
      }
      this.sessionId = threadId;
    } catch (e) {
      if (this.client === client) this.client = null;
      client.close();
      throw e;
    }
    this.launched = key;
    return client;
  }

  private threadParams(): Record<string, unknown> {
    const model = this.config.model;
    const window = model ? codexContextWindow(model) : null;
    return {
      cwd: this.config.cwd,
      ...(model && { model: codexModelId(model) }),
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      serviceTier: this.serviceTier(),
      ...(window && { config: { model_context_window: window } }),
    };
  }

  private async openThread(
    client: AppServerClient,
    requireExistingThread: boolean,
  ): Promise<UsageThreadModel & { threadId: string }> {
    const threadId = this.sessionId;
    if (threadId) {
      try {
        const res = await client.request<OpenThreadResponse>("thread/resume", {
          threadId,
          ...this.threadParams(),
          ...(this.panelTools && { developerInstructions: this.panelTools.instructions }),
          excludeTurns: true,
        });
        if (requireExistingThread && res?.thread?.id !== threadId)
          throw new Error("Could not verify the resumed Codex thread for recovery");
        return { threadId, model: res?.model, modelProvider: res?.modelProvider };
      } catch (e) {
        if (
          requireExistingThread ||
          !(e instanceof RpcRequestError) ||
          !THREAD_GONE.test(e.message)
        )
          throw e;
        this.emit("event", {
          kind: "notice",
          level: "warning",
          content: `The Codex thread could not be resumed (${e.message}); this is a fresh thread without the earlier conversation.`,
        });
      }
    }
    if (requireExistingThread) throw new Error("Missing Codex thread for recovery");
    const res = await client.request<OpenThreadResponse>("thread/start", {
      ...this.threadParams(),
      ...(this.panelTools && {
        developerInstructions: this.panelTools.instructions,
        dynamicTools: [this.panelNamespace(this.panelTools)],
      }),
    });
    return { threadId: res.thread.id, model: res.model, modelProvider: res.modelProvider };
  }

  private panelNamespace(tools: PanelToolset): Record<string, unknown> {
    return {
      type: "namespace",
      name: PANEL_NAMESPACE,
      description: "The agent-team panel: its projects, sessions and board.",
      tools: tools.tools.map((t) => {
        const { $schema: _, ...schema } = z.toJSONSchema(z.object(t.shape));
        return { type: "function", name: t.name, description: t.description, inputSchema: schema };
      }),
    };
  }

  private serviceTier(): string {
    const tier = this.config.fast && this.config.model ? codexFastTier(this.config.model) : null;
    // Explicit either way: the user's config.toml may name a tier of its own.
    return tier ?? "default";
  }

  private turnParams(): Record<string, unknown> {
    const model = this.config.model;
    return {
      ...(model && { model: codexModelId(model) }),
      ...(this.config.effort && { effort: this.config.effort }),
      serviceTier: this.serviceTier(),
      // gpt-6 models default to no reasoning summary at all.
      summary: "detailed",
    };
  }

  async send(input: string | PromptEnvelope, hooks?: SendHooks): Promise<SendReceipt | void> {
    if (this.busy) throw new Error("Session is busy");
    const message = typeof input === "string" ? input : input.text;
    const panelContext = typeof input === "string" ? undefined : input.panelContext;
    const compact = panelContext === undefined && message.trim() === "/compact";
    // Paired manual input is a fresh human turn. Workspace supplies only
    // new panel context, so send both items as supplied without a proof gate.
    const recovery =
      typeof input !== "string" &&
      panelContext === undefined &&
      input.trigger === "system" &&
      input.inputId === input.reportId
        ? input.recovery
        : undefined;
    const previous = recovery?.supersedes.length ? this.recoveryProof : null;
    let texts = panelContext === undefined ? [message] : [panelContext, message];
    if (recovery?.supersedes.length) {
      if (
        !previous ||
        previous.threadId !== this.sessionId ||
        previous.outageId !== recovery.outageId ||
        recovery.supersedes.at(-1) !== previous.inputId ||
        typeof recovery.delta !== "string" ||
        compact
      ) {
        return RECOVERY_REJECTED;
      }
      texts = recovery.delta ? [recovery.delta] : [];
    } else if (recovery?.delta !== undefined) return RECOVERY_REJECTED;
    if (!previous) this.recoveryProof = null;
    this.beginTurn(!compact && texts.length > 0);
    this.inputTrigger = typeof input === "string" ? "user" : (input.trigger ?? "user");
    this.roomDiscussion = typeof input !== "string" && input.roomDiscussion === true;
    this.rootLifecycle.trigger = this.inputTrigger;
    this.compacting = compact;
    // A turn stopped and replaced meanwhile: what this one's requests do
    // later is not the new turn's.
    const generation = this.generation;
    let writeClaimed = false;
    try {
      if (this.client && this.launched !== this.launchKey()) this.closeProcess();
      const client = await this.connect(!!previous);
      if (generation !== this.generation)
        return { disposition: "rejected", error: "Codex dispatch cancelled" };
      if (previous) {
        const safe = await this.isLastFailedRecovery(client, previous).catch(() => false);
        if (
          !safe ||
          this.recoveryProof !== previous ||
          client !== this.client ||
          client.closed ||
          this.sessionId !== previous.threadId ||
          generation !== this.generation ||
          !this.busy ||
          this.turnId ||
          this.interruptRequested
        ) {
          if (this.recoveryProof === previous) this.recoveryProof = null;
          if (generation === this.generation && this.busy && !this.turnId) this.endTurn();
          return RECOVERY_REJECTED;
        }
        // Workspace persists this consumed proof before it allows the write.
        this.recoveryProof = null;
      }
      hooks?.onBeforeWrite?.({
        inputId: typeof input === "string" ? "codex" : input.inputId,
        reportId: typeof input === "string" ? undefined : input.reportId,
        generation,
        beforeLeafId: null,
        beforeEntryCount: 0,
        startedAt: Date.now(),
      });
      writeClaimed = true;
      const threadId = this.sessionId;
      if (compact) {
        await client.request("thread/compact/start", { threadId });
      } else {
        if (recovery && typeof input !== "string") {
          this.recoveryAttempt = {
            outageId: recovery.outageId,
            inputId: input.inputId,
            textHash: texts.length ? recoveryTextHash(texts[0]) : null,
          };
        }
        await this.startTurn(client, texts, generation, this.recoveryAttempt);
      }
    } catch (e) {
      if (previous && this.recoveryProof === previous) this.recoveryProof = null;
      if (generation === this.generation && this.busy) {
        this.failTurn(e instanceof Error ? e.message : String(e));
      }
      if (hooks) {
        // A negative RPC response is definitive. A lost response after the
        // write claim cannot tell us whether the server took the turn.
        if (!writeClaimed || e instanceof RpcRequestError)
          return { disposition: "rejected", error: e instanceof Error ? e.message : String(e) };
        throw e;
      }
    }
  }

  private async isLastFailedRecovery(
    client: AppServerClient,
    proof: CodexRecoveryProof,
  ): Promise<boolean> {
    const page = await client.request<{
      data: Array<CodexTurn & { items: ThreadItem[]; itemsView: string }>;
    }>("thread/turns/list", { threadId: proof.threadId, limit: 1, itemsView: "full" });
    if (!Array.isArray(page?.data) || page.data.length !== 1) return false;
    const [last] = page.data;
    if (
      last?.id !== proof.turnId ||
      last.status !== "failed" ||
      last.itemsView !== "full" ||
      !Array.isArray(last.items)
    )
      return false;
    if (!proof.userItem) return last.items.length === 0;
    const [item] = last.items;
    return (
      last.items.length === 1 &&
      item?.id === proof.userItem.id &&
      matchesRecoveryUserItem(item, proof.inputId, proof.userItem.textHash)
    );
  }

  private async startTurn(
    client: AppServerClient,
    texts: string[],
    generation: number,
    recovery: RecoveryAttempt | null = null,
  ) {
    const res = await client.request<{ turn: CodexTurn }>("turn/start", {
      threadId: this.sessionId,
      ...(recovery?.textHash && { clientUserMessageId: recovery.inputId }),
      input: texts.map((text) => ({ type: "text", text, text_elements: [] })),
      ...this.turnParams(),
    });
    if (recovery && recovery === this.recoveryAttempt && res.turn.status === "inProgress")
      recovery.acknowledgedTurnId = res.turn.id;
    if (generation === this.generation && !this.turnId && res.turn.status === "inProgress") {
      this.turnId = res.turn.id;
      this.releaseTurnWaiters();
    }
  }

  private retryAfterCapacity(error: TurnError): boolean {
    const delays = CodexSession.hooks?.capacityRetryDelaysMs ?? CAPACITY_RETRY_DELAYS_MS;
    if (
      this.roomDiscussion ||
      this.compacting ||
      this.interruptRequested ||
      this.capacityRetries >= delays.length
    ) {
      return false;
    }
    const delay = delays[this.capacityRetries++];
    this.emit("event", {
      kind: "retry",
      content: `${error.message} Retrying in ${Math.ceil(delay / 1000)}s (${this.capacityRetries}/${delays.length}).`,
    });
    this.turnId = null;
    this.turnContext = null;
    this.turnStarted = false;
    this.interruptSent = false;
    this.turnError = null;
    this.inputTrigger = "auto";
    this.rootLifecycle = { trigger: "auto" };
    // Dropped with the failed turn, like a stopped one's: the queue runs them.
    const unread = this.steers.splice(0);
    if (unread.length) this.emit("unread", unread);
    const generation = this.generation;
    this.capacityRetry = setTimeout(() => void this.carryOn(generation), delay);
    return true;
  }

  private async carryOn(generation: number): Promise<void> {
    this.capacityRetry = null;
    this.awaitingPrompt = true;
    try {
      if (this.client && this.launched !== this.launchKey()) this.closeProcess();
      const client = await this.connect();
      // Not when codex carried on by itself meanwhile.
      if (generation === this.generation && !this.turnId) {
        this.inputTrigger = "retry";
        this.rootLifecycle.trigger = "retry";
        await this.startTurn(client, [CAPACITY_CONTINUE], generation);
      }
    } catch (e) {
      if (generation === this.generation && this.busy) {
        this.failTurn(e instanceof Error ? e.message : String(e));
      }
    }
  }

  // A message for the running turn: false when there is none to take it
  // (it ended meanwhile, or it is one codex does not steer), and the
  // caller sends it as a turn of its own. Taken, it is the model's at its
  // next request: `steered` says when, `unread` at the turn's end that it
  // never came.
  async steer(message: string, inputId: string, trigger: InputTrigger = "user"): Promise<boolean> {
    if (!this.busy || this.interruptRequested || message.trim() === "/compact") return false;
    // No turn to take it for minutes: it waits in the queue instead.
    if (this.capacityRetry) return false;
    const generation = this.generation;
    if (!this.turnId) await new Promise<void>((r) => this.turnWaiters.push(r));
    const client = this.client;
    const turnId = this.turnId;
    if (generation !== this.generation || !turnId || !client || this.interruptRequested) {
      return false;
    }
    // Before the request: its userMessage item can come before the answer.
    this.recoveryAttempt = null;
    this.steers.push(inputId);
    this.steerTriggers.set(inputId, trigger);
    try {
      await client.request("turn/steer", {
        threadId: this.sessionId,
        input: [{ type: "text", text: message, text_elements: [] }],
        expectedTurnId: turnId,
        clientUserMessageId: inputId,
      });
    } catch {
      const i = this.steers.indexOf(inputId);
      if (i >= 0) this.steers.splice(i, 1);
      this.steerTriggers.delete(inputId);
      return false;
    }
    return true;
  }

  // Stops the running turn; the process lives on. False when none runs.
  async interrupt(): Promise<boolean> {
    if (!this.busy) return false;
    if (this.capacityRetry) {
      this.endTurn(this.resultEvent(true));
      return true;
    }
    this.interruptRequested = true;
    await this.sendInterrupt();
    return true;
  }

  // Only once codex started the turn (turn/started): before, there is no
  // turn of its to stop. A failed request leaves the turn running, and a
  // second Stop tries again.
  private async sendInterrupt(): Promise<void> {
    const client = this.client;
    if (!client || !this.turnStarted || !this.turnId || this.interruptSent) return;
    this.interruptSent = true;
    const generation = this.generation;
    try {
      await client.request("turn/interrupt", { threadId: this.sessionId, turnId: this.turnId });
    } catch {
      if (generation !== this.generation) return;
      this.interruptSent = false;
      this.interruptRequested = false;
    }
  }

  private releaseTurnWaiters(): void {
    for (const release of this.turnWaiters.splice(0)) release();
  }

  // Ends the process. A turn it cuts off ends without a terminal event; the
  // workspace closes its message itself.
  abort(): void {
    this.generation++;
    if (this.busy) this.recoveryProof = null;
    this.closeProcess();
    if (this.busy) this.endTurn();
  }

  get deployBusy(): boolean {
    return Boolean(
      this.busy ||
      this.connecting ||
      this.client?.hasPendingRequests ||
      this.panelCalls ||
      this.retiring.size ||
      this.commandsInFlight.size ||
      [...this.subagents.values()].some((card) => !card.done),
    );
  }

  async retireIdleProcess(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.deployBusy) throw new Error("Codex is busy");
    await this.client?.retireProcess();
  }

  async dispose(): Promise<void> {
    this.abort();
    await Promise.all(this.retiring);
  }

  private closeProcess(): void {
    const client = this.client;
    this.client = null;
    this.connecting = null;
    this.stopSubagents();
    this.commandsInFlight.clear();
    if (client?.exited && !client.closed) {
      const exited = client.exited;
      this.retiring.add(exited);
      void exited.then(() => this.retiring.delete(exited));
    }
    client?.close();
  }

  private onClose(client: AppServerClient, reason: string): void {
    if (client !== this.client) return;
    if (this.busy) this.recoveryProof = null;
    this.client = null;
    this.stopSubagents();
    this.commandsInFlight.clear();
    if (this.busy) this.failTurn(reason);
  }

  private beginTurn(withPrompt: boolean): void {
    this.generation++;
    this.busy = true;
    this.turnId = null;
    this.turnContext = null;
    this.turnStarted = false;
    this.turnStartedAt = Date.now();
    this.interruptRequested = false;
    this.interruptSent = false;
    this.turnError = null;
    this.recoveryAttempt = null;
    this.capacityRetries = 0;
    this.roomDiscussion = false;
    this.compacting = false;
    this.awaitingPrompt = withPrompt;
    this.steers = [];
    this.steerTriggers.clear();
    this.inputTrigger = "auto";
    this.rootLifecycle = { trigger: "auto" };
    this.textEmitted = false;
    this.itemText.clear();
    this.itemStartedAt.clear();
    this.openTools.clear();
    this.emit("runState", "working");
  }

  // busy clears before the terminal event: the workspace moves its queue
  // on that event and checks isRunning.
  private endTurn(terminal?: StreamEvent): void {
    if (terminal?.kind === "error" && this.turnStarted && !this.compacting)
      terminal.context = this.turnContext;
    if (terminal?.context !== undefined) this.context = terminal.context;
    this.busy = false;
    this.recoveryAttempt = null;
    clearTimeout(this.capacityRetry ?? undefined);
    this.capacityRetry = null;
    this.turnId = null;
    this.interruptRequested = false;
    this.usage.turns++;
    this.usage.duration_ms += Date.now() - this.turnStartedAt;
    this.releaseTurnWaiters();
    const unread = this.steers.splice(0);
    if (unread.length) this.emit("unread", unread);
    if (terminal) this.emit("event", terminal);
    this.emit("runState", "idle");
  }

  private failTurn(message: string): void {
    this.closeTools("(stopped)");
    // Process/RPC failures do not establish what the remote model or its tools did.
    this.endTurn({ kind: "error", content: `[Codex error] ${message}` });
  }

  // Calls the turn left without a completion: an interrupted command gets
  // no item/completed (codex/interrupt).
  private closeTools(content: string): void {
    for (const id of this.openTools) {
      this.emit("event", { kind: "tool_result", content, toolUseId: id, isError: true });
    }
    this.openTools.clear();
  }

  // The process is gone, and the subagents it ran with it.
  private stopSubagents(): void {
    for (const [taskId, card] of this.subagents) {
      if (card.done) continue;
      card.done = true;
      this.emit("event", {
        kind: "subagent_done",
        content: "",
        subagent: {
          taskId,
          description: card.description,
          status: "stopped",
          durationMs: Date.now() - card.startedAt,
        },
      });
    }
  }

  private completeTurn(turn: CodexTurn): void {
    if (!this.busy || (this.turnId && turn.id !== this.turnId)) return;
    if (turn.status === "interrupted") {
      this.closeTools("(interrupted)");
      this.endTurn(this.resultEvent(true));
      return;
    }
    if (turn.status === "failed") {
      const error = turn.error ?? this.turnError;
      const recovery = this.recoveryAttempt;
      this.recoveryAttempt = null;
      if (
        recovery &&
        this.client &&
        this.sessionId &&
        this.turnStarted &&
        turn.id === recovery.acknowledgedTurnId &&
        (recovery.textHash === null || recovery.userItemId) &&
        !this.interruptRequested &&
        turn.error &&
        classifyNetworkFailure({
          backend: "codex",
          codexErrorInfo: turn.error.codexErrorInfo,
          errorMessage: turn.error.message,
        }) === "transient"
      ) {
        this.recoveryProof = {
          outageId: recovery.outageId,
          inputId: recovery.inputId,
          threadId: this.sessionId,
          turnId: turn.id,
          userItem:
            recovery.textHash && recovery.userItemId
              ? { id: recovery.userItemId, textHash: recovery.textHash }
              : null,
        };
      }
      this.closeTools("(stopped)");
      if (error?.codexErrorInfo === "usageLimitExceeded") {
        this.endTurn(this.refused(error));
        return;
      }
      if (error?.codexErrorInfo === "serverOverloaded" && this.retryAfterCapacity(error)) return;
      this.endTurn(
        codexTerminalError(
          `[Codex error] ${errorText(error?.message)}`,
          error?.message,
          error?.codexErrorInfo ?? this.turnError?.codexErrorInfo,
        ),
      );
      return;
    }
    this.closeTools("(no result)");
    this.endTurn(this.resultEvent(false));
  }

  private resultEvent(interrupted: boolean): StreamEvent {
    return {
      kind: "result",
      content: "",
      ...(!(interrupted && this.compacting) && { context: this.turnContext }),
      effort: this.effectiveEffort ?? undefined,
      ...(interrupted && { interrupted: true }),
    };
  }

  // Quota has its own native reset/future account-failover path, not network backoff.
  // A turn the usage limit refused (codex/usage-limit): the limit's window
  // and reset come in the account/rateLimits/updated sent just before.
  private refused(error: TurnError): StreamEvent {
    const spent = [this.rateLimits?.primary, this.rateLimits?.secondary]
      .filter((w): w is RateLimitWindow => !!w && w.usedPercent >= 100)
      .sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
    const rateLimitType = spent ? windowType(spent) : undefined;
    const resetsAt = spent?.resetsAt ?? undefined;
    this.emit("rateLimit", { rateLimitType, resetsAt });
    const label = rateLimitType ? ` (${rateLimitType.replace(/_/g, "-")})` : "";
    const reset = resetsAt
      ? ` Resets at ${new Date(resetsAt * 1000).toLocaleString("en-US")}.`
      : "";
    return {
      kind: "error",
      content: spent ? `Usage limit reached${label}.${reset}` : `[Codex error] ${error.message}`,
    };
  }

  private onRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.recoveryAttempt = null;
    this.recoveryProof = null;
    if (method === "item/tool/call") {
      this.panelCalls++;
      this.emit("deploy_activity");
      return this.callTool(params as unknown as DynamicToolCallParams).finally(
        () => this.panelCalls--,
      );
    }
    return Promise.reject(new Error(`agent-team does not answer ${method}`));
  }

  private async callTool(call: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const reply = (text: string, success: boolean): DynamicToolCallResponse => ({
      contentItems: [{ type: "inputText", text }],
      success,
    });
    const tool =
      call.namespace === PANEL_NAMESPACE && call.threadId === this.sessionId
        ? this.panelTools?.tools.find((t) => t.name === call.tool)
        : undefined;
    if (!tool) return reply(`${call.tool} is not available to this session.`, false);
    const args = z.object(tool.shape).safeParse(call.arguments ?? {});
    if (!args.success) return reply(z.prettifyError(args.error), false);
    try {
      return reply(await tool.handler(args.data, undefined, call.callId), true);
    } catch (e) {
      return reply(e instanceof Error ? e.message : String(e), false);
    }
  }

  private onNotification(
    method: string,
    params: Record<string, unknown>,
    emittedAtMs?: number,
  ): void {
    const threadId = params.threadId as string | undefined;
    const root = threadId === this.sessionId;
    const child = threadId && !root ? this.childLifecycles.get(threadId) : undefined;
    const lifecycle = this.lifecycle ? (root ? this.rootLifecycle : child) : undefined;
    const item = params.item as ThreadItem | undefined;
    if (this.recoveryAttempt || this.recoveryProof) {
      this.observeRecovery(method, params, root, item);
    }
    const isDelta =
      method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta";
    const step = lifecycle?.step;
    if (isDelta && step && !step.firstDelta && threadId) {
      this.noteLifecycleDelta(threadId, step, params);
    }
    const lifecycleAt =
      lifecycle && method === "thread/tokenUsage/updated" ? Date.now() : undefined;
    if (
      lifecycle &&
      threadId &&
      (method === "turn/started" ||
        method === "turn/completed" ||
        method === "item/started" ||
        method === "item/completed")
    ) {
      this.noteLifecycleBoundary(threadId, lifecycle, method, params, item, child);
    }
    if (item?.type === "commandExecution") {
      if (method === "item/started") this.commandsInFlight.add(item.id);
      if (method === "item/completed") this.commandsInFlight.delete(item.id);
    }
    if (method === "turn/started" || method === "item/started") this.emit("deploy_activity");
    if (threadId && (this.usageRecorder || this.lifecycle) && this.usageThreads.has(threadId)) {
      if (
        (method === "item/started" || method === "item/completed") &&
        item?.type === "subAgentActivity" &&
        typeof item.agentThreadId === "string" &&
        item.agentThreadId &&
        !this.usageThreads.has(item.agentThreadId)
      ) {
        this.usageThreads.set(item.agentThreadId, {});
        if (this.lifecycle) this.childLifecycles.set(item.agentThreadId, { trigger: "subagent" });
      } else if (method === "thread/settings/updated") {
        const settings = params.threadSettings as UsageThreadModel | undefined;
        if (settings) this.usageThreads.set(threadId, settings);
      } else if (method === "thread/tokenUsage/updated") {
        this.recordTokenUsage(
          threadId,
          params.turnId,
          params.tokenUsage,
          emittedAtMs,
          lifecycleAt,
          lifecycle,
          child,
        );
      } else if (item && (method === "item/started" || method === "item/completed")) {
        this.recordUsageItem(threadId, params, item, method, emittedAtMs);
      }
    }
    if (threadId && !root) {
      this.onSubagentNotification(threadId, method, params);
      return;
    }
    switch (method) {
      case "turn/started": {
        const turn = params.turn as CodexTurn;
        if (!this.busy) {
          // A turn codex started itself (a goal carrying on).
          this.beginTurn(false);
          this.emit("event", { kind: "notice", level: "wakeup", content: "Codex carried on" });
        }
        clearTimeout(this.capacityRetry ?? undefined);
        this.capacityRetry = null;
        if (this.turnId !== turn.id) this.turnContext = null;
        this.turnId = turn.id;
        this.turnStarted = true;
        this.releaseTurnWaiters();
        if (this.interruptRequested) void this.sendInterrupt();
        break;
      }
      case "turn/completed":
        this.completeTurn(params.turn as CodexTurn);
        break;
      case "item/started":
        if (item?.type === "contextCompaction" && this.matchesTurn(params.turnId))
          this.turnContext = null;
        this.itemStarted(params.item as ThreadItem);
        break;
      case "item/completed":
        if (item?.type === "contextCompaction") {
          if (!this.matchesTurn(params.turnId)) break;
          // The compacted-context update can arrive before item/completed (codex/resume).
          this.context = this.turnContext;
          this.emit("event", {
            kind: "compact",
            content: "Context compacted",
            context: this.context,
          });
        } else this.itemCompleted(params.item as ThreadItem);
        break;
      case "item/agentMessage/delta":
        this.text(params.itemId as string, params.delta as string);
        break;
      case "item/reasoning/summaryTextDelta": {
        const itemId = params.itemId as string;
        const startedAt = this.itemStartedAt.get(itemId) ?? Date.now();
        this.itemStartedAt.set(itemId, startedAt);
        this.emit("event", { kind: "thinking_delta", content: params.delta as string, startedAt });
        break;
      }
      case "thread/tokenUsage/updated":
        this.noteTokens(params.tokenUsage as ThreadTokenUsage, params.turnId);
        break;
      case "account/rateLimits/updated":
        this.noteRateLimits(params.rateLimits as RateLimitSnapshot);
        break;
      case "error": {
        const error = params.error as TurnError;
        if (params.willRetry) this.emit("event", { kind: "retry", content: error.message });
        else this.turnError = error;
        break;
      }
      case "turn/plan/updated": {
        const plan = (params.plan as Array<{ step: string; status: string }>) ?? [];
        const lines = plan.map((p) => `- [${p.status === "completed" ? "x" : " "}] ${p.step}`);
        if (lines.length) {
          this.emit("event", {
            kind: "notice",
            level: "info",
            content: `**Plan**\n${lines.join("\n")}`,
          });
        }
        break;
      }
      case "warning":
        if (threadId && !this.warned.has(params.message as string)) {
          this.warned.add(params.message as string);
          this.emit("event", {
            kind: "notice",
            level: "warning",
            content: `Codex: ${params.message as string}`,
          });
        }
        break;
    }
  }

  private observeRecovery(
    method: string,
    params: Record<string, unknown>,
    root: boolean,
    item: ThreadItem | undefined,
  ): void {
    const attempt = this.recoveryAttempt;
    if (method === "turn/started") {
      this.recoveryProof = null;
      if (!root || this.turnStarted) this.recoveryAttempt = null;
      return;
    }
    if (
      root &&
      attempt &&
      attempt.textHash !== null &&
      this.matchesTurn(params.turnId) &&
      (method === "item/started" || method === "item/completed") &&
      item &&
      matchesRecoveryUserItem(item, attempt.inputId, attempt.textHash) &&
      (!attempt.userItemId || attempt.userItemId === item.id)
    ) {
      attempt.userItemId = item.id;
      return;
    }
    const status = params.status as { type?: unknown } | undefined;
    if (method === "thread/status/changed" && root && status?.type === "active") {
      this.recoveryProof = null;
    }
    const usage = params.tokenUsage as ThreadTokenUsage | undefined;
    if (
      method.startsWith("item/") ||
      method.startsWith("rawResponseItem/") ||
      method === "turn/plan/updated" ||
      method === "turn/diff/updated" ||
      (method === "thread/tokenUsage/updated" &&
        (usage?.last?.outputTokens !== 0 || usage?.last?.reasoningOutputTokens !== 0))
    ) {
      this.recoveryAttempt = null;
      this.recoveryProof = null;
    }
  }

  private noteLifecycleBoundary(
    threadId: string,
    lifecycle: ModelLifecycle,
    method: string,
    params: Record<string, unknown>,
    item: ThreadItem | undefined,
    child: ChildLifecycle | undefined,
  ): void {
    const write = this.lifecycle!;
    if (method === "turn/started") {
      const turnId = (params.turn as CodexTurn).id;
      if (lifecycle.step?.turnId !== turnId) lifecycle.step = undefined;
      if (child && child.turnId !== turnId) {
        child.turnId = turnId;
        child.trigger = "subagent";
      }
      return;
    }
    if (method === "turn/completed") {
      const turnId = (params.turn as CodexTurn).id;
      if (lifecycle.step?.turnId === turnId) {
        write(
          { turnId, stepId: lifecycle.step.id, kind: "model", marker: "stepEnd", at: Date.now() },
          threadId,
        );
        lifecycle.step = undefined;
      }
      if (child?.turnId === turnId) child.turnId = undefined;
      return;
    }
    const turnId = params.turnId;
    if (!item || typeof turnId !== "string" || !turnId) return;
    const stepId = item.id;
    const started = method === "item/started";
    switch (item.type) {
      case "userMessage":
        if (started && this.matchesLifecycleTurn(turnId, child)) {
          const trigger = child
            ? "subagent"
            : this.awaitingPrompt
              ? this.inputTrigger
              : (item.clientId && this.steerTriggers.get(item.clientId)) || "system";
          lifecycle.trigger = trigger;
          write(
            { turnId, stepId, kind: "user", marker: "stepEnd", trigger, at: Date.now() },
            threadId,
          );
        }
        return;
      case "contextCompaction":
        if (!started)
          write(
            {
              turnId,
              stepId,
              kind: "compaction",
              marker: "compaction",
              at: Date.now(),
              ...(child
                ? { trigger: "subagent" }
                : this.compacting && this.matchesTurn(turnId)
                  ? { trigger: this.inputTrigger }
                  : {}),
            },
            threadId,
          );
        return;
      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
      case "dynamicToolCall":
      case "webSearch":
      case "imageView":
      case "collabAgentToolCall":
        // A command may complete after the next turn starts. Keep its native turn ID.
        write(
          {
            turnId,
            stepId,
            toolCallId: stepId,
            kind: "tool",
            marker: started ? "toolStart" : "toolResult",
            at: Date.now(),
          },
          threadId,
        );
        return;
      case "agentMessage":
      case "reasoning":
        if (started && this.matchesLifecycleTurn(turnId, child)) {
          if (lifecycle.step?.turnId === turnId) {
            lifecycle.step.itemIds.add(stepId);
          } else {
            lifecycle.step = { turnId, id: stepId, itemIds: new Set([stepId]), firstDelta: false };
            write(
              {
                turnId,
                stepId,
                kind: "model",
                marker: "stepStart",
                at: Date.now(),
                trigger: lifecycle.trigger,
              },
              threadId,
            );
          }
        }
        return;
    }
  }

  private matchesLifecycleTurn(turnId: string, child: ChildLifecycle | undefined): boolean {
    return child ? child.turnId === turnId : this.matchesTurn(turnId);
  }

  private noteLifecycleDelta(
    threadId: string,
    step: NonNullable<ModelLifecycle["step"]>,
    params: Record<string, unknown>,
  ): void {
    const { turnId, itemId, delta } = params;
    // A delta for an old output item cannot open a step or start its timer.
    if (
      turnId !== step.turnId ||
      typeof itemId !== "string" ||
      !step.itemIds.has(itemId) ||
      typeof delta !== "string" ||
      !delta
    )
      return;
    step.firstDelta = true;
    this.lifecycle?.(
      { turnId, stepId: step.id, kind: "model", marker: "firstDelta", at: Date.now() },
      threadId,
    );
  }

  // Several agent messages in a turn are paragraphs of one reply.
  private text(itemId: string, delta: string): void {
    if (!delta) return;
    const sent = this.itemText.get(itemId);
    const lead = sent === undefined && this.textEmitted ? "\n\n" : "";
    this.itemText.set(itemId, (sent ?? 0) + delta.length);
    this.textEmitted = true;
    this.emit("event", { kind: "text_delta", content: lead + delta });
  }

  private toolUse(item: ThreadItem, toolName: string, content: string): void {
    this.openTools.add(item.id);
    const startedAt = Date.now();
    this.itemStartedAt.set(item.id, startedAt);
    this.emit("event", { kind: "tool_use", toolName, content, toolUseId: item.id, startedAt });
  }

  private toolResult(
    item: ThreadItem,
    content: string,
    isError = false,
    durationMs?: number | null,
  ): void {
    if (!this.openTools.delete(item.id)) return;
    const started = this.itemStartedAt.get(item.id);
    this.emit("event", {
      kind: "tool_result",
      content,
      toolUseId: item.id,
      ...(isError && { isError: true }),
      durationMs: durationMs ?? (started !== undefined ? Date.now() - started : undefined),
    });
  }

  private itemStarted(item: ThreadItem): void {
    switch (item.type) {
      case "userMessage": {
        if (this.awaitingPrompt) {
          this.awaitingPrompt = false;
          break;
        }
        // Tagged with the panel's id, or untagged and taken in order sent.
        const i = item.clientId ? this.steers.indexOf(item.clientId) : 0;
        const [inputId] = i >= 0 ? this.steers.splice(i, 1) : [];
        if (!inputId) break;
        this.steerTriggers.delete(inputId);
        // What follows answers the steered message: a reply of its own.
        this.textEmitted = false;
        this.emit("steered", inputId);
        break;
      }
      case "reasoning": {
        const startedAt = Date.now();
        this.itemStartedAt.set(item.id, startedAt);
        this.emit("event", { kind: "thinking_delta", content: "", startedAt });
        break;
      }
      case "commandExecution":
        this.toolUse(item, "Bash", `**Bash**\n${fenced(commandText(item), "bash")}`);
        break;
      case "fileChange":
        this.toolUse(item, "Edit", `**Edit**\n${fenced(changeList(item.changes))}`);
        break;
      case "mcpToolCall":
        this.toolUse(item, "MCP", `**MCP** \`${item.server}.${item.tool}\``);
        break;
      case "dynamicToolCall": {
        const name = item.namespace === PANEL_NAMESPACE ? `mcp__panel__${item.tool}` : item.tool;
        const input = (item.arguments ?? {}) as Record<string, unknown>;
        this.toolUse(item, name, formatToolUse({ name, input }));
        break;
      }
      case "webSearch":
        this.toolUse(item, "WebSearch", `**WebSearch** ${item.query}`);
        break;
      case "imageView":
        this.toolUse(item, "ViewImage", `**ViewImage** \`${item.path}\``);
        break;
      case "collabAgentToolCall":
        this.toolUse(
          item,
          "Agent",
          `**Agent** ${item.tool}${item.prompt ? `\n\n> ${item.prompt}` : ""}`,
        );
        break;
      case "subAgentActivity":
        this.subagentActivity(item);
        break;
    }
  }

  private itemCompleted(item: ThreadItem): void {
    switch (item.type) {
      case "agentMessage": {
        // The text deltas did not carry: the rest of the item's text.
        const rest = item.text.slice(this.itemText.get(item.id) ?? 0);
        if (rest.trim()) this.text(item.id, rest);
        break;
      }
      case "reasoning": {
        const text = (item.summary.length ? item.summary : item.content).join("\n\n").trim();
        const started = this.itemStartedAt.get(item.id);
        this.itemStartedAt.delete(item.id);
        const durationMs = started == null ? undefined : Date.now() - started;
        if (text) this.emit("event", { kind: "thinking", content: text, durationMs });
        else if (durationMs != null)
          this.emit("event", { kind: "thinking_delta", content: "", durationMs });
        break;
      }
      case "commandExecution": {
        const exit = item.exitCode ?? 0;
        const status = exit === 0 ? "" : ` (exit code ${exit})`;
        const output = item.aggregatedOutput ?? "";
        this.toolResult(
          item,
          `${output || (status ? "" : "(no output)")}${status}`,
          false,
          item.durationMs,
        );
        break;
      }
      case "fileChange":
        this.toolResult(
          item,
          item.status === "completed" ? "applied" : item.status,
          item.status !== "completed",
        );
        break;
      case "mcpToolCall":
        this.toolResult(
          item,
          item.error
            ? `Error: ${item.error.message}`
            : JSON.stringify(item.result?.structuredContent ?? item.result?.content ?? "done"),
          !!item.error,
          item.durationMs,
        );
        break;
      case "dynamicToolCall": {
        const text = (item.contentItems ?? []).map((c) => c.text ?? "").join("\n");
        this.toolResult(item, text, item.success === false, item.durationMs);
        break;
      }
      case "imageView":
        // The path on the call is the useful payload; the empty result still
        // settles its timer and pairs with the tool_use in every projection.
        this.toolResult(item, "");
        break;
      case "webSearch":
      case "collabAgentToolCall":
        this.toolResult(item, "done");
        break;
    }
  }

  // A subagent's card: its spawn starts it, its end ends it, and its
  // thread's items are the card's events. A subagent sent more work is the
  // same card going on.
  private subagentActivity(item: Extract<ThreadItem, { type: "subAgentActivity" }>): void {
    const taskId = item.agentThreadId;
    const description = item.agentPath.split("/").filter(Boolean).at(-1) ?? item.agentPath;
    const known = this.subagents.get(taskId);
    if (item.kind === "started" && !known) {
      this.subagents.set(taskId, { description, startedAt: Date.now(), lastText: "", done: false });
      this.emit("event", {
        kind: "subagent_start",
        content: description,
        subagent: {
          taskId,
          description,
          agentType: "subagent",
          taskType: "local_agent",
          status: "running",
          events: [],
        },
      });
    } else if ((item.kind === "completed" || item.kind === "interrupted") && known) {
      known.done = true;
      this.emit("event", {
        kind: "subagent_done",
        content: "",
        subagent: {
          taskId,
          description,
          status: item.kind === "completed" ? "completed" : "stopped",
          durationMs: Date.now() - known.startedAt,
          ...(known.lastText && { summary: known.lastText }),
        },
      });
    }
  }

  private onSubagentNotification(
    threadId: string,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const card = this.subagents.get(threadId);
    if (!card) return;
    const inner = (event: StreamEvent) =>
      this.emit("event", {
        kind: "subagent_progress",
        content: "",
        subagent: { taskId: threadId, description: "", _innerEvent: event },
      });
    const item = params.item as ThreadItem | undefined;
    if (method === "item/completed" && item?.type === "agentMessage" && item.text.trim()) {
      card.lastText = item.text.trim();
      inner({ kind: "text", content: card.lastText });
    } else if (method === "item/started" && item?.type === "commandExecution") {
      inner({
        kind: "tool_use",
        toolName: "Bash",
        content: `**Bash**\n${fenced(commandText(item), "bash")}`,
        toolUseId: item.id,
        startedAt: Date.now(),
      });
    } else if (method === "item/completed" && item?.type === "commandExecution") {
      inner({
        kind: "tool_result",
        content: item.aggregatedOutput || "(no output)",
        toolUseId: item.id,
      });
    }
  }

  private recordUsageItem(
    sessionId: string,
    params: Record<string, unknown>,
    item: ThreadItem,
    method: "item/started" | "item/completed",
    emittedAtMs: number | undefined,
  ): void {
    const turnId = params.turnId;
    if (typeof turnId !== "string" || !turnId || typeof item.id !== "string" || !item.id) return;
    const compaction = item.type === "contextCompaction";
    if (method !== (compaction ? "item/completed" : "item/started")) return;
    const name = codexJourneyItemName(item);
    if (!name) return;
    const itemTimestamp = compaction ? params.completedAtMs : params.startedAtMs;
    this.usageRecorder?.recordJourney({
      id: JSON.stringify(["codex", sessionId, turnId, item.id]),
      source: "codex",
      sessionId,
      turnId,
      timestamp: nativeTimestamp(itemTimestamp) ?? nativeTimestamp(emittedAtMs),
      kind: compaction ? "compaction" : "tool",
      name,
    });
  }

  private recordTokenUsage(
    threadId: string,
    turnId: unknown,
    rawUsage: unknown,
    emittedAtMs: number | undefined,
    lifecycleAt: number | undefined,
    lifecycle: ModelLifecycle | undefined,
    child: ChildLifecycle | undefined,
  ): void {
    const usage = rawUsage as Partial<ThreadTokenUsage> | undefined;
    const last = usage?.last;
    const checkpoint = usage?.total?.totalTokens;
    if (typeof turnId !== "string" || !turnId || !last || !isTokenCount(checkpoint)) return;
    const { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens } = last;
    if (
      !isTokenCount(inputTokens) ||
      !isTokenCount(cachedInputTokens) ||
      !isTokenCount(cacheWriteInputTokens) ||
      !isTokenCount(outputTokens) ||
      cachedInputTokens + cacheWriteInputTokens > inputTokens ||
      inputTokens + outputTokens === 0 ||
      checkpoint === 0
    )
      return;

    // In the tools recording each thread's cumulative count advances by its own last
    // sample. Use that checkpoint only as identity, not as additive usage.
    const id = JSON.stringify(["codex", threadId, turnId, checkpoint]);
    if (this.recordedUsageIds.has(id)) return;
    const { model, modelProvider } = this.usageThreads.get(threadId) ?? {};
    this.usageRecorder?.recordUsage({
      id,
      source: "codex",
      sessionId: threadId,
      turnId,
      unit: "inference",
      timestamp: nativeTimestamp(emittedAtMs),
      model: typeof model === "string" ? model : null,
      ...(typeof modelProvider === "string" && modelProvider && { channel: modelProvider }),
      input: inputTokens - cachedInputTokens - cacheWriteInputTokens,
      cacheRead: cachedInputTokens,
      cacheWrite: cacheWriteInputTokens,
      output: outputTokens,
      price: { kind: "unpriced", usd: null },
    });
    this.recordedUsageIds.add(id);
    if (this.lifecycle && lifecycle && lifecycleAt !== undefined) {
      const active = this.matchesLifecycleTurn(turnId, child);
      const step = lifecycle.step?.turnId === turnId ? lifecycle.step : undefined;
      // A sample can close an inference that has no observable model output item.
      this.lifecycle(
        {
          turnId,
          stepId: step?.id ?? id,
          kind: "model",
          marker: "stepEnd",
          at: lifecycleAt,
          inferenceId: id,
          ...(!step && { trigger: active ? lifecycle.trigger : child && "subagent" }),
          promptTokens: inputTokens,
          ...(typeof model === "string" && { model }),
        },
        threadId,
      );
      if (step) lifecycle.step = undefined;
      if (active) lifecycle.trigger = "continuation";
    }
  }

  private matchesTurn(turnId: unknown): boolean {
    return this.busy && this.turnId !== null && turnId === this.turnId;
  }

  private noteTokens(usage: ThreadTokenUsage, turnId: unknown): void {
    const last = usage.last;
    this.usage.input_tokens += last.inputTokens - last.cachedInputTokens;
    this.usage.output_tokens += last.outputTokens;
    this.usage.cache_read_tokens += last.cachedInputTokens;
    this.usage.cache_creation_tokens += last.cacheWriteInputTokens;
    if (!this.matchesTurn(turnId)) return;
    const { inputTokens, outputTokens, reasoningOutputTokens } = last;
    // Occupancy is estimated from the request input and retained output, not
    // from billing totals. A compact-only update can have no request counts.
    this.turnContext =
      Number.isSafeInteger(inputTokens) &&
      inputTokens > 0 &&
      Number.isSafeInteger(outputTokens) &&
      outputTokens >= 0 &&
      Number.isSafeInteger(reasoningOutputTokens) &&
      reasoningOutputTokens >= 0 &&
      reasoningOutputTokens <= outputTokens
        ? estimatedContext(
            inputTokens + (outputTokens - reasoningOutputTokens),
            usage.modelContextWindow,
          )
        : null;
  }

  // Updates are sparse: a missing window keeps the one seen last.
  private noteRateLimits(update: RateLimitSnapshot): void {
    if (update.limitId && this.rateLimits?.limitId !== update.limitId) this.rateLimits = null;
    this.rateLimits = {
      limitId: update.limitId ?? this.rateLimits?.limitId ?? null,
      primary: update.primary ?? this.rateLimits?.primary ?? null,
      secondary: update.secondary ?? this.rateLimits?.secondary ?? null,
      planType: update.planType ?? this.rateLimits?.planType ?? null,
    };
    this.emit("quota", this.rateLimits, { ...update, limitId: this.rateLimits.limitId });
  }

  getContextUsage(): Promise<Record<string, unknown> | null> {
    const c = this.context;
    if (!c) return Promise.resolve(null);
    return Promise.resolve({
      totalTokens: c.tokens,
      maxTokens: c.window,
      percentage: (c.tokens / c.window) * 100,
      model: this.config.model,
      estimated: c.estimated,
    });
  }

  async getUsageInfo(): Promise<Record<string, unknown> | null> {
    const limits = this.rateLimits ?? (await readCodexRateLimits(this.env()));
    if (!limits) return null;
    const rate_limits: Record<string, unknown> = {};
    for (const w of [limits.primary, limits.secondary]) {
      if (!w) continue;
      rate_limits[windowType(w)] = {
        utilization: w.usedPercent,
        resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : undefined,
      };
    }
    return { rate_limits, ...(limits.planType && { subscription_type: limits.planType }) };
  }

  getState(): SessionState {
    return {
      sessionId: this.sessionId,
      config: { ...this.config },
      usage: { ...this.usage },
      ...(this.recoveryProof && { codexRecoveryProof: structuredClone(this.recoveryProof) }),
    };
  }

  static fromState(state: SessionState, usageRecorder?: UsageRecorder): CodexSession {
    const session = new CodexSession(state.config, usageRecorder);
    session.sessionId = state.sessionId;
    session.usage = { ...state.usage };
    const proof = codexRecoveryProof.safeParse(state.codexRecoveryProof);
    if (proof.success && proof.data.threadId === state.sessionId)
      session.recoveryProof = proof.data;
    return session;
  }
}

function nativeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function codexJourneyItemName(item: ThreadItem): string | undefined {
  switch (item.type) {
    case "contextCompaction":
      return "contextCompaction";
    case "commandExecution":
      return "Bash";
    case "fileChange":
      return "Edit";
    case "mcpToolCall":
      return `${item.server}.${item.tool}`;
    case "dynamicToolCall":
      return item.namespace ? `${item.namespace}.${item.tool}` : item.tool;
    case "webSearch":
      return "WebSearch";
    case "imageView":
      return "ViewImage";
    case "collabAgentToolCall":
      return item.tool;
  }
}

export function codexProcessEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  if (env.OPENAI_API_KEY && !env.CODEX_API_KEY) env.CODEX_API_KEY = env.OPENAI_API_KEY;
  return env;
}

function codexTerminalError(
  content: string,
  errorMessage?: string,
  codexErrorInfo?: TurnError["codexErrorInfo"],
): StreamEvent {
  const transient =
    classifyNetworkFailure({ backend: "codex", codexErrorInfo, errorMessage }) === "transient";
  return { kind: "error", content, ...(transient && { networkFailure: true }) };
}

// A backend error codex passes on as the response body: its message.
function errorText(message: string | undefined): string {
  if (!message) return "Turn failed";
  try {
    const body = JSON.parse(message) as { detail?: unknown; error?: { message?: unknown } };
    const text = body.detail ?? body.error?.message;
    if (typeof text === "string") return text;
  } catch {
    // plain text
  }
  return message;
}

// The panel's limit types: a window of up to a day is the short one.
function windowType(w: RateLimitWindow): "five_hour" | "seven_day" {
  return (w.windowDurationMins ?? 0) <= 24 * 60 ? "five_hour" : "seven_day";
}

// What the model ran, without the shell codex wraps it in.
function commandText(item: Extract<ThreadItem, { type: "commandExecution" }>): string {
  const actions = item.commandActions ?? [];
  if (actions.length === 1) return actions[0].command;
  const wrapped = /^\/bin\/(?:ba|z)?sh -lc '(.*)'$/s.exec(item.command);
  return wrapped ? wrapped[1].replace(/'\\''/g, "'") : item.command;
}

function changeList(changes: Array<{ path: string; kind: { type: string } }>): string {
  const mark = (t: string) => (t === "add" ? "+" : t === "delete" ? "-" : "~");
  return changes.map((c) => `${mark(c.kind.type)} ${c.path}`).join("\n");
}

// The account's Codex limits without a turn: account/rateLimits/read on a
// short-lived app-server costs no quota. Null without a ChatGPT login.
export async function readCodexRateLimits(
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<RateLimitSnapshot | null> {
  if (signal?.aborted) return null;
  let client: AppServerClient | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  const interrupted = new Promise<null>((resolve) => {
    cancel = () => resolve(null);
    timer = setTimeout(cancel, 15_000).unref();
    signal?.addEventListener("abort", cancel, { once: true });
  });
  const read = async () => {
    const transport = CodexSession.hooks?.transport
      ? null
      : spawnAppServer({ cwd: os.tmpdir(), env });
    if (!transport) return null;
    client = new AppServerClient(transport, {
      notification: () => {},
      request: () => Promise.reject(new Error("not answered")),
      close: () => {},
    });
    await client.initialize();
    signal?.throwIfAborted();
    const res = await client.request<{ rateLimits: RateLimitSnapshot }>(
      "account/rateLimits/read",
      null,
    );
    return res.rateLimits;
  };
  try {
    return await Promise.race([read(), interrupted]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    (client as AppServerClient | null)?.close();
  }
}

export type CodexAuthStatus = "authenticated" | "unauthenticated" | "unavailable" | "error";

export interface CodexAuthState {
  cliAvailable: boolean;
  authenticated: boolean;
  status: CodexAuthStatus;
  accountType?: string | null;
  error?: string;
  checkedAt: number;
}

// Probe Codex CLI authentication without starting a thread or spending quota.
export async function probeCodexAuth(
  env: NodeJS.ProcessEnv = process.env,
  opts?: {
    timeoutMs?: number;
    transport?: () => Transport;
    codexBinary?: () => string;
  },
): Promise<CodexAuthState> {
  if (opts?.codexBinary || !opts?.transport) {
    try {
      (opts?.codexBinary ?? codexBinary)();
    } catch (e) {
      return {
        cliAvailable: false,
        authenticated: false,
        status: "unavailable",
        accountType: null,
        error: e instanceof Error ? e.message : String(e),
        checkedAt: Date.now(),
      };
    }
  }

  let transport: Transport | null = null;
  let client: AppServerClient | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Codex account probe timed out")), timeoutMs);
    timer.unref?.();
  });

  const read = async (): Promise<CodexAuthState> => {
    transport = opts?.transport ? opts.transport() : spawnAppServer({ cwd: os.tmpdir(), env });
    client = new AppServerClient(transport, {
      notification: () => {},
      request: () => Promise.reject(new Error("not answered")),
      close: () => {},
    });
    await client.initialize();
    const res = await client.request<GetAccountResponse>("account/read", { refreshToken: false });
    const authenticated = res?.account != null || res?.requiresOpenaiAuth === false;
    return {
      cliAvailable: true,
      authenticated,
      status: authenticated ? "authenticated" : "unauthenticated",
      accountType: res?.account?.type ?? null,
      checkedAt: Date.now(),
    };
  };

  try {
    const attempt = read();
    attempt.catch(() => {});
    return await Promise.race([attempt, timeout]);
  } catch (e) {
    return {
      cliAvailable: true,
      authenticated: false,
      status: "error",
      accountType: null,
      error: e instanceof Error ? e.message : String(e),
      checkedAt: Date.now(),
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (client) (client as AppServerClient).close();
    else (transport as Transport | null)?.close();
  }
}
