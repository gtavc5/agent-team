import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ["hast-util-to-jsx-runtime"],
  },
  test: {
    include: ["tests/browser/**/*.browser.test.{ts,tsx}"],
    browser: {
      enabled: true,
      headless: true,
      // Use the same loopback address in Vite and Chromium. The string keeps 0
      // through Vitest 4 and Vite 6's falsy defaults; Node binds an ephemeral port.
      api: { host: "127.0.0.1", port: "0" as unknown as number },
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
