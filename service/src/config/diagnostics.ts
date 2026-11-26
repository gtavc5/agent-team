import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AppConfig } from "./config";
import type { ProxyHealth } from "../acp-proxy/metrics";
import {
  inspectPiAcpProfile,
  inspectRuntimePiPackages,
  packageName,
} from "../session/pi-agent-home";
import { inspectPiAcpLocalAuth, PI_ACP_PACKAGE } from "../session/pi-acp-auth";
import type { ModelDiscoverySnapshot } from "../server/model-discovery";
import { inspectAcpRuntime, ACP_PREPARE_STEP } from "../session/acp-readiness";

export interface DiagnosticIssue {
  severity?: "info" | "warning";
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
  ccpaProxy: ProxyHealth | null;
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
      acpRemoteAuth: {
        value: "unverified offline",
        source: "no ACP request or token refresh performed by diagnostics",
      },
    },
    issues: [],
    ccpaProxy: null,
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
  discovery: ModelDiscoverySnapshot | undefined,
  env = process.env,
  ccpaProxy: ProxyHealth | null = null,
): RuntimeReport {
  const report = runtimeReport(baseDir, env);
  report.ccpaProxy = ccpaProxy;
  const settings = config.pi?.acp;
  const acpExcluded = config.pi?.exclude_packages?.some(
    (entry) => packageName(entry) === PI_ACP_PACKAGE,
  );
  const acp = inspectAcpRuntime(settings?.binary ? { ...env, AGY_ACP_BIN: settings.binary } : env);
  report.facts.models = discovery
    ? {
        value: String(discovery.models.length),
        source: "Pi catalog and native Codex account probe",
      }
    : { value: "unverified offline", source: "no backend or extension started by preflight" };
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
  if (discovery)
    report.facts.defaultModel = {
      value: discovery.defaultModel ?? "none",
      source:
        discovery.defaultModel && discovery.defaultModel === config.projects.model
          ? "config.toml: projects.model"
          : discovery.defaultModel && discovery.defaultModel === config.pi?.default_model
            ? "config.toml: pi.default_model"
            : "available model catalog",
    };
  const managedHome = path.resolve(baseDir, "pi-agent-home");
  const profile = inspectPiAcpProfile(managedHome, settings);
  report.facts.acpProfile = { value: profile.status, source: profile.path };
  if (profile.status === "invalid" && !acpExcluded) {
    report.issues.push({
      stage: "acp",
      code: "acp_profile_invalid",
      source: profile.path,
      value: profile.reason,
      impact: "ACP cannot use the managed profile. Other configured providers can still be used.",
      nextStep: "Repair the profile JSON, then restart the affected Pi session.",
    });
  }
  const hostHome = path.resolve(
    (process.platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir(),
    ".pi",
    "agent",
  );
  let acpEnabled = false;
  try {
    acpEnabled = Boolean(
      inspectRuntimePiPackages(hostHome, config.pi?.packages, config.pi?.exclude_packages)
        .piAntigravityEntryPath,
    );
  } catch {
    report.issues.push({
      stage: "pi-local",
      code: "pi_package_resolution_failed",
      value: "unable to read Pi settings or resolve configured local packages",
      source: hostHome,
      impact:
        "Pi may not start with these packages. This does not prevent the panel from starting.",
      nextStep: "Check host Pi settings and the package paths in config.toml.",
    });
  }
  if (acpEnabled) {
    const auth = inspectPiAcpLocalAuth(hostHome, managedHome, env);
    report.facts.acpLocalAuth = {
      value: auth.status === "present" ? auth.reason : auth.status,
      source: auth.source,
    };
    if (auth.nextStep)
      report.issues.push({
        stage: "acp-local-auth",
        code: `acp_auth_${auth.status}`,
        value: auth.reason,
        source: auth.source,
        impact: "ACP may not be usable. Other configured providers are not blocked.",
        nextStep: auth.nextStep,
      });
  } else if (settings && !acpExcluded) {
    report.issues.push({
      stage: "acp-local-auth",
      code: "acp_provider_unavailable",
      value: "no enabled local ACP provider extension found",
      source: hostHome,
      impact: "ACP cannot use the configured profile without the provider extension.",
      nextStep:
        "Check that the service user's Pi has pi-antigravity-acp-provider installed and enabled.",
    });
  }
  for (const [key, value] of Object.entries(config.server.proxy ?? {}))
    report.facts[key.toUpperCase()] = {
      value: value ? "set (redacted)" : "unset",
      source: `config.toml: server.proxy.${key}`,
    };
  report.issues.push(...(discovery?.issues ?? []));
  if (
    !acpExcluded &&
    !acp.ready &&
    (acpEnabled ||
      settings ||
      env.AGY_ACP_BIN ||
      discovery?.models.some((m) => m.id.startsWith("antigravity-acp/")))
  ) {
    report.issues.push({
      stage: "acp",
      code: "acp_runtime_missing",
      ...report.facts.acpRuntime,
      impact: "ACP prompts and quota are blocked. Other configured providers can still be used.",
      nextStep: ACP_PREPARE_STEP,
    });
  }
  if (!acpExcluded && (settings?.binary || env.AGY_ACP_BIN))
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
    ...(report.ccpaProxy
      ? Object.entries(report.ccpaProxy).map(
          ([key, value]) => `ccpaProxy.${key}: ${JSON.stringify(value)}`,
        )
      : ["ccpaProxy: not running"]),
    ...report.issues.map(
      (issue) =>
        `\n${issue.severity === "info" ? "[info] " : ""}[${issue.stage}/${issue.code}] ${issue.value ?? "—"} (${issue.source})\n${issue.impact}\nNext: ${issue.nextStep}`,
    ),
  ].join("\n");
}
