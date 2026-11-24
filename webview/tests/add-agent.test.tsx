// A new agent: its model, and the reasoning effort the model takes.
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { AddAgentDialog } from "../src/workspace/dialogs";
import type { AgentPreset, ModelOption } from "../src/state/useServer";

const models: ModelOption[] = [
  {
    id: "anthropic/claude-opus-5-5",
    label: "Opus 5.5",
    backend: "pi",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "google/gemini-4-argon",
    label: "Gemini 4 Argon",
    backend: "pi",
    effortLevels: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  { id: "openai/gpt-5.5", label: "GPT 5.5", backend: "pi", effortLevels: ["off"] },
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    backend: "codex",
    effortLevels: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
];

const dialog = (
  presets: AgentPreset[] = [{ name: "Kisara", avatar: "k.jpg", color: "#D8A0D8" }],
) => {
  const onAdd = vi.fn();
  const utils = render(
    <AddAgentDialog presets={presets} models={models} onClose={() => {}} onAdd={onAdd} />,
  );
  const model = () => utils.getByText("Model").parentElement!.querySelector("select")!;
  const effort = () => utils.queryByLabelText("Reasoning effort") as HTMLSelectElement | null;
  const levels = () => [...effort()!.options].map((o) => o.textContent);
  return { ...utils, onAdd, model, effort, levels };
};

describe("adding an agent", () => {
  it("offers the effort levels of the model chosen, its default first", () => {
    const d = dialog();
    expect(d.levels()).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    fireEvent.change(d.model(), { target: { value: "google/gemini-4-argon" } });
    expect(d.levels()).toEqual(["default (medium)", "low", "medium", "high"]);
    fireEvent.change(d.model(), { target: { value: "openai/gpt-5.5" } });
    expect(d.effort()).toBeNull();
  });

  it("adds it at the effort chosen, kept across models that have it", () => {
    const d = dialog();
    fireEvent.change(d.effort()!, { target: { value: "high" } });
    fireEvent.change(d.model(), { target: { value: "google/gemini-4-argon" } });
    expect(d.effort()!.value).toBe("high");
    fireEvent.change(d.model(), { target: { value: "anthropic/claude-opus-5-5" } });
    fireEvent.change(d.effort()!, { target: { value: "max" } });
    fireEvent.change(d.model(), { target: { value: "google/gemini-4-argon" } });
    expect(d.effort()!.value).toBe("");
    fireEvent.change(d.effort()!, { target: { value: "low" } });
    fireEvent.click(d.getByText("Add"));
    expect(d.onAdd).toHaveBeenCalledWith(
      "Kisara",
      "google/gemini-4-argon",
      "k.jpg",
      "#D8A0D8",
      "low",
    );
  });

  it("selects available preset defaults on open and on click", () => {
    const base = { avatar: "a", color: "red" };
    const d = dialog([
      { ...base, name: "A", model: models[1].id, effort: "high" },
      { ...base, name: "B", model: models[0].id, effort: "max" },
      { ...base, name: "C", model: "missing", effort: "low" },
      { ...base, name: "D", model: models[1].id, effort: "max" },
    ]);
    expect([d.model().value, d.effort()!.value]).toEqual([models[1].id, "high"]);
    fireEvent.click(d.getByText("B"));
    expect([d.model().value, d.effort()!.value]).toEqual([models[0].id, "max"]);
    fireEvent.click(d.getByText("C"));
    expect([d.model().value, d.effort()!.value]).toEqual([models[0].id, ""]);
    fireEvent.click(d.getByText("D"));
    expect([d.model().value, d.effort()!.value]).toEqual([models[1].id, ""]);
  });

  it("groups the models by backend", () => {
    const d = dialog();
    const groups = [...d.model().querySelectorAll("optgroup")].map((g) => [
      g.label,
      [...g.querySelectorAll("option")].map((o) => o.value),
    ]);
    expect(groups).toEqual([
      ["Pi", ["anthropic/claude-opus-5-5", "google/gemini-4-argon", "openai/gpt-5.5"]],
      ["Codex", ["gpt-6-astra"]],
    ]);
  });

  it("leaves the effort to the model when none is chosen", () => {
    const d = dialog();
    fireEvent.click(d.getByText("Add"));
    expect(d.onAdd.mock.calls[0][4]).toBeUndefined();
  });
});
