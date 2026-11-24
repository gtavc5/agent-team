import * as fs from "node:fs";
import * as path from "node:path";

import type { AppConfig } from "./config";
import { inspectPiAcpProfile } from "../session/pi-agent-home";
import type { ModelDiscoverySnapshot } from "../server/model-discovery";
import { inspectAcpRuntime, ACP_PREPARE_STEP } from "../session/acp-readiness";

export interface DiagnosticIssue {
  stage: string;
  code: string;
  value: string | null;
  source: string;
  impact: string;
  nextStep: string;
}

export interface RuntimeReport {
  facts: Record<string, { value: string; source: string }>;
  issues: DiagnosticIssue[];
}

export function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function findExecutable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  return (env.PATH ?? "")
    .split(path.delimiter)
    .filter(path.isAbsolute)
    .map((dir) => path.join(dir, name))
    .find(executable);
}

export function runtimeReport(
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeReport {
  const config = path.resolve(baseDir, "config.toml");
  const pi = env.YAAT_PI_BIN ?? findExecutable("pi", env);
  const report: RuntimeReport = {
    facts: {
      config: {
        value: config,
        source: env.AGENT_TEAM_BASE_DIR ? "AGENT_TEAM_BASE_DIR" : "base directory",
      },
      node: {
        value: `${process.execPath} (${process.version})`,
        source: env.YAAT_RUNTIME_PINS ?? "running process",
      },
      pi: {
        value: pi ?? "not found",
        source: env.YAAT_RUNTIME_PINS ?? (env.YAAT_PI_BIN ? "YAAT_PI_BIN" : "PATH"),
      },
    },
    issues: [],
  };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    const source = env[key.toLowerCase()] ? key.toLowerCase() : env[key] ? key : undefined;
    report.facts[key] = {
      value: source ? "set (redacted)" : "unset",
      source: source ?? "process environment",
    };
  }
  return report;
}

export function serviceReport(
  baseDir: string,
  config: AppConfig,
  discovery: ModelDiscoverySnapshot,
  env = process.env,
): RuntimeReport {
  const report = runtimeReport(baseDir, env);
  const acp = inspectAcpRuntime(env);
  const settings = config.pi?.acp;
  report.facts.models = {
    value: String(discovery.models.length),
    source: "Pi catalog and native Codex account probe",
  };
  report.facts.acpReadiness = {
    value: acp.ready ? "executable found" : "not ready",
    source: "local executable check (no download)",
  };
  report.facts.acpRuntime = {
    value:
      acp.source === "env" && !acp.ready ? "invalid override (redacted)" : acp.value || "not found",
    source: settings?.binary ? "config.toml: pi.acp.binary" : acp.source,
  };
  report.facts.acpPermissions = {
    value: settings?.permissions ?? "yolo",
    source: settings?.permissions ? "config.toml: pi.acp.permissions" : "YAAT default",
  };
  report.facts.acpRuntimeUpdates = {
    value: settings?.runtime_updates ?? "manual",
    source: settings?.runtime_updates ? "config.toml: pi.acp.runtime_updates" : "YAAT default",
  };
  report.facts.defaultModel = {
    value: discovery.defaultModel ?? "none",
    source:
      discovery.defaultModel && discovery.defaultModel === config.projects.model
        ? "config.toml: projects.model"
        : discovery.defaultModel && discovery.defaultModel === config.pi?.default_model
          ? "config.toml: pi.default_model"
          : "available model catalog",
  };
  const profile = inspectPiAcpProfile(path.resolve(baseDir, "pi-agent-home"), settings);
  report.facts.acpProfile = { value: profile.status, source: profile.path };
  if (
    profile.status === "invalid" &&
    !config.pi?.exclude_packages?.includes("pi-antigravity-acp-provider")
  ) {
    report.issues.push({
      stage: "acp",
      code: "acp_profile_invalid",
      source: profile.path,
      value: profile.reason,
      impact: "ACP cannot use the managed profile. Other configured providers can still be used.",
      nextStep: "Repair the profile JSON, then restart the affected Pi session.",
    });
  }
  for (const key of Object.keys(config.server.proxy ?? {}))
    report.facts[key.toUpperCase()].source = `config.toml: server.proxy.${key}`;
  report.issues.push(...discovery.issues);
  if (
    !acp.ready &&
    (settings ||
      env.AGY_ACP_BIN ||
      discovery.models.some((m) => m.id.startsWith("antigravity-acp/")))
  ) {
    report.issues.push({
      stage: "acp",
      code: "acp_runtime_missing",
      ...report.facts.acpRuntime,
      impact: "ACP prompts and quota are blocked. Other configured providers can still be used.",
      nextStep: ACP_PREPARE_STEP,
    });
  }
  if (env.AGY_ACP_BIN)
    report.issues.push({
      stage: "acp",
      code: "acp_permissions_unverified",
      value: "unverified",
      source: report.facts.acpRuntime.source,
      impact: "The requested permission mode does not prove that the external binary enforces it.",
      nextStep: "Verify the effective permission mode of your external runtime before using it.",
    });
  return report;
}

export function formatReport(report: RuntimeReport): string {
  return [
    ...Object.entries(report.facts).map(([key, fact]) => `${key}: ${fact.value} [${fact.source}]`),
    ...report.issues.map(
      (issue) =>
        `\n[${issue.stage}/${issue.code}] ${issue.value ?? "—"} (${issue.source})\n${issue.impact}\nNext: ${issue.nextStep}`,
    ),
  ].join("\n");
}
