import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AppConfig } from "../config/config";
import { selectDefaultModel, type ModelDiscoveryIssue } from "../config/model-diagnostics";
import { availableModelOptions, backendForModel, type ModelOption } from "../config/presets";
import { codexProcessEnv, probeCodexAuth, type CodexAuthState } from "../session/codex";
import { LocalHost, type Host } from "../session/host";
import { PiModelsFilteredError } from "../session/pi";
import type { Backend, PiAvailableModel, SessionConfig } from "../session/types";

export type { ModelDiscoveryIssue } from "../config/model-diagnostics";

export interface ModelDiscoverySnapshot {
  models: ModelOption[];
  defaultModel: string | null;
  issues: ModelDiscoveryIssue[];
}

export type PiRuntimeSessionConfig = Pick<
  SessionConfig,
  "piPackages" | "piExcludePackages" | "piOffline" | "piAcp"
>;

export function piSessionConfig(config: AppConfig): PiRuntimeSessionConfig {
  const { proxy: _proxy, ...acp } = config.pi?.acp ?? {};
  return {
    piPackages: config.pi?.packages ? [...config.pi.packages] : undefined,
    piExcludePackages: config.pi?.exclude_packages ? [...config.pi.exclude_packages] : undefined,
    piOffline: config.pi?.offline,
    piAcp: config.pi?.acp ? acp : undefined,
  };
}

interface PiCatalog {
  models: PiAvailableModel[];
  issue?: ModelDiscoveryIssue;
}

export async function probePiCatalog(
  config: AppConfig,
  dataDir: string,
  host: Host | undefined,
): Promise<PiCatalog> {
  const unavailable = (issue: Omit<ModelDiscoveryIssue, "stage">): PiCatalog => ({
    models: [],
    issue: { stage: "model-discovery", ...issue },
  });
  if (!config.pi) {
    return unavailable({
      code: "pi_not_configured",
      value: null,
      source: "pi",
      impact: "Startup Pi model discovery is disabled.",
      nextStep: "Add a [pi] section to config.toml to discover Pi models at startup.",
    });
  }
  try {
    if (!host?.discoverPiModels) throw new Error("Host cannot discover Pi models");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaat-pi-catalog-"));
    let models: PiAvailableModel[];
    try {
      models = await host.discoverPiModels({
        ...piSessionConfig(config),
        backend: "pi",
        cwd: dir,
        dataDir,
        piSessionDir: path.join(dir, "sessions"),
        workspaceId: "model-catalog",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return models.length
      ? { models }
      : unavailable({
          code: "pi_unauthenticated",
          value: "pi",
          source: "pi-catalog",
          impact: "Pi found no models with usable provider credentials.",
          nextStep:
            "Sign in to a provider in Pi or configure its credentials for the service user.",
        });
  } catch (error) {
    const err = error as NodeJS.ErrnoException | undefined;
    if (err?.code === "ENOENT" && err.syscall?.startsWith("spawn ")) {
      return unavailable({
        code: "pi_cli_missing",
        value: "pi",
        source: "pi-cli",
        impact: "The service could not start Pi: the executable was not found.",
        nextStep:
          "Install Pi as the service user. If its path changed, rerun scripts/yaat-service.sh install to update the instance pin.",
      });
    }
    if (error instanceof PiModelsFilteredError) {
      return unavailable({
        code: "pi_models_filtered",
        value: null,
        source: "pi-catalog",
        impact: "Pi found models, but none matched enabledModels.",
        nextStep: "Review enabledModels in the Pi settings.",
      });
    }
    // Startup and RPC errors can contain credentials, paths or provider output.
    return unavailable({
      code: "pi_catalog_failed",
      value: "pi",
      source: "pi-catalog",
      impact: "Pi did not return a usable model catalog.",
      nextStep:
        "Check that Pi starts with the configured packages and provider settings, then retry.",
    });
  }
}

export function codexModelIssue(status: CodexAuthState["status"]): ModelDiscoveryIssue | undefined {
  switch (status) {
    case "authenticated":
      return undefined;
    case "unavailable":
      return {
        stage: "model-discovery",
        code: "codex_cli_missing",
        value: "codex",
        source: "codex-cli",
        impact: "The Codex CLI is unavailable to the service.",
        nextStep: "Install the Codex CLI used by the service.",
      };
    case "unauthenticated":
      return {
        stage: "model-discovery",
        code: "codex_unauthenticated",
        value: "codex",
        source: "codex-account",
        impact: "Native Codex models are unavailable because Codex is not signed in.",
        nextStep:
          "Run npx codex login in the repository as the service user, then recheck authentication.",
      };
    case "error":
      return {
        stage: "model-discovery",
        code: "codex_auth_failed",
        value: "codex",
        source: "codex-account",
        impact: "The service could not check Codex authentication.",
        nextStep: "Check that Codex starts and can read the service user's account, then retry.",
      };
  }
}

function hasCodexCredentials(env: NodeJS.ProcessEnv): boolean {
  if (env.OPENAI_API_KEY !== undefined || env.CODEX_API_KEY !== undefined) return true;
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try {
    fs.lstatSync(path.join(codexHome, "auth.json"));
    return true;
  } catch (error) {
    // An inaccessible credential path is not evidence that Codex was never set up.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export function describeModelDiscovery(
  config: AppConfig,
  models: ModelOption[],
  piIssue: ModelDiscoveryIssue | undefined,
  codexStatus: CodexAuthState["status"],
  context: {
    liveBackends?: Iterable<Backend>;
    codexPreviouslyAuthenticated?: boolean;
    codexEnv?: NodeJS.ProcessEnv;
  } = {},
): ModelDiscoverySnapshot {
  const configured = config.projects.model || config.pi?.default_model;
  const defaultModel =
    selectDefaultModel(
      models.map((model) => model.id),
      configured,
    ) ?? null;
  const referenced = new Set(context.liveBackends);
  for (const id of [
    config.projects.model,
    config.pi?.default_model,
    ...config.presets.map((p) => p.model),
  ]) {
    if (id) referenced.add(models.find((m) => m.id === id)?.backend ?? backendForModel(id));
  }
  const codexIssue = codexModelIssue(codexStatus);
  const issues: ModelDiscoveryIssue[] = [];
  if (piIssue) {
    const optional =
      piIssue.code === "pi_not_configured" &&
      models.some((model) => model.backend === "codex") &&
      !referenced.has("pi");
    issues.push({ ...piIssue, severity: optional ? "info" : "warning" });
  }
  if (codexIssue) {
    const optional =
      (codexStatus === "unauthenticated" || codexStatus === "unavailable") &&
      models.some((model) => model.backend === "pi") &&
      !referenced.has("codex") &&
      !context.codexPreviouslyAuthenticated &&
      !hasCodexCredentials(context.codexEnv ?? codexProcessEnv());
    issues.push({ ...codexIssue, severity: optional ? "info" : "warning" });
  }
  if (configured && configured !== defaultModel) {
    issues.push({
      severity: "warning",
      stage: "model-selection",
      code: "configured_model_unavailable",
      value: null,
      source: config.projects.model ? "projects.model" : "pi.default_model",
      impact: defaultModel
        ? "The configured default is unavailable; the first available model will be used."
        : "The configured default is unavailable and there is no model to fall back to.",
      nextStep: "Select an available default model in config.toml or check the provider setup.",
    });
  }
  return { models: models.slice(), defaultModel, issues };
}

// Use a scratch dataDir so the probe does not rewrite the running service's Pi home.
// This checks real backend availability without starting a model turn.
export async function probeModelDiscovery(
  config: AppConfig,
  dataDir: string,
): Promise<ModelDiscoverySnapshot> {
  const host = new LocalHost("model-catalog", "Model catalog");
  try {
    const codexEnv = codexProcessEnv();
    const [pi, codex] = await Promise.all([
      probePiCatalog(config, dataDir, host),
      probeCodexAuth(codexEnv),
    ]);
    const models = availableModelOptions(pi.models, { codexAuthenticated: codex.authenticated });
    return describeModelDiscovery(config, models, pi.issue, codex.status, { codexEnv });
  } finally {
    await host.close();
  }
}
