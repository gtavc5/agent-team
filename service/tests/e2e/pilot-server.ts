import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
export { WebSocket as PilotSocket } from "ws";
import { Server } from "../../src/server/server";
import * as codex from "../../src/session/codex";
import { LocalHost } from "../../src/session/host";
import { closeHistory, saveIndex, saveWorkspace } from "../../src/workspace/state";
import type { AgentState, WorkspaceState } from "../../src/workspace/workspace";

export const pilotModel = "pi-e2e/scenario";

export function sandboxAgent(root: string, cwd: string, id = "pilot-agent"): AgentState {
  return {
    id,
    name: "Pilot Agent",
    model: pilotModel,
    avatar: "🤖",
    color: "#668899",
    isDefault: true,
    session: {
      config: { backend: "pi", cwd, model: pilotModel, piAgentDir: join(root, "agent-home") },
      sessionId: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turns: 0,
        duration_ms: 0,
      },
    },
  };
}

export async function pilotServer(
  setup: (root: string) => WorkspaceState[],
  exercise: (origin: string, server: Server, firstWorkspaceId: string) => Promise<void>,
  webDir?: string,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yaat 旅程-")));
  let server: Server | undefined;
  try {
    mkdirSync(join(root, "agent-home"));
    vi.stubEnv("AGENT_TEAM_HOST", "127.0.0.1");
    vi.spyOn(codex, "probeCodexAuth").mockResolvedValue({
      cliAvailable: false,
      authenticated: false,
      status: "unavailable",
      checkedAt: 0,
    });
    vi.spyOn(LocalHost.prototype, "discoverPiModels").mockResolvedValue([
      {
        id: pilotModel,
        provider: "pi-e2e",
        modelId: "scenario",
        name: "Pilot Model",
        effortLevels: ["low"],
      },
    ]);
    writeFileSync(
      join(root, "config.toml"),
      `[pi]\noffline = true\n[pi.acp.proxy]\nenabled = false\n[workspace]\narchive_after_days = 0\n`,
    );
    const workspaces = setup(root);
    for (const ws of workspaces) saveWorkspace(root, ws);
    saveIndex(
      root,
      workspaces.map(({ id }) => id),
    );
    closeHistory(root);
    server = new Server(0, root, webDir ?? root);
    await exercise(`http://127.0.0.1:${await server.listening}`, server, workspaces[0].id);
  } finally {
    try {
      await server?.close();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      closeHistory(root);
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
