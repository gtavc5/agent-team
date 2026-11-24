import { describe, it, expect } from "vitest";
import {
  MODEL_OPTIONS,
  availableModelOptions,
  backendForModel,
  codexContextWindow,
  codexFastTier,
  codexModelId,
  defaultEffortForModel,
  effortLevelsForModel,
  isCodexCliAvailable,
  supportsAdaptiveThinking,
  supportsFastMode,
} from "../../src/config/presets";

describe("codex model presets", () => {
  it("exposes codex models only when its CLI is available", () => {
    expect(MODEL_OPTIONS.length > 0).toBe(isCodexCliAvailable());
    expect(MODEL_OPTIONS.every((m) => m.backend === "codex")).toBe(true);
  });

  it("filters unauthenticated native codex models while keeping Pi openai-codex/* models intact", () => {
    const piModels = [
      {
        id: "openai-codex/gpt-5.4",
        provider: "openai-codex",
        modelId: "gpt-5.4",
        name: "GPT-5.4 (Pi)",
        effortLevels: ["low", "high"],
      },
      {
        id: "anthropic/claude-opus-5-5",
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        name: "Opus 5.5",
      },
    ];

    const gated = availableModelOptions(piModels, { codexAuthenticated: false });
    expect(gated.some((m) => m.backend === "codex")).toBe(false);
    expect(gated.map((m) => [m.id, m.backend])).toEqual([
      ["anthropic/claude-opus-5-5", "pi"],
      ["openai-codex/gpt-5.4", "pi"],
    ]);

    const unlocked = availableModelOptions(piModels, { codexAuthenticated: true });
    expect(unlocked.filter((m) => m.backend === "codex")).toEqual(MODEL_OPTIONS);
    expect(unlocked.some((m) => m.id === "openai-codex/gpt-5.4" && m.backend === "pi")).toBe(true);
  });

  it("maps the 1M suffix to a context window override and a plain CLI model id", () => {
    expect(codexModelId("gpt-6-astra[1m]")).toBe("gpt-6-astra");
    expect(codexContextWindow("gpt-6-astra[1m]")).toBe(872_000);
    expect(codexContextWindow("gpt-6-astra")).toBeNull();
    expect(codexContextWindow("provider/model[1m]")).toBeNull();
  });

  it("knows codex fast mode and effort", () => {
    expect(supportsFastMode("gpt-6-astra[1m]")).toBe(true);
    expect(codexFastTier("gpt-6-astra")).toBe("priority");
    expect(defaultEffortForModel("gpt-6-astra")).toBe("medium");
    expect(effortLevelsForModel("gpt-5.5")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(supportsFastMode("unknown-model")).toBe(false);
    expect(supportsAdaptiveThinking("gpt-6-astra")).toBe(false);
  });

  it("routes known and unknown gpt ids to codex and all other models to Pi", () => {
    expect(backendForModel("gpt-5.6-luna[1m]")).toBe("codex");
    expect(backendForModel("gpt-7-unknown")).toBe("codex");
    expect(backendForModel("anthropic/claude-opus-6")).toBe("pi");
    expect(backendForModel("provider/model")).toBe("pi");
    expect(backendForModel("unknown-model")).toBe("pi");
  });
});
