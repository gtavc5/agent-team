import { defineConfig } from "vitest/config";

// Real end-to-end suites: real Pi deterministic E2E + full-stack Chromium Demo E2E & benchmark.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    fileParallelism: false,
    env: { TZ: "UTC" },
  },
});
