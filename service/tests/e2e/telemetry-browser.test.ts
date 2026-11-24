import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { ensureWebviewBuilt } from "../../../scripts/bench-demo";
import { seedDemo } from "../../../scripts/seed-demo";
import { Server } from "../../src/server/server";
import type { TelemetryStore } from "../../src/storage/telemetry";

const webDir = join(__dirname, "../../../dist/webview");
const action = "confirm.clear_context";

it.each([true, false])(
  "real Chromium UI interaction telemetry (enabled=%s)",
  async (enabled) => {
    ensureWebviewBuilt();
    const dir = mkdtempSync(join(tmpdir(), "yaat-telemetry-browser-"));
    let server: Server | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      seedDemo(dir, { quiet: true, writeConfig: true });
      appendFileSync(join(dir, "config.toml"), `\n[telemetry]\nenabled = ${enabled}\n`);
      server = new Server(0, dir, webDir);
      const origin = `http://127.0.0.1:${await server.listening}`;
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.setDefaultTimeout(10_000);
      let posts = 0;
      page.context().on("request", (req) => {
        if (req.method() === "POST" && req.url() === `${origin}/api/telemetry`) posts++;
      });
      await page.goto(origin);
      const rail = page.locator("nav.side-rail");
      const files = rail.getByRole("button", { name: "Files", exact: true });
      const agents = rail.getByRole("button", { name: "Agents and sessions" });
      const opener = page.getByRole("button", { name: /Clear .*'s context/ }).first();
      const dialog = page.getByRole("dialog", { name: /Clear .*'s context\?/ });
      const openAgents = async () => {
        await agents.click();
        const unfold = page.locator('.ap-session.active .ap-toggle[aria-expanded="false"]');
        if (await unfold.isVisible()) await unfold.click();
      };

      const firstFlush = enabled
        ? page.waitForResponse(
            (res) => res.url() === `${origin}/api/telemetry` && res.status() === 204,
          )
        : undefined;
      await page.locator(".ws-archive-toggle").click();
      await files.click();
      await openAgents();
      await opener.click();
      await dialog.waitFor();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await opener.click();
      // Destructive dialogs default to Cancel. Confirm via the focused button.
      await dialog.getByRole("button", { name: "Clear context", exact: true }).press("Enter");
      await dialog.waitFor({ state: "hidden" });
      await files.click();
      if (firstFlush) await firstFlush;
      else {
        // Give a wrongly scheduled periodic flush time to send before leaving.
        await expect(
          page.waitForRequest(`${origin}/api/telemetry`, { timeout: 5500 }),
        ).rejects.toThrow("Timeout");
      }

      await openAgents();
      await opener.click();
      await dialog.waitFor();
      // Abandoning an open dialog does not count as an explicit cancel.
      await page.goto("about:blank");
      const summary = async () =>
        (await (await fetch(`${origin}/api/telemetry/summary`)).json()) as ReturnType<
          TelemetryStore["summary"]
        >;
      if (enabled) {
        await expect.poll(async () => (await summary()).recentChains?.[0]?.length).toBe(10);
        const report = await summary();
        expect(report.counts.filter((row) => row.action === action)).toEqual([
          { action, layout: "wide", outcome: "cancel", count: 1 },
          { action, layout: "wide", outcome: "confirm", count: 1 },
          { action, layout: "wide", outcome: "open", count: 3 },
        ]);
        expect(
          report.recentChains.map((chain) => chain.map((row) => [row.action, row.outcome])),
        ).toEqual([
          [
            ["sidebar.archive_toggle", "trigger"],
            ["panel.files", "trigger"],
            ["panel.agents", "trigger"],
            [action, "open"],
            [action, "cancel"],
            [action, "open"],
            [action, "confirm"],
            ["panel.files", "trigger"],
            ["panel.agents", "trigger"],
            [action, "open"],
          ],
        ]);
        expect(report.transitions).toContainEqual(
          expect.objectContaining({
            from_action: "panel.files",
            to_action: "panel.agents",
            from_layout: "wide",
            to_layout: "wide",
          }),
        );
      } else {
        expect(posts).toBe(0);
        expect(await summary()).toMatchObject({ enabled: false, recentChains: [] });
        expect(readdirSync(dir).filter((name) => name.startsWith("telemetry.db"))).toEqual([]);
      }
    } finally {
      try {
        await browser?.close();
        await server?.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
  60_000,
);
