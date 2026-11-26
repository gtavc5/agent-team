// @vitest-environment node

import { fileURLToPath } from "node:url";
import { assert, expect, test } from "vitest";
import { createVitest } from "vitest/node";

const root = fileURLToPath(new URL("..", import.meta.url));

test(
  "parallel browser servers bind distinct ephemeral IPv4 loopback ports",
  { timeout: 15_000 },
  async ({ onTestFinished }) => {
    async function startBrowserServer() {
      const runner = await createVitest("test", {
        root,
        config: "vitest.browser.config.ts",
        watch: false,
      });
      onTestFinished(() => runner.close());
      expect(Number(runner.config.browser.api.port)).toBe(0);
      // Vitest's watch-mode hook starts the browser listener without launching Chromium.
      const browserRunner = runner as typeof runner & { _initBrowserServers?: () => Promise<void> };
      assert(typeof browserRunner._initBrowserServers === "function");
      await browserRunner._initBrowserServers();
      const vite = runner.projects[0]?.browser?.vite;
      assert(vite?.resolvedUrls?.local[0]);
      const url = new URL(vite.resolvedUrls.local[0]);
      expect(url.hostname).toBe("127.0.0.1");
      const port = Number(url.port);
      expect(port).toBeGreaterThan(0);
      expect(vite.httpServer?.address()).toMatchObject({ address: url.hostname, port });
      return port;
    }

    const first = await startBrowserServer();
    expect(await startBrowserServer()).not.toBe(first);
  },
);
