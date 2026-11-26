import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ExtensionUi } from "../../src/workspace/ExtensionUi";
import type { LiveUi } from "../../src/state/extensionUi";
import type { Workspace } from "../../src/state/useServer";
import "../../src/styles.css";

const agent = {
  id: "a",
  name: "Alice",
  avatar: "A",
  color: "#888",
  model: "model",
  isDefault: true,
};
const workspace: Workspace = {
  id: "w",
  name: "Test session",
  project: "repo",
  cwd: "/repo",
  hostId: "local",
  createdAt: 1,
  agents: [agent],
  messages: [],
};
const owner = { workspaceId: "w", agentId: "a", processGeneration: 1 };
const notice = {
  ...owner,
  kind: "notify",
  id: "n",
  level: "error",
  message: "Indexing failed",
  expiresAt: 100,
} as const;
const ui: LiveUi = {
  agents: [
    {
      ...owner,
      statuses: [
        { key: "mode", text: "Ready" },
        { key: "branch", text: "On main" },
      ],
      widgets: [{ key: "hint", placement: "belowEditor", lines: ["Use /help"] }],
    },
  ],
  notices: [notice],
};
const rect = (element: Element) => element.getBoundingClientRect();

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

it.each([
  [1100, "light"],
  [360, "dark"],
] as const)(
  "spaces the extension UI at %ipx in %s mode and offers a quiet keyboard dismiss",
  async (width, theme) => {
    await page.viewport(width, 760);
    document.documentElement.dataset.theme = theme;
    const dismiss = vi.fn();
    const composer = (ws: Workspace, state: LiveUi) => (
      <div className="input-area">
        <button type="button">Before notices</button>
        <ExtensionUi workspace={ws} ui={state} placement="aboveEditor" dismiss={dismiss} />
        <div className="input-row">
          <textarea className="chat-input" aria-label="Message" />
        </div>
        <ExtensionUi workspace={ws} ui={state} placement="belowEditor" dismiss={dismiss} />
      </div>
    );
    const view = render(composer(workspace, { agents: [], notices: [] }));
    const above = view.container.querySelector('[data-placement="aboveEditor"]')!;
    expect(rect(above).height).toBe(0);
    view.rerender(composer(workspace, ui));
    expect(above.querySelector("strong")).toBeNull();
    const below = view.container.querySelector('[data-placement="belowEditor"]')!;
    expect(below.querySelector("strong")).toBeNull();
    expect(below.querySelector(".extension-widget")?.textContent).toBe("Use /help");

    // Pill backgrounds are the painted marks; compare their border boxes.
    const [first, second] = above.querySelectorAll(".extension-status");
    expect(rect(first).top).toBe(rect(second).top);
    expect(rect(second).left - rect(first).right).toBeCloseTo(6, 0);
    expect(getComputedStyle(first).borderRadius).toBe(
      getComputedStyle(first).getPropertyValue("--radius-sm").trim(),
    );
    const row = view.container.querySelector(".input-row")!;
    expect(rect(row).top - rect(first).bottom).toBeGreaterThanOrEqual(3);
    expect(
      rect(below.querySelector(".extension-widget")!).top - rect(row).bottom,
    ).toBeGreaterThanOrEqual(3);

    const action = page.getByRole("button", { name: "Dismiss notification" });
    const button = action.element();
    const resting = getComputedStyle(button);
    expect(resting.borderTopWidth).toBe("0px");
    expect(resting.cursor).toBe("pointer");
    expect(rect(button).width).toBeGreaterThanOrEqual(width <= 768 ? 40 : 32);
    expect(rect(button).height).toBeGreaterThanOrEqual(width <= 768 ? 40 : 32);
    await page.getByRole("button", { name: "Before notices" }).click();
    await userEvent.tab();
    await expect.element(action).toHaveFocus();
    expect(getComputedStyle(button).outlineStyle).toBe("solid");
    await userEvent.keyboard("{Enter}");
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(notice);

    view.rerender(
      composer(
        { ...workspace, agents: [agent, { ...agent, id: "b", name: "Bob" }] },
        {
          ...ui,
          agents: [
            ...ui.agents,
            { ...owner, agentId: "b", statuses: [{ key: "mode", text: "Busy" }], widgets: [] },
          ],
          notices: [],
        },
      ),
    );
    const alice = page.getByRole("region", { name: "Alice extension UI" }).elements();
    const bob = page.getByRole("region", { name: "Bob extension UI" }).element();
    expect(alice.map((section) => section.querySelector("strong")?.textContent)).toEqual([
      "Alice",
      "Alice",
    ]);
    expect(bob.querySelector("strong")?.textContent).toBe("Bob");
    expect(bob.querySelector(".extension-status")?.textContent).toBe("Busy");
    await expect.element(action).not.toBeInTheDocument();
  },
);
