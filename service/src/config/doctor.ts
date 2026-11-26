import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "./config";
import { runtimeReport, serviceReport, type RuntimeReport } from "./diagnostics";
import { RuntimeConfigError } from "./runtime";

// Inspect candidate inputs, not a running Server or scratch backend. Even an
// offline Pi extension or Codex process can write to the real user's home.
export function doctor(baseDir: string): { report: RuntimeReport; ok: boolean } {
  let config;
  try {
    config = loadConfig(baseDir);
  } catch (error) {
    const report = runtimeReport(baseDir);
    const source = report.facts.config.value;
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT" || !fs.existsSync(source);
    const line = (error as { line?: number })?.line;
    report.facts.startup = { value: "blocked", source: "configuration check" };
    report.issues.push({
      stage: "config",
      code: missing ? "CONFIG_MISSING" : "CONFIG_INVALID",
      source,
      value: missing
        ? "not found"
        : error instanceof RuntimeConfigError
          ? error.message
          : typeof line === "number"
            ? `invalid TOML at line ${line + 1}`
            : "invalid or unreadable configuration",
      impact: "Startup blocker: the service cannot load its configuration.",
      nextStep: missing
        ? "Run scripts/yaat-service.sh init-config with the intended --base-dir."
        : "Check config.toml against config.example.toml, then rerun diagnostics.",
    });
    return { report, ok: false };
  }

  const report = serviceReport(baseDir, config, undefined);
  const blocker = (code: string, source: string, value: string, nextStep: string) => {
    report.issues.push({
      stage: "startup",
      code,
      source,
      value,
      impact: "Startup blocker: the service cannot start with these inputs.",
      nextStep,
    });
  };
  if (Number(process.versions.node.split(".")[0]) < 26)
    blocker(
      "NODE_UNSUPPORTED",
      process.execPath,
      "Node.js 26 or newer is required",
      "Select a supported Node.js runtime.",
    );

  const uploads = path.resolve(baseDir, "uploads");
  try {
    const exists = fs.lstatSync(uploads, { throwIfNoEntry: false });
    if (exists && !fs.statSync(uploads).isDirectory()) throw new Error("not a directory");
    fs.accessSync(exists ? uploads : baseDir, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    blocker(
      "UPLOADS_UNAVAILABLE",
      uploads,
      "the upload directory cannot be created or accessed",
      "Check the base directory and upload path permissions.",
    );
  }

  const projects = path.resolve(baseDir, ".agent-team", "projects");
  try {
    if (fs.statSync(projects, { throwIfNoEntry: false })) fs.readdirSync(projects);
  } catch {
    blocker(
      "PROJECTS_UNREADABLE",
      projects,
      "the project store is not a readable directory",
      "Check the project store path and permissions.",
    );
  }

  const ok = !report.issues.some((issue) => issue.stage === "startup");
  report.facts.startup = {
    value: ok ? "offline checks passed" : "blocked",
    source: "candidate configuration and local startup inputs",
  };
  return { report, ok };
}
