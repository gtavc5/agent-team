import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  entryHint,
  fastBudgetNote,
  formatFailure,
  formatSummary,
  rerunCommand,
  testPattern,
  useNativeReporter,
} from "../../../scripts/test-reporter.mjs";

const workspace = resolve(import.meta.dirname, "../..");
const file = "tests/unit/test-output-governance.test.mjs";
const fixtureName = `nested suite fails for 'quotes' "$x" [literal]`;
const marker = "YAAT_TEST_REPORTER_FIXTURE";

if (process.env[marker]) {
  describe("nested suite", () => {
    it("passes quietly", () => console.log("PASS CONSOLE SENTINEL"));
    it(`fails for 'quotes' "$x" [literal]`, () => {
      console.error("FAILED CONSOLE SENTINEL");
      expect("first\n" + "line\n".repeat(30) + "ACTUAL TAIL").toBe("EXPECTED TAIL");
    });
    it.skip("a skipped case", () => {});
  });
} else {
  function run(args, env = {}) {
    return spawnSync(
      process.execPath,
      ["../scripts/run-tests.mjs", "service", "fast", file, ...args],
      {
        cwd: workspace,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          CI: "",
          VERBOSE: "",
          YAAT_FAST_BUDGET_MS: "15000",
          [marker]: "1",
          ...env,
        },
      },
    );
  }

  it("prints just the compact pass summary and emits only a non-failing budget observation", () => {
    expect(
      formatSummary("service", "fast", ["passed", "skipped"], ["passed", "skipped"], 1250),
    ).toBe("[service/fast] 2 files (1 passed, 1 skipped), 2 tests (1 passed, 1 skipped) in 1.25s");
    const normal = run(["-t", "passes quietly"]);
    expect(normal.error).toBeUndefined();
    expect(normal.status).toBe(0);
    expect(normal.stdout.trim()).toMatch(
      /^\[service\/fast\] 1 files \(1 passed, 0 skipped\), 3 tests \(1 passed, 2 skipped\) in \d+\.\d+s$/,
    );
    expect(normal.stderr).toBe("");
    const over = run(["-t", "passes quietly"], { YAAT_FAST_BUDGET_MS: "0" });
    expect(over.status).toBe(0);
    expect(over.stdout).toContain(`slowest files: ${file}`);
    expect(over.stdout).not.toContain("test:slow");
    expect(
      fastBudgetNote(
        "webview",
        "fast",
        [
          { file: "fourth", ms: 100 },
          { file: "first", ms: 400 },
          { file: "third", ms: 200 },
          { file: "second", ms: 300 },
        ],
        16000,
        {},
      ),
    ).toMatch(/first .*second .*third /);
    expect(fastBudgetNote("service", "fast", [{ file, ms: 100 }], 14999, {})).toBeUndefined();
    expect(
      fastBudgetNote("service", "fast", [{ file, ms: 100 }], 14999, { YAAT_FAST_BUDGET_MS: "" }),
    ).toBeUndefined();
  }, 25_000);

  it("reports the real failure and gives a rerun that selects its exact nested name", () => {
    const failure = run(["-t", testPattern(fixtureName)]);
    expect(failure.error).toBeUndefined();
    expect(failure.status).toBe(1);
    expect(failure.stderr).toMatch(/test-output-governance\.test\.mjs:\d+ nested suite > fails/);
    expect(failure.stderr).toContain(
      "Rerun: " + rerunCommand("service", "fast", [file, "-t", testPattern(fixtureName)]),
    );
    const log = /^Full failure log: (.+)$/m.exec(failure.stderr)?.[1];
    expect(log).toBeDefined();
    if (!log) return;
    try {
      expect(isAbsolute(log)).toBe(true);
      expect(relative(tmpdir(), log)).not.toMatch(/^\.\./);
      expect(relative(resolve(workspace, ".."), log)).toMatch(/^\.\./);
      expect(failure.stderr).not.toContain("FAILED CONSOLE SENTINEL");
      expect(readFileSync(log, "utf8")).toContain("FAILED CONSOLE SENTINEL");
    } finally {
      rmSync(log);
      rmSync(dirname(log), { recursive: true });
    }
  }, 25_000);

  it("bounds long diffs while retaining the full assertion and points to known prerequisites", () => {
    const text = formatFailure({
      location: "file.ts:4",
      name: "assertion",
      errors: [
        {
          message: "Executable doesn't exist at /some/path",
          diff: "x\n".repeat(50) + "FULL DIFF TAIL",
        },
      ],
      rerun: "npm run test:browser -w webview",
    });
    const log = /^Full failure log: (.+)$/m.exec(text)?.[1];
    expect(log).toBeDefined();
    if (!log) return;
    try {
      expect(text).toContain("npx playwright install chromium");
      expect(text).not.toContain("FULL DIFF TAIL");
      expect(readFileSync(log, "utf8")).toContain("FULL DIFF TAIL");
    } finally {
      rmSync(log);
      rmSync(dirname(log), { recursive: true });
    }
    expect(
      formatFailure({
        location: "file.ts:4",
        name: "Pi",
        errors: [new Error("Pi E2E requires the pi binary")],
        rerun: "npm run test:e2e -w service",
      }),
    ).toContain("set PI_BINARY");
  });

  it.each([
    ["service", "unit", "test"],
    ["service", "fast", "run test:fast"],
    ["service", "e2e", "run test:e2e"],
    ["webview", "unit", "test"],
    ["webview", "fast", "run test:fast"],
    ["webview", "browser", "run test:browser"],
  ])("reruns %s/%s in the original npm scope", (workspace, tier, command) => {
    expect(
      rerunCommand(workspace, tier, ["tests/some file.ts", "-t", "^suite test$"], "linux"),
    ).toBe(`npm ${command} -w ${workspace} -- 'tests/some file.ts' -t '^suite test$'`);
    const pattern = testPattern(fixtureName, "win32");
    expect(new RegExp(pattern).test(fixtureName)).toBe(true);
    expect(pattern).not.toMatch(/["'%]/);
    expect(rerunCommand(workspace, tier, ["tests/it's here.ts", "-t", pattern], "win32")).toBe(
      `npm ${command} -w ${workspace} -- 'tests/it''s here.ts' -t '${pattern}'`,
    );
  });

  it.each(["e2e", "browser"])("notes only direct unfiltered %s invocations", (tier) => {
    expect(entryHint(tier, [], {}, {}, false)).toContain("pass a test file");
    for (const [filter, options, env, slow] of [
      [["some-file"], {}, {}, false],
      [[], { testNamePattern: "case" }, {}, false],
      [[], { tags: "only" }, {}, false],
      [[], {}, {}, true],
      [[], {}, { CI: "1" }, false],
      [[], {}, { CI: "true" }, false],
    ])
      expect(entryHint(tier, filter, options, env, slow)).toBeUndefined();
    expect(entryHint("fast", [], {}, {}, false)).toBeUndefined();
  });

  it("opts out for VERBOSE, CI, or an explicit Vitest reporter", () => {
    expect(useNativeReporter({}, {})).toBe(false);
    expect(useNativeReporter({}, { VERBOSE: "1" })).toBe(true);
    expect(useNativeReporter({}, { CI: "true" })).toBe(true);
    expect(useNativeReporter({}, { CI: "1" })).toBe(true);
    expect(useNativeReporter({ reporter: ["dot"] }, {})).toBe(true);
    for (const env of [{ VERBOSE: "1" }, { CI: "true" }]) {
      const native = run(["-t", "passes quietly"], env);
      expect(native.status).toBe(0);
      expect(native.stdout).not.toContain("[service/fast]");
    }
    const explicit = run(["-t", "passes quietly", "--reporter=verbose"]);
    expect(explicit.status).toBe(0);
    expect(explicit.stdout).toContain("PASS CONSOLE SENTINEL");
    expect(explicit.stdout).not.toContain("[service/fast]");
  }, 25_000);

  it("lets the native CLI print help once and reject unknown options", () => {
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout.match(/^vitest\//gm)).toHaveLength(1);
    const invalid = run(["--reporters=verbose"]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("Unknown option `--reporters`");
    expect(invalid.stdout).not.toContain("[service/fast]");
  }, 25_000);
}
