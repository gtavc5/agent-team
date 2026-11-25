import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { MdBlock } from "../../src/chat/markdown";
import { FileOpenContext } from "../../src/chat/fileRef";
import { Icon } from "../../src/panels/Icon";
import { FOLDED_IDLE_STORAGE_KEY, Sidebar, type SidebarProps } from "../../src/sidebar/Sidebar";
import { IDLE_FOLD_MS } from "../../src/sidebar/groups";
import { Avatar } from "../../src/workspace/avatar";
import type { AgentInfo, Project, Workspace } from "../../src/state/useServer";
import "../../src/styles.css";

const NOW = 1_800_000_000_000;
const agent: AgentInfo = {
  id: "agent",
  name: "Agent",
  model: "model",
  avatar: "A",
  color: "#528bff",
  isDefault: true,
};
const project: Project = {
  id: "project",
  name: "Project",
  root: "/repo",
  leadWorkspaceId: "lead",
  createdAt: NOW,
  objectives: [],
};
const workspace = (id: string, order: number, fields: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  project: "Project",
  hostId: "local",
  cwd: "/repo",
  agents: [agent],
  messages: [],
  createdAt: NOW + order,
  lastMessageAt: NOW + order,
  projectLink: { projectId: project.id, role: id === "lead" ? "lead" : "worker" },
  ...fields,
});
const lead = workspace("lead", 0);
const no = () => {};
const get = <T extends HTMLElement = HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
};
const style = (element: Element) => getComputedStyle(element);
const rect = (element: Element) => element.getBoundingClientRect();
const row = (name: string) => get(`.task-item:has(.clip[title="${name}"])`);

function sidebarProps(workspaces: Workspace[], over: Partial<SidebarProps> = {}): SidebarProps {
  return {
    workspaces,
    projects: [project],
    activeWsId: lead.id,
    connected: true,
    groupOverrides: {},
    searchQuery: "",
    searchHits: null,
    systemStatus: null,
    now: NOW,
    onSelect: no,
    onDelete: no,
    onToggleGroup: no,
    onSearchChange: no,
    onJump: no,
    onCreate: no,
    onCreateIn: no,
    onReplayDemo: no,
    onDebugSnapshot: no,
    onPurgeArchived: no,
    ...over,
  };
}

function healthyProbe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ issues: [] }) })),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

it("renders one decorated code element for file-ref links and resets defensive nesting", () => {
  const { container } = render(
    <FileOpenContext.Provider value={no}>
      <div className="message-content">
        <MdBlock>
          {
            "[`initialIdleWorkers()`](file:///repo/groups.ts#L133-L146) and [`docs`](https://example.test)"
          }
        </MdBlock>
      </div>
    </FileOpenContext.Provider>,
  );
  const local = container.querySelector<HTMLElement>("code.file-ref")!;
  expect(local.textContent).toBe("initialIdleWorkers()");
  expect(local.querySelector("code")).toBeNull();
  expect(container.querySelector("a > code")?.textContent).toBe("docs");
  expect(style(local).borderTopWidth).toBe("1px");
  expect(style(local).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(style(container.querySelector("a > code")!).borderTopWidth).toBe("1px");

  const defensive = document.createElement("code");
  const inner = document.createElement("code");
  inner.textContent = "nested";
  defensive.append(inner);
  container.querySelector(".message-content")!.append(defensive);
  expect(style(inner).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(style(inner).borderTopWidth).toBe("0px");
  expect(style(inner).padding).toBe("0px");
  expect(style(inner).fontSize).toBe(style(defensive).fontSize);
});

it("keeps every worker row and the overflow sibling vertically fixed on hover and focus", async () => {
  await page.viewport(1280, 800);
  healthyProbe();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  render(
    <div style={{ width: 300 }}>
      <Sidebar
        {...sidebarProps([
          lead,
          workspace("Plain", 10),
          workspace("YourTurn", 9, { awaitsUser: true }),
          workspace("Unread", 8, { lastResult: "done", unread: 1 }),
          workspace("Failed", 7, { lastResult: "failed" }),
          workspace("Quiet", 6, {
            agents: [{ ...agent, busy: true, lastStreamAt: NOW - 120_000 }],
          }),
          workspace("Done", 5, { lastResult: "done" }),
        ])}
      />
    </div>,
  );
  const names = ["Plain", "YourTurn", "Unread", "Failed", "Quiet"];
  expect(row("YourTurn").querySelector(".session-attention")?.textContent).toBe("Your turn");
  expect(row("Unread").querySelector(".session-attention")?.textContent).toBe("Unread result");
  expect(row("Failed").querySelector(".session-attention")?.textContent).toBe("Failed");
  expect(row("Quiet").querySelector(".session-silence")?.textContent).toBe("Quiet");
  const idleRow = get(".ws-idle-row");
  const heights = () => Object.fromEntries(names.map((name) => [name, rect(row(name)).height]));
  const restingHeights = heights();
  const restingIdleTop = rect(idleRow).top;
  const expectFixedGeometry = () => {
    expect(heights()).toEqual(restingHeights);
    expect(rect(idleRow).top).toBe(restingIdleTop);
  };

  for (const name of names) {
    const target = row(name);
    await page.elementLocator(target).hover();
    await expect.poll(() => style(target.querySelector(".task-hover")!).opacity).toBe("1");
    expectFixedGeometry();
    await page.elementLocator(get(".sidebar-header")).hover();
    const action = target.querySelector<HTMLButtonElement>(".task-delete")!;
    action.focus();
    expect(style(target.querySelector(".task-hover")!).opacity).toBe("1");
    expectFixedGeometry();
    action.blur();
  }

  const quiet = row("Quiet");
  const quietBadge = quiet.querySelector<HTMLElement>(".session-silence")!;
  await page.elementLocator(quiet).hover();
  await page.elementLocator(quietBadge).hover();
  const badgeBox = rect(quietBadge);
  expect(
    document.elementFromPoint(
      badgeBox.left + badgeBox.width / 2,
      badgeBox.top + badgeBox.height / 2,
    ),
  ).toBe(quietBadge);
  await page.elementLocator(get(".sidebar-header")).hover();
  fireEvent.focus(quietBadge);
  expect(quietBadge.querySelector('[role="tooltip"]')).not.toBeNull();
  expectFixedGeometry();
  fireEvent.blur(quietBadge);

  const idleToggle = get<HTMLButtonElement>(".ws-idle-toggle");
  const chevron = idleToggle.querySelector<HTMLElement>(".events-toggle")!;
  const label = idleToggle.querySelector<HTMLElement>(".ws-idle-label")!;
  expect(label.textContent).toBe("... (1)");
  expect(style(chevron).opacity).toBe("0");
  const labelLeft = rect(label).left;
  await page.elementLocator(idleRow).hover();
  await expect.poll(() => style(chevron).opacity).toBe("1");
  expect(rect(label).left).toBe(labelLeft);
  fireEvent.click(idleToggle);
  expect(idleToggle.getAttribute("aria-expanded")).toBe("true");
  await page.elementLocator(get(".sidebar-header")).hover();
  expect(style(chevron).opacity).toBe("1");
  expect(rect(label).left).toBe(labelLeft);
});

it("restores manual folds and age-based quiet folds on a fresh mount", async () => {
  await page.viewport(1280, 800);
  healthyProbe();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const recent = workspace("Recent", 2);
  const oldQuiet = workspace("OldQuiet", 1, {
    createdAt: NOW - IDLE_FOLD_MS - 1000,
    lastMessageAt: NOW - IDLE_FOLD_MS - 1,
    lastResult: undefined,
  });
  const props = sidebarProps([lead, recent, oldQuiet]);
  const first = render(
    <div style={{ width: 300 }}>
      <Sidebar {...props} />
    </div>,
  );
  expect(document.querySelector('.clip[title="Recent"]')).not.toBeNull();
  expect(document.querySelector('.clip[title="OldQuiet"]')).toBeNull();
  expect(get(".ws-idle-label").textContent).toBe("... (1)");
  fireEvent.click(get<HTMLButtonElement>(".ws-idle-fold"));
  expect(get(".ws-idle-label").textContent).toBe("... (2)");
  expect(JSON.parse(localStorage.getItem(FOLDED_IDLE_STORAGE_KEY)!)).toEqual(["Recent"]);
  first.unmount();

  const second = render(
    <div style={{ width: 300 }}>
      <Sidebar {...props} />
    </div>,
  );
  expect(get(".ws-idle-label").textContent).toBe("... (2)");
  expect(document.querySelector('.clip[title="Recent"]')).toBeNull();
  expect(document.querySelector('.clip[title="OldQuiet"]')).toBeNull();
  second.rerender(
    <div style={{ width: 300 }}>
      <Sidebar {...props} activeWsId="Recent" />
    </div>,
  );
  expect(document.querySelector('.clip[title="Recent"]')).not.toBeNull();
  expect(get(".ws-idle-label").textContent).toBe("... (1)");
  expect(localStorage.getItem(FOLDED_IDLE_STORAGE_KEY)).toBeNull();
});

it.each(["light", "dark"] as const)(
  "adds non-layout avatar rings and a balanced group plus (%s)",
  async (theme) => {
    await page.viewport(1280, 800);
    document.documentElement.dataset.theme = theme;
    const { container } = render(
      <>
        <Avatar avatar="A" color="#528bff" name="Agent" size={16} />
        <Avatar avatar="avatars/Laffey.jpg" color="#D8A0D8" name="Laffey" size={28} />
        <Avatar avatar="D" color="#050505" name="Dark profile" size={20} />
        <div className="avatar-user">U</div>
        <div className="ws-group-header">
          <span className="ws-group-label">Project</span>
          <button type="button" className="ws-group-add" title="New session">
            <Icon name="plus" />
          </button>
          <button type="button" className="ws-group-pill">
            Archive
          </button>
        </div>
      </>,
    );
    const avatars = [...container.querySelectorAll<HTMLElement>(".agent-avatar, .avatar-user")];
    expect(avatars).toHaveLength(4);
    expect(rect(avatars[0]).width).toBe(16);
    expect(rect(avatars[0]).height).toBe(16);
    expect(rect(avatars[1]).width).toBe(28);
    expect(rect(avatars[1]).height).toBe(28);
    expect(avatars[0].style.getPropertyValue("--avatar-color")).toBe("#528bff");
    for (const avatar of avatars) expect(style(avatar).boxShadow).not.toBe("none");
    if (theme === "dark") {
      expect(style(avatars[2]).boxShadow).not.toContain(
        style(document.documentElement).backgroundColor,
      );
    }

    const add = container.querySelector<HTMLButtonElement>(".ws-group-add")!;
    const plus = add.querySelector("svg")!;
    const pill = container.querySelector<HTMLElement>(".ws-group-pill")!;
    expect(rect(add).width).toBe(18);
    expect(rect(add).height).toBe(18);
    expect(rect(plus).width).toBe(10);
    expect(rect(plus).height).toBe(10);
    expect(style(pill).fontSize).toBe("10px");
    const probe = document.createElement("div");
    probe.style.background = "var(--bg-hover-strong)";
    probe.style.color = "var(--accent-hover)";
    document.body.append(probe);
    const strong = style(probe).backgroundColor;
    const accentHover = style(probe).color;
    probe.remove();
    await page.elementLocator(add).hover();
    expect(style(add).backgroundColor).toBe(strong);
    await page.elementLocator(pill).hover();
    expect(style(pill).backgroundColor).toBe(strong);
    expect(style(pill).color).toBe(accentHover);
  },
);
