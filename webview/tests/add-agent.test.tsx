// A new agent: its model, and the reasoning effort the model takes.
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { AddAgentDialog } from "../src/workspace/dialogs";
import type { ModelOption } from "../src/state/useServer";

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
  { id: "openai/gpt-5.5", label: "GPT 5.5", backend: "pi", effortLevels: [] },
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    backend: "codex",
    effortLevels: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
];

const dialog = () => {
  const onAdd = vi.fn();
  const utils = render(
    <AddAgentDialog
      presets={[{ name: "Kisara", avatar: "k.jpg", color: "#D8A0D8" }]}
      models={models}
      onClose={() => {}}
      onAdd={onAdd}
    />,
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
