import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { vi } from "vitest";
import { ensureWebviewBuilt } from "../../../scripts/bench-demo";
import { Server } from "../../src/server/server";
import * as codex from "../../src/session/codex";
import { LocalHost } from "../../src/session/host";
import { closeHistory, saveIndex, saveWorkspace } from "../../src/workspace/state";
import type { AgentState, WorkspaceState } from "../../src/workspace/workspace";
import { observeBrowserErrors } from "./pilot-assertions";

export const pilotModel = "pi-e2e/scenario";
export const pilotAgent = {
  id: "pilot-agent",
  name: "Pilot Agent",
  model: pilotModel,
  avatar: "🤖",
  color: "#668899",
  isDefault: true,
};

export function sandboxAgent(root: string, cwd: string, id = pilotAgent.id): AgentState {
  return {
    ...pilotAgent,
    id,
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

export async function pilotBrowser(
  setup: (root: string) => WorkspaceState[],
  exercise: (page: Page, server: Server) => Promise<void>,
) {
  ensureWebviewBuilt(false, true);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yaat 旅程-")));
  let server: Server | undefined;
  let browser: Browser | undefined;
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

    server = new Server(0, root, join(__dirname, "../../../dist/webview"));
    const origin = `http://127.0.0.1:${await server.listening}`;
    browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      reducedMotion: "reduce",
    });
    page.setDefaultTimeout(6_000);
    const checkErrors = observeBrowserErrors(page);
    await page.addInitScript((id) => {
      if (!localStorage.getItem("activeWsId")) localStorage.setItem("activeWsId", id);
    }, workspaces[0].id);
    await page.goto(origin);
    try {
      await exercise(page, server);
    } catch (error) {
      console.error(
        await page
          .locator("body")
          .innerText()
          .catch(() => "(page unavailable)"),
      );
      throw error;
    }
    checkErrors();
  } finally {
    try {
      await browser?.close();
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
}

export const selectSession = (page: Page, name: string) =>
  page.locator(".sidebar").getByText(name, { exact: true }).click();

export async function refreshSession(page: Page, ready: () => Promise<unknown>) {
  await page.reload();
  await ready();
}
