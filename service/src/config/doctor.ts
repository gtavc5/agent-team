import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config";
import { runtimeReport, serviceReport, type RuntimeReport } from "./diagnostics";
import { applyRuntimeEnvironment, RuntimeConfigError } from "./runtime";
import { probeModelDiscovery } from "../server/model-discovery";
import { inspectPiAcpProfile } from "../session/pi-agent-home";

export async function doctor(baseDir: string): Promise<{ report: RuntimeReport; ok: boolean }> {
  let config;
  try {
    config = loadConfig(baseDir);
  } catch (error) {
    const report = runtimeReport(baseDir);
    const source = report.facts.config.value;
    const missing = !fs.existsSync(source);
    const line = (error as { line?: number })?.line;
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
            : "invalid configuration",
      impact: "The service cannot load its configuration.",
      nextStep: missing
        ? "Run scripts/yaat-service.sh init-config with the intended --base-dir."
        : "Check config.toml against config.example.toml, then rerun diagnostics.",
    });
    return { report, ok: false };
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "yaat-doctor-"));
  try {
    applyRuntimeEnvironment(config.server.proxy, config.pi?.acp?.binary);
    const profile = inspectPiAcpProfile(path.resolve(baseDir, "pi-agent-home"), config.pi?.acp);
    const probeConfig =
      profile.status === "invalid" && config.pi
        ? {
            ...config,
            pi: {
              ...config.pi,
              exclude_packages: [
                ...(config.pi.exclude_packages ?? []),
                "pi-antigravity-acp-provider",
              ],
            },
          }
        : config;
    const discovery = await probeModelDiscovery(probeConfig, scratch);
    const report = serviceReport(baseDir, config, discovery);
    const acpBlocked = report.issues.some((issue) => issue.code === "acp_runtime_missing");
    return {
      report,
      ok: discovery.models.some((model) => !acpBlocked || !model.id.startsWith("antigravity-acp/")),
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
