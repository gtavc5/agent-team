import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Fast Smoke tier for webview (jsdom): P0 + key P1 UI/stream/board/panel contracts,
// excluding Playwright browser tests and heavier secondary edge-permutation files.
// Uses exclude-based filtering so parallel test refactors/renames stay compatible.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: [
      ...configDefaults.exclude,
      "tests/browser/**",
      "tests/app.test.tsx",
      "tests/add-agent.test.tsx",
      "tests/agents-panel.test.tsx",
      "tests/ask-lines.test.tsx",
      "tests/board-issues.test.tsx",
      "tests/board-notes.test.tsx",
      "tests/board-page-edge.test.tsx",
      "tests/changes-view.test.tsx",
      "tests/chat-layout.test.tsx",
      "tests/clipboard.test.ts",
      "tests/components.test.tsx",
      "tests/copy.test.tsx",
      "tests/debugSnapshot.test.ts",
      "tests/format.test.ts",
      "tests/ime.test.ts",
      "tests/mdSource.test.ts",
      "tests/panel-actions.test.tsx",
      "tests/projects-app.test.tsx",
      "tests/projects.test.tsx",
      "tests/pwa.test.ts",
      "tests/textKeys.test.ts",
      "tests/viewport-facts.test.ts",
      "tests/viewport.test.ts",
      "tests/viewportHeal.test.ts",
    ],
    css: { include: [/styles\.css/, /sarasa-mono-sc\/[\w-]+\/result\.css/] },
  },
});
