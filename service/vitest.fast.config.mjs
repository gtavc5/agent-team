import unit from "./vitest.config.ts";

// A failure here blocks a turn, session ownership, or ordinary recovery.
// Keep recorded abort and single crash here; repeated shutdown stress stays in Slow.
export default {
  ...unit,
  test: {
    ...unit.test,
    include:
      process.env.YAAT_TEST_REPORTER_FIXTURE === "1"
        ? ["tests/unit/test-output-governance.test.mjs"]
        : [
            "tests/snap/{snap,broadcast}.test.ts",
            "tests/unit/{codex-session,deterministic-process-exit,pi-workspace-regressions,server,workspace-bindings,workspace-lifecycle}.test.ts",
          ],
  },
};
