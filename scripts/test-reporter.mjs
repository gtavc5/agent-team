import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { inspect, stripVTControlCharacters } from "node:util";

export const isCI = (env) => /^(?:1|true)$/i.test(env.CI ?? "");

export function useNativeReporter(options, env) {
  return Boolean(isCI(env) || env.VERBOSE === "1" || options.reporter);
}

export function entryHint(tier, filter, options, env, fromSuite) {
  if (
    !["browser", "e2e"].includes(tier) ||
    fromSuite ||
    isCI(env) ||
    filter.length ||
    options.testNamePattern != null ||
    options.tagsFilter != null ||
    options.tags != null ||
    options.related ||
    options.changed ||
    options.project ||
    options.exclude ||
    options.shard
  )
    return undefined;
  const target = tier === "browser" ? "real browsers" : "end-to-end browser/process chains";
  return `test:${tier} exercises ${target}; pass a test file after -- to narrow the run.`;
}

const slash = (path) => path.replaceAll("\\", "/");
const clean = (text) => stripVTControlCharacters(String(text));
const seconds = (ms) => `${(ms / 1000).toFixed(2)}s`;

function quote(arg, platform) {
  if (/^[a-zA-Z0-9_./:-]+$/.test(arg)) return arg;
  return platform === "win32"
    ? `'${arg.replaceAll("'", "''")}'` // PowerShell (the Windows CI shell)
    : `'${arg.replaceAll("'", "'\\''")}'`;
}

export function rerunCommand(workspace, tier, args, platform = process.platform) {
  const command = tier === "unit" ? "test" : `run test:${tier}`;
  return `npm ${command} -w ${workspace}${args.length ? ` -- ${args.map((arg) => quote(arg, platform)).join(" ")}` : ""}`;
}

export function testPattern(name, platform = process.platform) {
  // Windows npm shims can consume nested quotes; encode shell metacharacters in the regex.
  const escaped =
    platform === "win32"
      ? name.replace(
          /[^a-zA-Z0-9 _-]/g,
          (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
        )
      : name
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replaceAll("\n", "\\n")
          .replaceAll("\r", "\\r");
  return `^${escaped}$`;
}

function environmentHint(details) {
  if (/Executable doesn't exist at|browser executable.*(?:missing|not found)/i.test(details)) {
    return "Install Playwright Chromium: npx playwright install chromium";
  }
  if (/Pi E2E requires the pi binary|(?:ENOENT|not found).*PI_BINARY/i.test(details)) {
    return "Install Pi on PATH or set PI_BINARY to the Pi executable.";
  }
}

function errorText(error) {
  return [
    error.stack || error.stackStr || `${error.name ?? "Error"}: ${error.message ?? error}`,
    error.diff,
    error.cause &&
      inspect(error.cause, {
        depth: Infinity,
        maxArrayLength: Infinity,
        maxStringLength: Infinity,
      }),
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatFailure({ location, name, errors, logs = [], rerun }, logDir = tmpdir()) {
  const detail = clean(
    errors
      .map((error) => [error.message ?? error, error.diff].filter(Boolean).join("\n"))
      .join("\n"),
  );
  const full = clean(
    [
      `${location} ${name}`,
      ...errors.map(errorText),
      ...logs.map(({ content }) => content),
      `Rerun: ${rerun}`,
    ].join("\n\n"),
  );
  const preview = detail.split("\n").slice(0, 12).join("\n").slice(0, 1200);
  const result = [clean(`FAIL ${location} ${name}`), preview || "No assertion message available."];
  if (preview !== detail || logs.length) {
    try {
      const path = join(mkdtempSync(join(logDir, "yaat-test-")), "failure.log");
      writeFileSync(path, full, { mode: 0o600 });
      result.push(`Full failure log: ${path}`);
    } catch (error) {
      result.push(`Could not write full failure log: ${error.message}`);
    }
  }
  const hint = environmentHint(full);
  if (hint) result.push(hint);
  result.push(`Rerun: ${rerun}`);
  return result.join("\n");
}

export function formatSummary(workspace, tier, files, tests, duration) {
  const counts = (states) => {
    const count = (state) => states.filter((s) => s === state).length;
    const passed = count("passed");
    const skipped = count("skipped");
    const failed = count("failed");
    return `${passed} passed, ${skipped} skipped${failed ? `, ${failed} failed` : ""}`;
  };
  return `[${workspace}/${tier}] ${files.length} files (${counts(files)}), ${tests.length} tests (${counts(tests)}) in ${seconds(duration)}`;
}

export default class CompactReporter {
  constructor() {
    this.context = JSON.parse(process.env.YAAT_TEST_REPORTER_CONTEXT);
  }

  onTestRunStart() {
    this.start = performance.now();
  }

  failure(location, name, errors, args = this.context.args, logs) {
    const rerun = rerunCommand(this.context.workspace, this.context.tier, args);
    console.error(formatFailure({ location, name, errors, logs, rerun }));
  }

  onTestRunEnd(modules, errors, reason) {
    const { workspace, tier, cwd } = this.context;
    const files = [];
    const tests = [];
    for (const module of modules) {
      const file = slash(relative(cwd, module.moduleId));
      files.push(module.state());
      let failedTests = 0;
      for (const test of module.children.allTests()) {
        const result = test.result();
        tests.push(result.state);
        if (result.state !== "failed") continue;
        failedTests++;
        // Vitest displays `fullName` with > separators, but -t matches names joined with spaces.
        const names = [test.name];
        for (let suite = test.parent; suite.type === "suite"; suite = suite.parent)
          names.unshift(suite.name);
        this.failure(
          `${file}:${test.location?.line ?? 1}`,
          test.fullName,
          result.errors ?? [],
          [file, "-t", testPattern(names.join(" "))],
          test.task.logs,
        );
      }
      const reportSuite = (suite) => {
        const suiteErrors = suite.errors();
        if (suiteErrors.length)
          this.failure(
            `${file}:${suite.location?.line ?? 1}`,
            suite.type === "module" ? "File setup/teardown" : suite.fullName,
            suiteErrors,
            [file],
            suite.task.logs,
          );
        for (const child of suite.children.suites()) reportSuite(child);
      };
      reportSuite(module);
      if (
        module.state() === "failed" &&
        !failedTests &&
        !module.errors().length &&
        ![...module.children.allSuites()].some((suite) => suite.errors().length)
      ) {
        this.failure(`${file}:1`, "Test file failed", [], [file]);
      }
    }
    for (const error of errors) this.failure(workspace, "Unhandled error", [error]);
    if (!modules.length && !errors.length && reason === "failed") {
      this.failure(workspace, "No matching test files", [
        { message: "Check the file filter and test tier." },
      ]);
    }
    const duration = performance.now() - (this.start ?? performance.now());
    console.log(formatSummary(workspace, tier, files, tests, duration));
    if (process.connected) process.send("yaat:test-run-reported");
  }
}
