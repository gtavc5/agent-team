import { describe, it, expect } from "vitest";
import {
  MODEL_OPTIONS,
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
