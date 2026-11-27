import { defineConfig } from "vitest/config";

// Real end-to-end suites: real Pi deterministic E2E + full-stack Chromium Demo E2E & benchmark.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    // Direct runs may build dist/webview on demand. Tier entry points prebuild
    // it and opt in to bounded file parallelism for browser-only slices.
    fileParallelism: false,
    env: { TZ: "UTC", AGENT_TEAM_HOST: "127.0.0.1" },
  },
});
