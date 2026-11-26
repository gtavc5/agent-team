import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { BoardPage } from "../../src/project/BoardPage";
import type { Objective, Project } from "../../src/state/useServer";
import "../../src/styles.css";

const noop = vi.fn();
const objectives: Objective[] = [
  {
    id: "core/priority",
    area: "core",
    title: "Priority clarity",
    goal: "Keep priority distinct from blockage",
    status: "active",
    priority: "high",
    dependsOn: ["core/done"],
    tasks: [],
    decisions: [],
    sessions: [],
    updatedAt: 1,
  },
  {
    id: "core/done",
    area: "core",
    title: "Completed work",
    goal: "Explain the result",
    status: "done",
    priority: "normal",
    reason: "The measured result is complete",
    dependsOn: [],
    tasks: [],
    decisions: [],
    sessions: [],
    updatedAt: 2,
  },
];
const project: Project = {
  id: "p",
  name: "repo",
  root: "/repo",
  leadWorkspaceId: "lead",
  createdAt: 1,
  objectives,
};

function board(overrides: Partial<ComponentProps<typeof BoardPage>> = {}) {
  return render(
    <BoardPage
      project={project}
      sessions={new Map()}
      onClose={noop}
      onOpenSession={noop}
      onAskLead={null}
      onRename={noop}
      onArchive={noop}
      onSeal={noop}
      onDelete={noop}
      {...overrides}
    />,
  );
}

function rect(element: Element) {
  const { x, y, width, height, top, right, bottom, left } = element.getBoundingClientRect();
  return { x, y, width, height, top, right, bottom, left };
}

function tokenColor(token: string) {
  const probe = document.body.appendChild(document.createElement("span"));
  probe.style.color = `var(--${token})`;
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

it("keeps native Tab and Shift+Tab navigation inside the board", async () => {
  await page.viewport(1280, 800);
  const outside = document.body.appendChild(document.createElement("button"));
  outside.textContent = "Background";
  board();
  const first = screen.getByTitle("Rename");
  const last = document.querySelector<HTMLElement>(".bp-card")!;

  last.focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(first);
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement).toBe(last);

  outside.focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(first);
  outside.remove();
});

it("continues native Tab order inside replacement objective details", async () => {
  await page.viewport(1280, 800);
  board();
  const card = document.querySelector<HTMLElement>('[data-objective="core/priority"]')!;
  card.focus();
  await userEvent.keyboard("{Enter}");
  const dependency = screen.getByRole("button", { name: "Completed work" });
  dependency.focus();
  await userEvent.keyboard("{Enter}");

  const detail = screen.getByRole("complementary", { name: "Completed work" });
  expect(document.activeElement).toBe(detail);
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close details" }));
});

it("uses one nav spring for single and combined project actions", async () => {
  await page.viewport(1280, 800);
  const { container, rerender } = board();
  const mode = container.querySelector(".bp-modes")!;
  const search = container.querySelector(".bp-search")!;
  const beforeRename = { mode: rect(mode), search: rect(search) };
  fireEvent.click(screen.getByTitle("Rename"));
  expect({ mode: rect(mode), search: rect(search) }).toEqual(beforeRename);
  fireEvent.keyDown(screen.getByLabelText("Project name"), { key: "Escape" });
  expect({ mode: rect(mode), search: rect(search) }).toEqual(beforeRename);

  const props: ComponentProps<typeof BoardPage> = {
    project,
    sessions: new Map(),
    onClose: noop,
    onOpenSession: noop,
    onAskLead: null,
    onRename: noop,
    onDelete: noop,
  };
  const expectGeometry = (selector: string) => {
    const actions = [...container.querySelectorAll<HTMLElement>(selector)];
    expect(actions.length).toBeGreaterThan(0);
    expect(parseFloat(getComputedStyle(actions[0]).marginTop)).toBeGreaterThan(0);
    for (const [index, action] of actions.entries()) {
      if (index > 0) expect(parseFloat(getComputedStyle(action).marginTop)).toBe(0);
      const box = rect(action);
      expect(box.width).toBeGreaterThan(0);
      if (index > 0) expect(box.top).toBeGreaterThanOrEqual(rect(actions[index - 1]).bottom);
    }
  };

  expectGeometry(".bp-nav > :is(.bp-archive, .bp-delete)");
  rerender(<BoardPage {...props} onSeal={noop} />);
  expectGeometry(".bp-nav > :is(.bp-archive, .bp-delete)");
  rerender(<BoardPage {...props} onArchive={noop} />);
  expectGeometry(".bp-nav > :is(.bp-archive, .bp-delete)");
  rerender(<BoardPage {...props} />);
  expectGeometry(".bp-nav > :is(.bp-archive, .bp-delete)");
});

it.each(["light", "dark"])(
  "keeps the name editor and mobile search/views aligned in %s",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(390, 760);
    const { container } = board();
    const header = container.querySelector(".bp-head")!;
    const before = rect(header);
    fireEvent.click(screen.getByTitle("Rename"));
    expect(rect(header)).toEqual(before);
    expect(rect(screen.getByLabelText("Project name")).height).toBe(28);
    fireEvent.keyDown(screen.getByLabelText("Project name"), { key: "Escape" });
    expect(rect(header)).toEqual(before);

    const search = rect(screen.getByPlaceholderText("Search objectives…"));
    const views = rect(container.querySelector(".bp-views:not(.bp-modes)")!);
    expect(search.top).toBeCloseTo(views.top, 1);
    expect(search.height).toBeCloseTo(views.height, 1);

    const expectActionsReachable = async () => {
      const boardBox = rect(container.querySelector(".board-page")!);
      const actions = [
        ...container.querySelectorAll<HTMLElement>(".bp-nav > :is(.bp-archive, .bp-delete)"),
      ];
      expect(actions).toHaveLength(3);
      for (const action of actions) {
        const box = rect(action);
        expect(box.width).toBeGreaterThan(0);
        expect(box.top).toBeGreaterThanOrEqual(boardBox.top);
        expect(box.bottom).toBeLessThanOrEqual(boardBox.bottom);
      }
      screen.getByRole("button", { name: "Close" }).focus();
      const reached = new Set<Element>();
      for (let index = 0; index < 16 && reached.size < actions.length; index++) {
        await userEvent.keyboard("{Tab}");
        if (actions.includes(document.activeElement as HTMLElement))
          reached.add(document.activeElement!);
      }
      for (const action of actions) expect(reached).toContain(action);
    };
    await expectActionsReachable();
    await page.viewport(740, 390);
    await expectActionsReachable();
  },
);

it.each(["light", "dark"])("separates priority and completion emphasis in %s", (theme) => {
  document.documentElement.dataset.theme = theme;
  const { container } = board();
  fireEvent.click(screen.getByRole("button", { name: /^Done/ }));
  fireEvent.click(screen.getByRole("button", { name: "Dependencies" }));
  const high = container.querySelector<HTMLElement>('[data-objective="core/priority"]')!;
  expect(getComputedStyle(high).borderLeftColor).toBe(tokenColor("warning"));
  expect(getComputedStyle(high).borderLeftColor).not.toBe(tokenColor("error"));

  fireEvent.click(container.querySelector('[data-objective="core/done"]')!);
  const reason = container.querySelector<HTMLElement>(".bp-reason.st-done")!;
  expect(getComputedStyle(reason).color).toBe(tokenColor("text-secondary"));
  expect(getComputedStyle(reason).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(getComputedStyle(reason).borderLeftColor).not.toBe(tokenColor("warning"));
});
