import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { loadConfig } from "../../src/config/config";
import { probeModelDiscovery } from "../../src/server/model-discovery";
import { Server } from "../../src/server/server";
import * as codex from "../../src/session/codex";
import { LocalHost } from "../../src/session/host";

const secret = "test-credential-never-returned-by-model-discovery";
let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "yaat-model-discovery-test-"));
  fs.writeFileSync(path.join(base, "config.toml"), "[pi]\n");
  vi.spyOn(codex, "probeCodexAuth").mockResolvedValue({
    cliAvailable: true,
    authenticated: false,
    status: "unauthenticated",
    checkedAt: 1,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("probeModelDiscovery", () => {
  it("distinguishes an actual Pi spawn ENOENT from an unauthenticated Codex CLI", async () => {
    vi.stubEnv("HOME", base);
    vi.stubEnv("USERPROFILE", base);
    vi.stubEnv("PATH", base);
    vi.stubEnv("YAAT_PI_BIN", undefined);
    const result = await probeModelDiscovery(loadConfig(base), base);
    expect(result.models).toEqual([]);
    expect(result.defaultModel).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "pi_cli_missing",
      "codex_unauthenticated",
    ]);
    expect(result.issues[0].nextStep).toContain("scripts/yaat-service.sh install");
    expect(result.issues[0]).toMatchObject({
      stage: "model-discovery",
      code: "pi_cli_missing",
      value: "pi",
      source: "pi-cli",
      impact: "The service could not start Pi: the executable was not found.",
    });
  });

  it("reports omitted Pi config without starting a Pi catalog session", async () => {
    fs.writeFileSync(path.join(base, "config.toml"), "");
    const catalog = vi.spyOn(LocalHost.prototype, "discoverPiModels");
    const result = await probeModelDiscovery(loadConfig(base), base);
    expect(catalog).not.toHaveBeenCalled();
    expect(result.defaultModel).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "pi_not_configured",
      "codex_unauthenticated",
    ]);
  });

  it("preserves the available fallback for a stale configured default without echoing its value", async () => {
    fs.writeFileSync(
      path.join(base, "config.toml"),
      `[pi]\ndefault_model = "demo/model"\n[projects]\nmodel = "${secret}"\n`,
    );
    vi.spyOn(LocalHost.prototype, "discoverPiModels").mockResolvedValue([
      { id: "demo/model", provider: "demo", modelId: "model" },
    ]);
    const result = await probeModelDiscovery(loadConfig(base), base);
    expect(result.defaultModel).toBe("demo/model");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "configured_model_unavailable",
        source: "projects.model",
        value: null,
      }),
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("Server model discovery", () => {
  it.each([
    ["pi_unauthenticated", undefined],
    ["pi_catalog_failed", Object.assign(new Error(secret), { code: "ENOENT", syscall: "open" })],
  ])("reports %s for a default and rejects an explicit unknown model", async (code, failure) => {
    const catalog = vi.spyOn(LocalHost.prototype, "discoverPiModels");
    if (failure) catalog.mockRejectedValue(failure);
    else catalog.mockResolvedValue([]);
    vi.mocked(codex.probeCodexAuth).mockResolvedValue({
      cliAvailable: true,
      authenticated: false,
      status: "error",
      error: secret,
      checkedAt: 1,
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = new Server(0, base, base);
    let socket: WebSocket | undefined;
    try {
      const port = await server.listening;
      const snapshot = server.modelDiscoverySnapshot();
      expect(snapshot.models).toEqual([]);
      expect(snapshot.defaultModel).toBeNull();
      expect(snapshot.issues.map((issue) => issue.code)).toEqual([code, "codex_auth_failed"]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);

      socket = new WebSocket(`ws://127.0.0.1:${port}`);
      type Frame = { type: string; issue?: { code: string } };
      const frames: Frame[] = [];
      socket.on("message", (raw: Buffer) => frames.push(JSON.parse(raw.toString()) as Frame));
      await once(socket, "open");
      socket.send(
        JSON.stringify({ type: "create_project", root: null, cwd: base, name: "default" }),
      );
      socket.send(JSON.stringify({ type: "create_project", root: null, cwd: base, model: secret }));
      await vi.waitFor(() =>
        expect(
          frames.filter((frame) => frame.type === "error").map((frame) => frame.issue?.code),
        ).toEqual([code, "invalid_explicit_model"]),
      );
      expect(frames.some((frame) => frame.type === "workspace_created")).toBe(false);
      expect(JSON.stringify(frames)).not.toContain(secret);
      expect(JSON.stringify(frames)).not.toContain("gpt-6-astra");
    } finally {
      socket?.terminate();
      await server.close();
    }
  });
});
