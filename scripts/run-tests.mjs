import { fork, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { entryHint, rerunCommand, useNativeReporter } from "./test-reporter.mjs";

const [workspace, tier, ...args] = process.argv.slice(2);
const script = fileURLToPath(import.meta.url);
const repo = dirname(dirname(script));

function runNode(args, cwd) {
  const child = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  if (child.error) throw child.error;
  return child.status ?? 1;
}

function timed(label, budgetMs, run) {
  const start = performance.now();
  const status = run();
  const duration = performance.now() - start;
  const observation = `[${label}] ${(duration / 1000).toFixed(2)}s (reference budget ${budgetMs / 1000}s)`;
  if (duration > budgetMs) console.warn(`${observation}; duration above baseline (warning only)`);
  else console.log(observation);
  return status;
}

function runRoot() {
  const run = (workspace, tier, flags = []) =>
    runNode([script, workspace, tier, ...flags], join(repo, workspace));
  switch (tier) {
    case "unit":
      return run("service", tier, args) || run("webview", tier, args);
    case "fast": {
      const local = () => run("service", tier, args) || run("webview", tier, args);
      // Explicit Vitest arguments keep their original workspace scope.
      if (args.length) return local();
      return timed("fast", 25_000, () => local() || run("service", "e2e", ["journey-pilot-queue"]));
    }
    case "browser":
      return run("webview", tier, args);
    case "e2e":
      return run("service", tier, args);
    case "slow":
      if (!process.env.npm_execpath) throw new Error("Launch this tier with npm run test:slow.");
      return timed(
        "slow",
        270_000,
        () =>
          runNode([process.env.npm_execpath, "run", "check"], repo) ||
          run("service", "unit") ||
          run("webview", "unit") ||
          run("webview", "browser", ["--from-slow"]) ||
          run("service", "e2e", ["--from-slow"]),
      );
  }
  throw new Error(`Unknown test tier: ${tier}`);
}

async function runWorkspace() {
  const cwd = process.cwd();
  const require = createRequire(join(cwd, "package.json"));
  const vitest = dirname(require.resolve("vitest/package.json"));
  const cli = join(vitest, "vitest.mjs");
  const config = {
    fast: "vitest.fast.config.mjs",
    browser: "vitest.browser.config.ts",
    e2e: "vitest.e2e.config.mjs",
  }[tier];
  const fromSlow = args[0] === "--from-slow";
  if (fromSlow) args.shift();
  const flags = [...(config ? ["--config", config] : []), ...args];
  if (flags.some((arg) => ["-h", "--help", "-v", "--version"].includes(arg))) {
    return runNode([cli, "run", ...flags], cwd);
  }
  const { parseCLI } = await import(pathToFileURL(require.resolve("vitest/node")).href);
  const { filter, options } = parseCLI(["vitest", "run", ...flags]);
  const hint = entryHint(tier, filter, options, process.env, fromSlow);
  // Keep machine-readable native stdout intact.
  if (hint) (options.reporter ? console.error : console.log)(hint);
  const delimiter = flags.indexOf("--");
  const insert = (extra) => flags.splice(delimiter < 0 ? flags.length : delimiter, 0, ...extra);
  if (
    useNativeReporter(options, process.env) ||
    options.watch ||
    options.ui ||
    options.standalone
  ) {
    if (!options.reporter && process.env.VERBOSE === "1") insert(["--reporter=verbose"]);
    return runNode([cli, "run", ...flags], cwd);
  }

  // Run the real CLI, not startVitest directly: the CLI validates arguments and normalizes options.
  insert([
    "--no-color",
    "--includeTaskLocation",
    "--silent=passed-only",
    `--reporter=${join(repo, "scripts/test-reporter.mjs").replaceAll("\\", "/")}`,
  ]);
  const child = fork(cli, ["run", ...flags], {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      YAAT_TEST_REPORTER_CONTEXT: JSON.stringify({ workspace, tier, args, cwd }),
    },
  });
  let reported = false;
  child.on("message", (message) => {
    if (message === "yaat:test-run-reported") reported = true;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code && !reported) console.error(`Rerun: ${rerunCommand(workspace, tier, args)}`);
      resolve(code ?? 1);
    });
  });
}

process.exitCode = workspace === "root" ? runRoot() : await runWorkspace();
