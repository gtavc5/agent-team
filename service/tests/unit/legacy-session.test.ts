import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalHost } from "../../src/session/host";
import { ReadOnlyLegacySession } from "../../src/session/legacy";
import { PiSession } from "../../src/session/pi";
import type { AnyBackend, SessionState } from "../../src/session/types";
import { HostRegistry } from "../../src/session/host";
import { Workspace, type WorkspaceCallbacks } from "../../src/workspace/workspace";
import { mergeLocalCommands } from "../../src/server/commands";
import { Server } from "../../src/server/server";
import { FakeHost } from "./fakes";

const usage = {
  input_tokens: 12,
  output_tokens: 34,
  cache_read_tokens: 5,
  cache_creation_tokens: 6,
  turns: 7,
  duration_ms: 890,
};

function state(backend: string): SessionState {
  return {
    sessionId: `historic-${backend}`,
    config: {
      cwd: "/historic",
      backend: backend as AnyBackend,
      model: "historic-model",
      goal: "retained history",
    },
    usage: { ...usage },
  };
}

function serverDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-server-"));
  const web = path.join(base, "web");
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(base, "config.toml"), "");
  return { base, web };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../../src/session/codex-rpc");
  vi.resetModules();
});

describe("read-only legacy restoration", () => {
  it.each(["claude", "cursor", "agy", "removed-backend"])(
    "restores %s without fallback and rejects sends",
    async (backend) => {
      const host = new LocalHost("local", "Local");
      const historic = state(backend);
      const session = host.restoreSession("agent", historic);
      expect(session).toBeInstanceOf(ReadOnlyLegacySession);
      expect(session.isRunning).toBe(false);
      expect(session.runState).toBe("idle");
      expect(session.canSteer).toBe(false);
      expect(session.getState()).toBe(historic);
      expect(session.getState().config.goal).toBe("retained history");
      expect(session.usage).toEqual(usage);
      await expect(session.send("must not run")).rejects.toThrow(
        `Legacy backend "${backend}" is read-only`,
      );
      session.abort();
      await session.dispose?.();
      expect(session.getState()).toBe(historic);
    },
  );

  it("never silently creates a removed or unknown backend", async () => {
    const host = new LocalHost("local", "Local");
    for (const backend of ["claude", "cursor", "agy", "unknown", undefined]) {
      expect(() =>
        host.createSession("agent", { cwd: "/tmp", backend: backend as AnyBackend }),
      ).toThrow(/cannot create new sessions/);
    }
    expect(host.createSession("pi-new", { cwd: "/tmp", backend: "pi" })).toBeInstanceOf(PiSession);
    const restored = host.restoreSession("pi-saved", state("pi"));
    expect(restored).toBeInstanceOf(PiSession);
    expect(restored.sessionId).toBe("historic-pi");
    await host.close();
  });
});

describe("Legacy backend compatibility", () => {
  it("starts normally and exposes no Codex models without the Codex CLI", async () => {
    vi.doMock("../../src/session/codex-rpc", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/session/codex-rpc")>();
      return {
        ...original,
        codexBinary: () => {
          throw new Error("Codex CLI unavailable");
        },
      };
    });
    const { MODEL_OPTIONS } = await import("../../src/config/presets");
    expect(MODEL_OPTIONS).toEqual([]);
    const { Server: DegradedServer } = await import("../../src/server/server");
    const { base, web } = serverDirs();
    const server = new DegradedServer(0, base, web);
    await server.listening;
    await server.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("disables /goal in both command discovery and Workspace", async () => {
    expect(mergeLocalCommands([]).some((command) => command.name === "goal")).toBe(false);
    expect(
      mergeLocalCommands([{ name: "goal", description: "legacy", argumentHint: "" }]).some(
        (command) => command.name === "goal",
      ),
    ).toBe(false);
    const host = new FakeHost();
    const registry = new HostRegistry();
    registry.register(host);
    const cb: WorkspaceCallbacks = {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
    };
    const ws = new Workspace("ws", "test", "project", "local", "/tmp", registry, cb);
    ws.addAgent("A", "gpt-6-astra", "A", "#fff", { backend: "codex" });
    await ws.sendMessage("/goal finish everything");
    expect(host.lastSession?.sent).toEqual([]);
    expect(host.lastSession?.getState().config.goal).toBeUndefined();
    expect(ws.messages.at(-1)?.content).toContain("/goal is disabled");
    await ws.dispose();
  });

  it("disables macOS restart without restart_command and closes asynchronously", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const { base, web } = serverDirs();
    const server = new Server(0, base, web);
    await server.listening;
    const close = vi.spyOn(server, "close");
    await (
      server as unknown as {
        restartServer(): Promise<void>;
        httpServer: { listening: boolean };
      }
    ).restartServer();
    expect(close).not.toHaveBeenCalled();
    expect((server as unknown as { httpServer: { listening: boolean } }).httpServer.listening).toBe(
      true,
    );

    const closing = server.close();
    expect(closing).toBeInstanceOf(Promise);
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
    expect((server as unknown as { httpServer: { listening: boolean } }).httpServer.listening).toBe(
      false,
    );
    fs.rmSync(base, { recursive: true, force: true });
  });
});
