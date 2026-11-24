import { inspectAcpRuntime } from "../session/acp-readiness";
import type { DiagnosticIssue } from "./diagnostics";

export interface ModelDiscoveryIssue extends DiagnosticIssue {
  stage: "model-discovery" | "model-selection";
  code:
    | "pi_not_configured"
    | "pi_cli_missing"
    | "pi_unauthenticated"
    | "pi_models_filtered"
    | "pi_catalog_failed"
    | "codex_cli_missing"
    | "codex_unauthenticated"
    | "codex_auth_failed"
    | "no_models_available"
    | "invalid_explicit_model"
    | "configured_model_unavailable";
  source:
    | "pi"
    | "pi-cli"
    | "pi-catalog"
    | "codex-cli"
    | "codex-account"
    | "model-catalog"
    | "request.model"
    | "agent_presets.model"
    | "projects.model"
    | "pi.default_model";
}

export class ModelSelectionError extends Error {
  constructor(readonly issue: ModelDiscoveryIssue) {
    super(`${issue.impact} ${issue.nextStep}`);
    this.name = "ModelSelectionError";
  }
}

export function invalidExplicitModel(
  source: "request.model" | "agent_presets.model",
): ModelSelectionError {
  return new ModelSelectionError({
    stage: "model-selection",
    code: "invalid_explicit_model",
    // Invalid model input might be a pasted credential, not a model ID.
    value: null,
    source,
    impact: "The selected model is not in the available model catalog.",
    nextStep: "Choose an available model or check the provider setup.",
  });
}

export function noModelsAvailable(): ModelSelectionError {
  return new ModelSelectionError({
    stage: "model-discovery",
    code: "no_models_available",
    value: null,
    source: "model-catalog",
    impact: "No models are available to start a session.",
    nextStep: "Set up Pi with a provider or sign in to Codex, then check the model catalog.",
  });
}

export function selectDefaultModel(
  models: readonly string[],
  configured: string | undefined,
): string | undefined {
  if (configured && models.includes(configured)) return configured;
  const first = models[0];
  if (first?.startsWith("antigravity-acp/") && !inspectAcpRuntime().ready)
    return models.find((id) => !id.startsWith("antigravity-acp/")) ?? first;
  return first;
}
