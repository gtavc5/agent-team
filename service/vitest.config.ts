import { configDefaults, defineConfig } from "vitest/config";

// Service unit, snapshot, and behavioral tests; E2E suites run via vitest.e2e.config.mjs
// and webview has its own vitest setup (jsdom + browser).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    // Wake-up times render as local clock times in the snap transcripts.
    env: { TZ: "UTC" },
  },
});
