import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { loadConfig } from "../../src/config/config";
import type { RuntimeReport } from "../../src/config/diagnostics";
import { describeModelDiscovery, probeModelDiscovery } from "../../src/server/model-discovery";
import { Server } from "../../src/server/server";
import * as codex from "../../src/session/codex";
import { LocalHost } from "../../src/session/host";

const secret = "test-credential-never-returned-by-model-discovery";
let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "yaat-model-discovery-test-"));
  fs.writeFileSync(path.join(base, "config.toml"), "[pi]\n");
  vi.stubEnv("HOME", base);
  vi.stubEnv("USERPROFILE", base);
  vi.stubEnv("CODEX_HOME", undefined);
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("CODEX_API_KEY", undefined);
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

const piModel = { id: "demo/model", provider: "demo", modelId: "model" };

function mockPiModels() {
  vi.spyOn(LocalHost.prototype, "discoverPiModels").mockResolvedValue([piModel]);
}

describe("probeModelDiscovery", () => {
  it.each([
    ["unauthenticated", "codex_unauthenticated", "info"],
    ["unavailable", "codex_cli_missing", "info"],
    ["error", "codex_auth_failed", "warning"],
  ] as const)(
    "classifies Codex probe status %s with usable Pi models",
    async (status, code, severity) => {
      mockPiModels();
      vi.mocked(codex.probeCodexAuth).mockResolvedValue({
        cliAvailable: status !== "unavailable",
        authenticated: false,
        status,
        checkedAt: 1,
      });
      const result = await probeModelDiscovery(loadConfig(base), base);
      expect(result.issues).toEqual([expect.objectContaining({ code, severity })]);
    },
  );

  it.each(["default", "override", "OPENAI_API_KEY", "CODEX_API_KEY"])(
    "warns about unauthenticated Codex when local credentials are indicated by %s",
    async (credential) => {
      mockPiModels();
      if (credential === "default" || credential === "override") {
        const home = path.join(base, credential === "default" ? ".codex" : "custom-codex");
        if (credential === "override") vi.stubEnv("CODEX_HOME", home);
        fs.mkdirSync(home);
        fs.writeFileSync(path.join(home, "auth.json"), secret);
      } else {
        vi.stubEnv(credential, secret);
      }
      const result = await probeModelDiscovery(loadConfig(base), base);
      expect(result.issues).toEqual([
        expect.objectContaining({ code: "codex_unauthenticated", severity: "warning" }),
      ]);
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  it.each([
    ["projects.model", '[pi]\n[projects]\nmodel = "gpt-6-astra"'],
    ["pi.default_model", '[pi]\ndefault_model = "gpt-6-astra"'],
    [
      "agent_presets",
      '[pi]\n[[agent_presets]]\nname = "Codex"\navatar = "C"\ncolor = "blue"\nmodel = "gpt-6-astra"',
    ],
  ])("warns when a native Codex model is configured in %s", async (_, config) => {
    mockPiModels();
    fs.writeFileSync(path.join(base, "config.toml"), config);
    const result = await probeModelDiscovery(loadConfig(base), base);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "codex_unauthenticated", severity: "warning" }),
    );
  });

  it("warns when a live agent uses native Codex even without a configured model", async () => {
    mockPiModels();
    const config = loadConfig(base);
    const { models } = await probeModelDiscovery(config, base);
    const result = describeModelDiscovery(config, models, undefined, "unauthenticated", {
      liveBackends: ["codex"],
    });
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "codex_unauthenticated", severity: "warning" }),
    ]);
  });

  it("does not treat a Pi openai-codex model as a native Codex reference", async () => {
    mockPiModels();
    fs.writeFileSync(
      path.join(base, "config.toml"),
      '[pi]\ndefault_model = "openai-codex/gpt-6-astra"',
    );
    const result = await probeModelDiscovery(loadConfig(base), base);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "codex_unauthenticated", severity: "info" }),
    );
  });

  it("only treats omitted Pi as informational when native Codex works and Pi is not referenced", async () => {
    fs.writeFileSync(path.join(base, "config.toml"), "");
    vi.mocked(codex.probeCodexAuth).mockResolvedValue({
      cliAvailable: true,
      authenticated: true,
      status: "authenticated",
      checkedAt: 1,
    });
    const config = loadConfig(base);
    const result = await probeModelDiscovery(config, base);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "pi_not_configured", severity: "info" }),
    ]);
    const live = describeModelDiscovery(config, result.models, result.issues[0], "authenticated", {
      liveBackends: ["pi"],
    });
    expect(live.issues[0].severity).toBe("warning");
    config.projects.model = piModel.id;
    const configured = await probeModelDiscovery(config, base);
    expect(configured.issues[0].severity).toBe("warning");
  });
  it("distinguishes an actual Pi spawn ENOENT from an unauthenticated Codex CLI", async () => {
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
    expect(result.issues.map((issue) => issue.severity)).toEqual(["warning", "warning"]);
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
  it("retains a warning after observing Codex authentication and then losing it", async () => {
    mockPiModels();
    const auth = vi.mocked(codex.probeCodexAuth);
    const signedOut = {
      cliAvailable: true,
      authenticated: false,
      status: "unauthenticated",
      checkedAt: 1,
    } as const;
    const server = new Server(0, base, base);
    let socket: WebSocket | undefined;
    try {
      const port = await server.listening;
      const url = `http://127.0.0.1:${port}/api/diagnostics`;
      const text = await (await fetch(`${url}?format=text`)).text();
      expect(text).toContain("[info] [model-discovery/codex_unauthenticated]");
      expect(text).toContain("Next: Run npx codex login");
      const issues = async () => ((await (await fetch(url)).json()) as RuntimeReport).issues;
      expect(await issues()).toContainEqual(
        expect.objectContaining({ code: "codex_unauthenticated", severity: "info" }),
      );

      socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const recheck = () => {
        const update = new Promise<boolean>((resolve) => {
          const onMessage = (raw: Buffer) => {
            const frame = JSON.parse(raw.toString()) as {
              type: string;
              codexAuth?: codex.CodexAuthState;
            };
            if (frame.type !== "codex_auth_update" || !frame.codexAuth) return;
            socket?.off("message", onMessage);
            resolve(frame.codexAuth.authenticated);
          };
          socket?.on("message", onMessage);
        });
        socket?.send(JSON.stringify({ type: "recheck_codex_auth" }));
        return update;
      };
      await once(socket, "open");
      auth.mockResolvedValue({ ...signedOut, authenticated: true, status: "authenticated" });
      expect(await recheck()).toBe(true);
      auth.mockResolvedValue(signedOut);
      expect(await recheck()).toBe(false);
      expect(await recheck()).toBe(false);
      expect(await issues()).toContainEqual(
        expect.objectContaining({ code: "codex_unauthenticated", severity: "warning" }),
      );
    } finally {
      socket?.terminate();
      await server.close();
    }
  });

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
