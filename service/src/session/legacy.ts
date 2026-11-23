import { EventEmitter } from "events";
import type { HostSessionHandle } from "./host";
import type {
  PromptEnvelope,
  RunState,
  SendHooks,
  SendReceipt,
  SessionState,
  UsageStats,
} from "./types";

export class ReadOnlyLegacySession extends EventEmitter implements HostSessionHandle {
  readonly isRunning = false;
  readonly runState: RunState = "idle";
  readonly canSteer = false;

  constructor(private readonly state: SessionState) {
    super();
  }

  get sessionId(): string | null {
    return this.state.sessionId;
  }

  get usage(): UsageStats {
    return this.state.usage;
  }

  send(_input: string | PromptEnvelope, _hooks?: SendHooks): Promise<SendReceipt> {
    const backend = this.state.config.backend ?? "unknown";
    return Promise.reject(new Error(`Legacy backend "${backend}" is read-only`));
  }

  abort(): void {}

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  getState(): SessionState {
    return this.state;
  }
}
