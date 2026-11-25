import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TargetAgentSelect } from "../src/composer/TargetAgentSelect";
import {
  clearConflictingMention,
  extractMentionName,
  findMentionedAgent,
  getDefaultAgent,
  resolveTargetState,
} from "../src/composer/targetRouting";
import { resetLocaleForTests, setLocaleOverride } from "../src/i18n";
import type { AgentInfo } from "../src/state/useServer";

const makeAgent = (id: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  name: id,
  model: "claude-opus-5-5",
  avatar: "A",
  color: "#fff",
  isDefault: false,
  ...over,
});

const lead = makeAgent("lead", { name: "Lead", isDefault: true });
const coder = makeAgent("coder", { name: "Coder" });
const agents = [lead, coder];

afterEach(() => {
  resetLocaleForTests();
  vi.restoreAllMocks();
});

describe("extractMentionName", () => {
  it("extracts the first @token at the start or after whitespace", () => {
    expect(extractMentionName("@Coder fix this")).toBe("Coder");
    expect(extractMentionName("please @Coder fix this")).toBe("Coder");
    expect(extractMentionName("  @Lead")).toBe("Lead");
  });

  it("returns null when no mention token is present", () => {
    expect(extractMentionName("plain text")).toBeNull();
    expect(extractMentionName("foo@bar is not a mention")).toBeNull();
    expect(extractMentionName("")).toBeNull();
  });
});

describe("findMentionedAgent", () => {
  it("finds the agent whose name matches the mention", () => {
    expect(findMentionedAgent("@Coder hi", agents)).toBe(coder);
  });

  it("ignores unknown names and text without a mention", () => {
    expect(findMentionedAgent("@Nobody hi", agents)).toBeNull();
    expect(findMentionedAgent("hi there", agents)).toBeNull();
    expect(findMentionedAgent("@Coder hi", [])).toBeNull();
  });
});

describe("getDefaultAgent", () => {
  it("prefers the isDefault agent, then the first agent, then null", () => {
    expect(getDefaultAgent(agents)).toBe(lead);
    expect(getDefaultAgent([coder, lead])).toBe(lead);
    expect(getDefaultAgent([coder])).toBe(coder);
    expect(getDefaultAgent([])).toBeNull();
  });
});

describe("resolveTargetState", () => {
  it("routes to the default agent with no lock and no mention", () => {
    const state = resolveTargetState(agents, null, "hello");
    expect(state.effectiveAgent).toBe(lead);
    expect(state.lockedAgent).toBeNull();
    expect(state.mentionedAgent).toBeNull();
    expect(state.isMentionOverride).toBe(false);
    expect(state.sendTarget).toBeUndefined();
  });

  it("routes to a locked non-default agent and sends its id", () => {
    const state = resolveTargetState(agents, "coder", "hello");
    expect(state.effectiveAgent).toBe(coder);
    expect(state.lockedAgent).toBe(coder);
    expect(state.mentionedAgent).toBeNull();
    expect(state.isMentionOverride).toBe(false);
    expect(state.sendTarget).toBe("coder");
  });

  it("keeps default routing clean when the lock names the default agent", () => {
    const state = resolveTargetState(agents, "lead", "hello");
    expect(state.effectiveAgent).toBe(lead);
    expect(state.lockedAgent).toBe(lead);
    expect(state.sendTarget).toBeUndefined();
  });

  it("lets an explicit @mention override the locked target", () => {
    const state = resolveTargetState(agents, "coder", "@Lead take this");
    expect(state.effectiveAgent).toBe(lead);
    expect(state.mentionedAgent).toBe(lead);
    expect(state.lockedAgent).toBe(coder);
    expect(state.isMentionOverride).toBe(true);
    expect(state.sendTarget).toBeUndefined();
  });

  it("does not flag an override when the mention is the locked agent", () => {
    const state = resolveTargetState(agents, "coder", "@Coder hi");
    expect(state.effectiveAgent).toBe(coder);
    expect(state.isMentionOverride).toBe(false);
    expect(state.sendTarget).toBeUndefined();
  });

  it("does not flag an override when the mention names the default agent", () => {
    const state = resolveTargetState(agents, null, "@Lead hi");
    expect(state.effectiveAgent).toBe(lead);
    expect(state.mentionedAgent).toBe(lead);
    expect(state.isMentionOverride).toBe(false);
    expect(state.sendTarget).toBeUndefined();
  });

  it("ignores an unknown @token as an override", () => {
    const state = resolveTargetState(agents, null, "@Nobody hi");
    expect(state.mentionedAgent).toBeNull();
    expect(state.effectiveAgent).toBe(lead);
    expect(state.isMentionOverride).toBe(false);
    expect(state.sendTarget).toBeUndefined();
  });

  it("falls back to the default when the locked agent was removed", () => {
    const state = resolveTargetState(agents, "gone", "hello");
    expect(state.lockedAgent).toBeNull();
    expect(state.effectiveAgent).toBe(lead);
    expect(state.sendTarget).toBeUndefined();
  });

  it("handles an undefined lock as no lock", () => {
    const state = resolveTargetState(agents, undefined, "hello");
    expect(state.lockedAgent).toBeNull();
    expect(state.effectiveAgent).toBe(lead);
  });

  it("handles empty agents without throwing", () => {
    const state = resolveTargetState([], "coder", "@Coder hi");
    expect(state.effectiveAgent).toBeNull();
    expect(state.lockedAgent).toBeNull();
    expect(state.mentionedAgent).toBeNull();
    expect(state.isMentionOverride).toBe(false);
    expect(state.sendTarget).toBeUndefined();
  });
});

describe("clearConflictingMention", () => {
  it("strips a conflicting leading mention and keeps the draft text", () => {
    expect(clearConflictingMention("  @Coder please fix", lead, agents)).toBe("please fix");
    expect(clearConflictingMention("@Coder fix", lead, agents)).toBe("fix");
  });

  it("keeps a mention of the target agent itself", () => {
    expect(clearConflictingMention("@Lead hi", lead, agents)).toBe("@Lead hi");
  });

  it("keeps a non-agent @token", () => {
    expect(clearConflictingMention("@foo hi", lead, agents)).toBe("@foo hi");
  });

  it("leaves a mid-text mention untouched", () => {
    expect(clearConflictingMention("please @Coder fix", lead, agents)).toBe("please @Coder fix");
  });

  it("strips a mention of the default agent when another agent is targeted", () => {
    expect(clearConflictingMention("  @Lead hi", coder, agents)).toBe("hi");
  });
});

const renderSelect = (over: Partial<Parameters<typeof TargetAgentSelect>[0]> = {}) => {
  const onSelectTarget = vi.fn();
  const utils = render(
    <TargetAgentSelect
      agents={agents}
      effectiveAgent={lead}
      lockedAgent={null}
      isMentionOverride={false}
      onSelectTarget={onSelectTarget}
      {...over}
    />,
  );
  return { ...utils, onSelectTarget };
};

describe("TargetAgentSelect rendering", () => {
  it("is hidden when there are zero or one agents", () => {
    const empty = render(
      <TargetAgentSelect
        agents={[]}
        effectiveAgent={null}
        lockedAgent={null}
        isMentionOverride={false}
        onSelectTarget={() => {}}
      />,
    );
    expect(empty.container.querySelector(".target-select")).toBeNull();

    const one = render(
      <TargetAgentSelect
        agents={[lead]}
        effectiveAgent={lead}
        lockedAgent={null}
        isMentionOverride={false}
        onSelectTarget={() => {}}
      />,
    );
    expect(one.container.querySelector(".target-select")).toBeNull();
  });

  it("is hidden when there is no effective agent", () => {
    const view = render(
      <TargetAgentSelect
        agents={agents}
        effectiveAgent={null}
        lockedAgent={null}
        isMentionOverride={false}
        onSelectTarget={() => {}}
      />,
    );
    expect(view.container.querySelector(".target-select")).toBeNull();
  });

  it("shows the effective agent for two or more agents", () => {
    renderSelect();
    const trigger = screen.getByRole("button", {
      name: "Send target: Lead (click to switch)",
    });
    expect(trigger).toBeTruthy();
    expect(trigger.querySelector(".target-select-name")?.textContent).toBe("Lead");
  });

  it("marks the default option selected with a badge", () => {
    renderSelect();
    fireEvent.click(screen.getByRole("button"));
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[0].textContent).toContain("default");
    expect(options[1].getAttribute("aria-selected")).toBe("false");
  });

  it("marks the locked option selected when a non-default agent is locked", () => {
    renderSelect({ lockedAgent: coder, effectiveAgent: coder });
    fireEvent.click(screen.getByRole("button"));
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
  });
});

describe("TargetAgentSelect interactions", () => {
  it("opens and closes the popover on trigger click", () => {
    renderSelect();
    const trigger = screen.getByRole("button");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByText("Send messages to")).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("selects a non-default agent and closes the popover", () => {
    const { onSelectTarget } = renderSelect();
    fireEvent.click(screen.getByRole("button"));
    const option = screen.getAllByRole("option")[1];
    fireEvent.click(option);
    expect(onSelectTarget).toHaveBeenCalledWith("coder");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("selects the default agent with null and closes the popover", () => {
    const { onSelectTarget } = renderSelect();
    fireEvent.click(screen.getByRole("button"));
    const option = screen.getAllByRole("option")[0];
    fireEvent.click(option);
    expect(onSelectTarget).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape and restores focus to the trigger", () => {
    renderSelect();
    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);
    const option = screen.getAllByRole("option")[0];
    option.focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on an outside pointerdown", () => {
    renderSelect();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("cycles focus through options with ArrowDown and ArrowUp", () => {
    renderSelect();
    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);
    const options = screen.getAllByRole("option");
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(options[0]);
  });

  it("does nothing on trigger click while disabled and closes when disabled", () => {
    const { rerender } = renderSelect();
    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeTruthy();

    rerender(
      <TargetAgentSelect
        agents={agents}
        effectiveAgent={lead}
        lockedAgent={null}
        isMentionOverride={false}
        disabled
        onSelectTarget={() => {}}
      />,
    );
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("TargetAgentSelect classes and titles", () => {
  it("adds is-locked for a locked non-default agent", () => {
    renderSelect({ lockedAgent: coder, effectiveAgent: coder });
    const trigger = screen.getByRole("button");
    expect(trigger.className).toContain("is-locked");
    expect(trigger.className).not.toContain("is-override");
    expect(trigger.getAttribute("aria-label")).toBe("Send target: Coder (click to switch)");
  });

  it("adds is-override and the mention title during an override", () => {
    renderSelect({ isMentionOverride: true, effectiveAgent: coder });
    const trigger = screen.getByRole("button");
    expect(trigger.className).toContain("is-override");
    expect(trigger.className).not.toContain("is-locked");
    expect(trigger.getAttribute("aria-label")).toBe(
      "Sending to @Coder via mention (click to change locked target)",
    );
  });

  it("suppresses is-locked while an override is active even with a lock", () => {
    renderSelect({ lockedAgent: coder, effectiveAgent: lead, isMentionOverride: true });
    const trigger = screen.getByRole("button");
    expect(trigger.className).toContain("is-override");
    expect(trigger.className).not.toContain("is-locked");
  });

  it("shows the override note in the popover", () => {
    renderSelect({ isMentionOverride: true, effectiveAgent: coder });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("@Coder in input overrides this message")).toBeTruthy();
  });
});

describe("TargetAgentSelect localization", () => {
  it("switches trigger and popover strings between en and zh-CN", () => {
    renderSelect({ isMentionOverride: true, effectiveAgent: coder });
    const trigger = screen.getByRole("button", {
      name: "Sending to @Coder via mention (click to change locked target)",
    });
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.getByText("Send messages to")).toBeTruthy();
    expect(screen.getByText("default")).toBeTruthy();

    act(() => setLocaleOverride("zh-CN"));
    expect(
      screen.getByRole("button", {
        name: "本次将通过 @ 提及发送给 Coder（点击更改锁定目标）",
      }),
    ).toBeTruthy();
    expect(screen.getByText("发送消息给")).toBeTruthy();
    expect(screen.getByText("默认")).toBeTruthy();
    expect(screen.getByText("输入框中的 @Coder 将临时覆盖本条消息")).toBeTruthy();
  });
});
