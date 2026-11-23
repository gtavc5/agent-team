// The fixture script: what a recorded interaction does and why it exists.
// No test or SDK dependencies, so scripts/capture-sdk.ts can load fixtures
// under plain node.
import type { Message } from "../../src/workspace/workspace";
import type { PromptEnvelope, StreamEvent, UsageStats } from "../../src/session/types";
import type { RpcMessage } from "../../src/session/codex-rpc";
import type { PanelToolset } from "../../src/project/tools";
import { z } from "zod";

export type Backend = "codex" | "pi";

export type Step =
  // Codex: turn/start when no turn runs, turn/steer into the running one.
  // `requeued`: the panel sends it by itself (a steered message the stopped
  // turn never read, back from the queue); the replay only expects it.
  | { op: "send"; text: string; requeued?: true }
  // Recording pacing only: "result" = the turn's result frame arrived,
  // "idle" = result and no live background task, a number = milliseconds,
  // { frame } = a frame whose JSON contains the string arrived.
  | { op: "wait"; for: "result" | "idle" | number | { frame: string } }
  // End the backend process (a server restart); the next send resumes.
  | { op: "end" }
  // The user's Stop button mid-turn.
  | { op: "abort" }
  // Query.interrupt() / turn/interrupt: stop the running turn, keep the process.
  | { op: "interrupt" }
  // Codex: thread/compact/start, the user's /compact.
  | { op: "compact" }
  | { op: "image"; text: string; seed: number }
  | { op: "uiDialogResponse"; requestId: string; confirmed: boolean }
  | { op: "panelCall"; callId: string }
  | { op: "check"; name: string };

export interface Replay {
  messages: Message[];
  events: StreamEvent[];
  states: string[];
  // What the sessions reported as usage limits (the server's rateLimit).
  limits: { rateLimitType?: string; resetsAt?: number }[];
  // Every session handle the workspace created, in order (a restart adds one).
  sessions: {
    sessionId: string | null;
    usage: UsageStats;
    runState?: string;
    backgroundTaskList?: { id: string }[];
  }[];
  // Every message the sessions wrote to the backend process.
  sent: RpcMessage[];
  pi?: {
    sent: PiFrame[];
    checkpoints: Record<string, PiCheckpoint>;
    connections: Array<{ restored: boolean }>;
    dialogs: Array<{ kind: "request" | "resolved"; id: string }>;
  };
}

export type PiFrame = { type: string; [key: string]: unknown };

export interface PiCheckpoint {
  canSteer: boolean;
  runState: string;
  userStatuses: string[];
  prompts: string[];
  terminalCount: number;
  thinkingClosed: boolean;
  pendingDialogIds: string[];
  contextUsage: Record<string, unknown> | null;
  backgroundTasks: { id: string; cancellable?: boolean }[];
  lastEnvelope?: PromptEnvelope;
  generation?: number;
}

// A tool the client defines (thread/start dynamicTools) and answers itself
// when the model calls it (item/tool/call).
export interface CodexTool {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  reply: string;
  success?: boolean;
}

export interface Fixture {
  description: string;
  model?: string;
  effort?: string;
  // Extra codex thread/start params for the recording.
  options?: Record<string, unknown>;
  // The panel's tools, and the instructions that go with them.
  tools?: CodexTool[];
  instructions?: string;
  // Files materialised in the recording cwd (skills, images).
  files?: Record<string, string | { base64: string }>;
  // The backend's API calls go to a local stand-in instead of Anthropic or
  // OpenAI. "usage-limit" refuses each one as a spent usage limit does, so a
  // limit is recorded without spending the account's.
  api?: "usage-limit";
  steps: Step[];
  // Runs real project tools over Panel HTTP at the tape's tool anchors.
  piProject?: true;
  verify?: (replay: Replay) => void;
}

// A fixture's tools as the panel's: JSON Schema properties of strings and
// numbers, all the fixtures use.
export function panelTools(tools: CodexTool[], instructions?: string): PanelToolset {
  return {
    instructions: instructions ?? "Panel tools of a recorded fixture.",
    tools: tools.map((t) => {
      const props = (t.inputSchema.properties ?? {}) as Record<string, { type: string }>;
      const required = new Set((t.inputSchema.required ?? []) as string[]);
      const shape: Record<string, z.ZodType> = {};
      for (const [k, p] of Object.entries(props)) {
        const type = p.type === "number" ? z.number() : z.string();
        shape[k] = required.has(k) ? type : type.optional();
      }
      return {
        name: t.name,
        description: t.description,
        shape,
        handler: () =>
          t.success === false ? Promise.reject(new Error(t.reply)) : Promise.resolve(t.reply),
      };
    }),
  };
}

// What a tape keeps of a frame or a request: strings cut at 400
// characters, base64 payloads replaced (scripts/capture-sdk.ts). A replay
// compares what the session writes the same way.
export function tapeTrim(v: unknown): unknown {
  if (typeof v === "string") return v.length > 400 ? v.slice(0, 400) + `…(+${v.length - 400})` : v;
  if (Array.isArray(v)) return v.map(tapeTrim);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "data" && typeof val === "string" && val.length > 100)
        o[k] = `<base64 ${val.length}>`;
      else o[k] = tapeTrim(val);
    }
    return o;
  }
  return v;
}

export const fixture = (f: Fixture): Fixture => f;
export const send = (text: string): Step => ({ op: "send", text });
export const requeued = (text: string): Step => ({ op: "send", text, requeued: true });
export const wait = (until: "result" | "idle" | number | { frame: string }): Step => ({
  op: "wait",
  for: until,
});
export const end = (): Step => ({ op: "end" });
export const abort = (): Step => ({ op: "abort" });
export const interrupt = (): Step => ({ op: "interrupt" });
export const compact = (): Step => ({ op: "compact" });

export const DEFAULT_MODEL: Record<Backend, string> = {
  codex: "gpt-6-luna",
  pi: "synthetic/pi-model",
};
export const RECORD_CWD = "/tmp/sdk-capture";

export interface Header {
  backend: Backend;
  fixture: string;
  description: string;
  model: string;
  cli?: string;
  recordedAt: string;
}

export type Entry = { t: number } & (
  | { step: Step & { i: number } }
  | { frame: unknown }
  // A JSON-RPC message the recorder sent to the backend.
  | { sent: unknown }
  | { error: string }
  // The backend's event stream closed (process exit).
  | { close: true }
  // A control request the recorder made (interrupt, stop_task) and its answer;
  | { control: { op: string; taskId?: string; response?: unknown; error?: string } }
);

export interface Recording {
  header: Header;
  entries: Entry[];
}

// Card lifecycle events fold into their start; the kinds a reader sees.
export const kinds = (evs: StreamEvent[]): string[] =>
  evs
    .filter((e) => e.kind !== "subagent_done" && e.kind !== "subagent_progress")
    .map((e) => e.kind);

export const agentMessages = (r: Replay): Message[] => r.messages.filter((m) => m.kind === "agent");
