import { configDefaults, defineConfig } from "vitest/config";

// Fast Smoke tier for service: P0 + key P1 contracts (recorded snap transcripts,
// core server/HTTP/objectives/notes/history/session-protocol/workspace contracts),
// excluding E2E and slow subprocess/git/watcher integration suites.
// Uses exclude-based filtering so parallel test refactors/renames stay compatible.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "tests/e2e/**",
      "tests/unit/server-projects.test.ts",
      "tests/unit/project-v2.test.ts",
      "tests/unit/dynamic-models-commands.test.ts",
      "tests/unit/panel-http-bridge.test.ts",
      "tests/unit/issues.test.ts",
      "tests/unit/history-worker.test.ts",
      "tests/unit/projects.test.ts",
      "tests/unit/pi-session.test.ts",
      "tests/unit/diff.test.ts",
      "tests/unit/project-files.test.ts",
      "tests/unit/objectives-edge.test.ts",
      "tests/unit/project-history.test.ts",
      "tests/unit/server-history.test.ts",
      "tests/unit/git.test.ts",
      "tests/unit/scanner.test.ts",
      "tests/unit/system.test.ts",
      "tests/unit/lsof.test.ts",
      "tests/unit/oauth-quota.test.ts",
      "tests/unit/legacy-session.test.ts",
      "tests/unit/import-issues.test.ts",
      "tests/unit/corpus-tree.test.ts",
      "tests/unit/history-index-rowid.test.ts",
      "tests/unit/history-index-v5.test.ts",
      "tests/unit/history-search-edge.test.ts",
      "tests/unit/project-history-tools.test.ts",
    ],
    env: { TZ: "UTC" },
  },
});
