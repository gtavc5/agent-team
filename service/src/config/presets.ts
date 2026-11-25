import { codexBinary } from "../session/codex-rpc";
import type { Backend, PiAvailableModel } from "../session/types";
export type { Backend, LegacyBackend, AnyBackend } from "../session/types";

export interface AgentPreset {
  name: string;
  avatar: string;
  color: string;
  model?: string;
  effort?: string;
  when_to_use?: string;
}

export const AGENT_PRESETS: AgentPreset[] = [
  { name: "Laffey", avatar: "avatars/Laffey.jpg", color: "#D8A0D8" },
  { name: "Allen", avatar: "avatars/Allen.jpg", color: "#8AB4F8" },
  { name: "Perseus", avatar: "avatars/Perseus.jpg", color: "#C0C0C0" },
  { name: "Shorekeeper", avatar: "avatars/Shorekeeper.jpg", color: "#7DD3FC" },
  { name: "Ayanami", avatar: "avatars/Ayanami.jpg", color: "#A5B4FC" },
];

export interface ModelOption {
  id: string;
  label: string;
  backend: Backend;
  effort?: string;
  effortLevels?: string[];
  contextWindow?: number;
  fastTier?: string;
  defaultEffort?: string;
}

const CODEX_EFFORT = ["low", "medium", "high", "xhigh"];
const CODEX_EFFORT_MAX = [...CODEX_EFFORT, "max"];
const CODEX_EFFORT_ULTRA = [...CODEX_EFFORT_MAX, "ultra"];
const CODEX_CONTEXT = 272_000;
const CODEX_CONTEXT_1M = 872_000;
const CODEX_FAST = "priority";

const CODEX_MODELS: ModelOption[] = [
  {
    id: "gpt-6.2-astra",
    label: "GPT-6.2 Astra",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-6.2-astra[1m]",
    label: "GPT-6.2 Astra (1M)",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT_1M,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-6.2-sol",
    label: "GPT-6.2 Sol",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-6.2-sol[1m]",
    label: "GPT-6.2 Sol (1M)",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT_1M,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-6.1-sol[1m]",
    label: "GPT-6.1 Sol (1M)",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT_1M,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-6.1-terra",
    label: "GPT-6.1 Terra",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: 500_000,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-6.1-terra[1m]",
    label: "GPT-6.1 Terra (1M)",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT_1M,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-6-astra[1m]",
    label: "GPT-6 Astra (1M)",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT_1M,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-6-sol[1m]",
    label: "GPT-6 Sol (1M)",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT_1M,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_MAX,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-6-luna[1m]",
    label: "GPT-6 Luna (1M)",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_MAX,
    contextWindow: CODEX_CONTEXT_1M,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    backend: "codex",
    defaultEffort: "low",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-5.6-sol[1m]",
    label: "GPT-5.6 Sol (1M)",
    backend: "codex",
    defaultEffort: "low",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT_1M,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-5.6-terra[1m]",
    label: "GPT-5.6 Terra (1M)",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT_1M,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_MAX,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-5.6-luna[1m]",
    label: "GPT-5.6 Luna (1M)",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_MAX,
    contextWindow: CODEX_CONTEXT_1M,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
];

export function isCodexCliAvailable(): boolean {
  try {
    codexBinary();
    return true;
  } catch {
    return false;
  }
}

export const MODEL_OPTIONS: ModelOption[] = isCodexCliAvailable() ? [...CODEX_MODELS] : [];
export function availableModelOptions(
  piModels: Iterable<PiAvailableModel>,
  opts?: { codexAuthenticated?: boolean },
): ModelOption[] {
  const pi = new Map<string, ModelOption>();
  for (const model of piModels)
    pi.set(model.id, {
      id: model.id,
      backend: "pi",
      label: model.name ?? model.id,
      contextWindow: model.contextWindow,
      effortLevels: model.effortLevels ?? pi.get(model.id)?.effortLevels,
    });
  const codex = (opts?.codexAuthenticated ?? true) ? MODEL_OPTIONS : [];
  return [...codex, ...[...pi.values()].sort((a, b) => a.id.localeCompare(b.id))];
}

export const LEGACY_MODELS: ModelOption[] = [];

export function findModelOption(modelId: string): ModelOption | undefined {
  const base = modelId.replace(/\[1m\]$/, "");
  for (const list of [CODEX_MODELS, LEGACY_MODELS]) {
    const hit = list.find((m) => m.id === modelId) ?? list.find((m) => m.id === base);
    if (hit) return hit;
  }
  return undefined;
}

export function backendForModel(modelId: string): Backend {
  return (
    findModelOption(modelId)?.backend ??
    (!modelId.includes("/") && modelId.startsWith("gpt-") ? "codex" : "pi")
  );
}

export function codexModelId(modelId: string): string {
  return modelId.replace(/\[1m\]$/, "");
}

export function codexContextWindow(modelId: string): number | null {
  const opt = findModelOption(modelId);
  if (opt?.backend !== "codex" || !opt.contextWindow) return null;
  return /\[1m\]$/.test(modelId) ? opt.contextWindow : null;
}

export function supportsFastMode(modelId: string): boolean {
  return Boolean(findModelOption(modelId)?.fastTier);
}

export function codexFastTier(modelId: string): string | null {
  return findModelOption(modelId)?.fastTier ?? null;
}

export function defaultEffortForModel(modelId: string): string | null {
  const opt = findModelOption(modelId);
  return opt?.effort ?? opt?.defaultEffort ?? null;
}

export function effortLevelsForModel(
  modelId: string,
  catalog?: ModelOption[],
): string[] | undefined {
  return (
    catalog?.find((m) => m.id === modelId)?.effortLevels ??
    findModelOption(modelId)?.effortLevels ??
    (backendForModel(modelId) === "pi" ? undefined : [])
  );
}

export function supportsAdaptiveThinking(_modelId: string): boolean {
  return false;
}
