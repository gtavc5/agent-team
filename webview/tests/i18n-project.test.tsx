import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLocaleForTests, setLocaleOverride, setServerLanguage } from "../src/i18n";
import { projectMessages, tProject } from "../src/i18n/project";
import { BoardPage, type SessionInfo } from "../src/project/BoardPage";
import type { IssueModules, Objective, Project } from "../src/state/useServer";

const NOW = Date.now();

const makeObjective = (id: string, over: Partial<Objective> = {}): Objective => ({
  id,
  area: id.split("/")[0],
  title: id,
  goal: `goal of ${id}`,
  status: "active",
  priority: "normal",
  dependsOn: [],
  tasks: [],
  decisions: [],
  sessions: [],
  updatedAt: NOW - 120_000,
  ...over,
});

const sampleProject: Project = {
  id: "p1",
  name: "clice",
  root: "/repo/clice",
  leadWorkspaceId: "lead",
  createdAt: 0,
  objectives: [
    makeObjective("foundation/identity", {
      title: "Declaration identity",
      priority: "high",
      context: "Check `src/a.cpp:10`.",
      contextWritten: NOW - 86_400_000,
      contextCommit: "abc1234",
      tasks: [
        { id: "t1", text: "entity hash", state: "done" },
        { id: "t2", text: "content closure", state: "doing", session: "w1" },
      ],
      decisions: [
        { id: "d1", question: "hash width?", outcome: "64 bits" },
        { id: "d2", question: "cache keys?" },
      ],
      sessions: ["w1"],
      notes: "See notes/design.md",
    }),
    makeObjective("index/ranges", {
      title: "Name ranges",
      dependsOn: ["foundation/identity", "missing/obj"],
    }),
    makeObjective("infra/lto", {
      title: "LTO build",
      status: "later",
      priority: "low",
      reason: "after toolchain bump",
    }),
    makeObjective("infra/old", {
      title: "Old item",
      status: "done",
      archived: true,
    }),
    { id: "infra/broken", error: "bad toml" },
  ],
};

const sampleIssues: IssueModules = [
  {
    id: "01-core",
    title: "Core (src/core)",
    notes: "Module note body.",
    objectives: [],
    issues: [
      {
        id: "10-01#1",
        state: "open",
        evidence: "R",
        tags: ["crash"],
        text: "Null pointer in parser.",
        written: NOW - 86_400_000,
        commit: "deadbeef",
        objectives: ["foundation/identity", "missing/obj"],
      },
      {
        id: "10-01#2",
        state: "accepted",
        evidence: "C",
        tags: [],
        text: "Accepted quirk.",
        objectives: ["foundation/identity"],
      },
    ],
    groups: [
      {
        id: "grp",
        title: "Parser group",
        notes: "Group shared note.",
        objectives: [],
        issues: [
          {
            id: "10-01#3",
            state: "decision",
            evidence: "H",
            tags: [],
            text: "Need decision.",
            objectives: [],
          },
        ],
      },
    ],
    updatedAt: 0,
  },
  { id: "02-bad", error: "parse error" },
];

const sessions = new Map<string, SessionInfo>([["w1", { name: "identity", state: "working" }]]);

function renderBoard(p: Project = sampleProject, issues: IssueModules = sampleIssues) {
  const props = {
    onClose: vi.fn(),
    onOpenSession: vi.fn(),
    onAskLead: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onSeal: vi.fn(),
    onDelete: vi.fn(),
  };
  const utils = render(<BoardPage project={p} issues={issues} sessions={sessions} {...props} />);
  return { ...utils, ...props };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  resetLocaleForTests();
  vi.unstubAllGlobals();
});

describe("project i18n catalog", () => {
  it("provides non-empty en and zh-CN entries for every key and interpolates params", () => {
    for (const [key, entry] of Object.entries(projectMessages)) {
      expect(entry.en.trim().length, `${key}.en`).toBeGreaterThan(0);
      expect(entry["zh-CN"].trim().length, `${key}.zh-CN`).toBeGreaterThan(0);
    }
    expect(tProject("boardDialogLabel", { name: "yaat" }, "en")).toBe("yaat objectives");
    expect(tProject("boardDialogLabel", { name: "yaat" }, "zh-CN")).toBe("yaat 目标看板");
  });
});

describe("BoardPage localization", () => {
  it("renders Simplified Chinese across Objectives, Graph, and Detail when server language is zh-CN", () => {
    setServerLanguage("简体中文");
    const { container } = renderBoard();

    expect(screen.getByRole("dialog", { name: "clice 目标看板" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "目标" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^问题/ }).textContent).toBe("问题2");
    expect(screen.getByRole("button", { name: "笔记" })).toBeTruthy();
    expect(container.querySelector(".bp-summary")!.textContent).toBe(
      "2 进行中 · 1 稍后 · 0 已完成",
    );
    expect(screen.getByPlaceholderText("搜索目标…")).toBeTruthy();

    const nav = within(screen.getByRole("navigation", { name: "筛选" }));
    expect(nav.getByRole("button", { name: /^全部领域/ })).toBeTruthy();
    const statuses = within(nav.getByRole("group", { name: "状态" }));
    expect(statuses.getByRole("button", { name: /^进行中/ })).toBeTruthy();
    expect(statuses.getByRole("button", { name: /^稍后/ })).toBeTruthy();
    expect(statuses.getByRole("button", { name: /^已完成/ })).toBeTruthy();
    expect(statuses.getByRole("button", { name: /^已放弃/ })).toBeTruthy();
    expect(statuses.getByRole("button", { name: /^归档/ })).toBeTruthy();
    expect(nav.getByRole("button", { name: "归档项目" })).toBeTruthy();
    expect(nav.getByRole("button", { name: "封存项目" })).toBeTruthy();
    expect(nav.getByRole("button", { name: "删除项目" })).toBeTruthy();

    expect(container.querySelector(".bp-broken")!.textContent).toBe(
      "infra/broken.toml 无法读取：bad toml",
    );

    const card1 = container.querySelector('[data-objective="foundation/identity"]')!;
    expect(card1.textContent).toContain("高");
    expect(card1.textContent).toContain("进行中");
    expect(card1.textContent).toContain("1 项待决策");
    expect(card1.textContent).toContain("1 个问题");
    expect(card1.querySelector(".bp-progress")!.getAttribute("title")).toBe("已完成 1/2 个任务");

    const card2 = container.querySelector('[data-objective="index/ranges"]')!;
    expect(card2.textContent).toContain("被 1 项阻塞");

    // Dependency graph view
    fireEvent.click(screen.getByRole("button", { name: "依赖图" }));
    expect([...container.querySelectorAll(".bp-column-title")].map((e) => e.textContent)).toEqual([
      "第 1 步",
      "第 2 步",
      "独立目标",
    ]);

    // Switch back to list and open objective detail
    fireEvent.click(screen.getByRole("button", { name: "列表" }));
    fireEvent.click(container.querySelector('[data-objective="foundation/identity"]')!);
    const detail = within(screen.getByRole("complementary", { name: "Declaration identity" }));
    expect(detail.getByRole("button", { name: "询问 Lead" })).toBeTruthy();
    expect(detail.getByText("高优先级")).toBeTruthy();
    expect(detail.getByText("目标")).toBeTruthy();
    expect(detail.getByText("前置依赖")).toBeTruthy();
    expect(detail.getByText("无前置依赖，可随时开始。")).toBeTruthy();
    expect(detail.getByText("下游依赖")).toBeTruthy();
    expect(detail.getByText("当前进展")).toBeTruthy();
    expect(detail.getByText(/写于 .* · abc1234/)).toBeTruthy();
    expect(detail.getByText("任务 · 1/2")).toBeTruthy();
    expect(detail.getByText("待决策 · 1")).toBeTruthy();
    expect(detail.getByText("已决策")).toBeTruthy();
    expect(detail.getByText("问题 · 1 个待处理")).toBeTruthy();
    expect(detail.getByText("1 个已接受，暂不修复。")).toBeTruthy();
    expect(detail.getByText("关联会话")).toBeTruthy();
    expect(detail.getByText("笔记")).toBeTruthy();
  });

  it("renders sealed, archived, empty, and rename states in zh-CN and switches reactively back to en", () => {
    setServerLanguage("zh-CN");
    const { container, rerender } = renderBoard({
      ...sampleProject,
      status: "sealed",
      objectives: [],
    });
    expect(screen.getByText("已封存 · 只读")).toBeTruthy();
    expect(screen.getByText(/暂无目标。告诉 Lead/)).toBeTruthy();

    rerender(
      <BoardPage
        project={{ ...sampleProject, archivedAt: 1 }}
        issues={sampleIssues}
        sessions={sessions}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onAskLead={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "恢复项目" })).toBeTruthy();
    fireEvent.click(screen.getByTitle("重命名"));
    expect(screen.getByLabelText("项目名称")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("项目名称"), { key: "Escape" });

    // Switch locale override back to English reactively
    act(() => {
      setLocaleOverride("en");
    });
    expect(screen.getByRole("dialog", { name: "clice objectives" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore project" })).toBeTruthy();
    expect(container.querySelector(".bp-summary")!.textContent).toBe("2 active · 1 later · 0 done");
  });
});

describe("IssuesView localization", () => {
  it("renders Simplified Chinese filters, evidence tooltips, warnings, and details", () => {
    setServerLanguage("zh-CN");
    const { container } = renderBoard(sampleProject, [
      ...sampleIssues,
      {
        id: "03-dup",
        title: "Dup",
        objectives: [],
        issues: [{ id: "10-01#1", state: "open", tags: [], text: "dup", objectives: [] }],
        groups: [],
        updatedAt: 0,
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^问题/ }));
    expect(screen.getByPlaceholderText("搜索问题…")).toBeTruthy();
    expect(container.querySelector(".bp-summary")!.textContent).toBe(
      "1 待处理 · 1 待决策 · 1 已接受",
    );

    const nav = within(screen.getByRole("navigation", { name: "问题筛选" }));
    expect(nav.getByRole("button", { name: /^全部模块/ })).toBeTruthy();
    expect(nav.getByRole("group", { name: "状态" })).toBeTruthy();
    expect(nav.getByRole("group", { name: "证据" })).toBeTruthy();
    expect(nav.getByRole("group", { name: "标签" })).toBeTruthy();
    expect(nav.getByRole("button", { name: /^R / }).title).toBe("已通过脚本复现");
    expect(nav.getByRole("button", { name: /^H / }).title).toBe("仅从代码分析推断");

    const brokens = [...container.querySelectorAll(".bp-broken")].map((e) => e.textContent);
    expect(brokens[0]).toBe("02-bad.toml 无法读取：parse error");
    expect(brokens[1]).toContain("同时存在于 01-core 和 03-dup 中");

    fireEvent.click(container.querySelector('[data-issue="10-01#1"]')!);
    const detail = within(screen.getByRole("complementary", { name: "问题 10-01#1" }));
    expect(detail.getByText("R · 已通过脚本复现")).toBeTruthy();
    expect(detail.getByText(/写于 .* · deadbeef/)).toBeTruthy();
    expect(detail.getByText("模块说明")).toBeTruthy();
    expect(detail.getByText("关联目标")).toBeTruthy();
    expect(detail.getByTitle("目标不存在")).toBeTruthy();

    fireEvent.click(container.querySelector('[data-issue="10-01#3"]')!);
    const detail3 = within(screen.getByRole("complementary", { name: "问题 10-01#3" }));
    expect(detail3.getByText("同组说明")).toBeTruthy();
    expect(detail3.getByText("暂无关联目标。")).toBeTruthy();
  });

  it("renders empty issues message in zh-CN", () => {
    setServerLanguage("zh-CN");
    renderBoard(sampleProject, []);
    fireEvent.click(screen.getByRole("button", { name: /^问题/ }));
    expect(screen.getByText(/暂无问题。Agent 会在这里记录已知缺陷/)).toBeTruthy();
  });
});

describe("NotesView localization", () => {
  it("renders Simplified Chinese tree, empty state, file preview, and VS Code fallback notice", async () => {
    setServerLanguage("zh-CN");
    vi.stubGlobal("navigator", {
      ...navigator,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.140.0 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "api/open") {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "No VS Code window" }), { status: 503 }),
          );
        }
        const q = new URL(url, "http://x").searchParams;
        const path = q.get("path");
        if (path === "notes") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                kind: "dir",
                path: "/notes",
                entries: [{ name: "bin.dat", dir: false, size: 4 }],
                truncated: true,
              }),
              { status: 200 },
            ),
          );
        }
        if (path === "notes/bin.dat") {
          return Promise.resolve(
            new Response(JSON.stringify({ kind: "binary", path: "/notes/bin.dat" }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: "Not found",
              candidates: ["notes/bin.dat"],
            }),
            { status: 404 },
          ),
        );
      }),
    );

    renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "笔记" }));
    expect(screen.getByText(/Lead 的笔记：规则、想法/)).toBeTruthy();

    const tree = within(await screen.findByRole("tree", { name: "笔记" }));
    fireEvent.click(await tree.findByRole("treeitem", { name: /bin\.dat/ }));
    const preview = await screen.findByRole("region", { name: "bin.dat" });
    await within(preview).findByText("二进制文件，无法预览。");
    expect(within(preview).getByRole("button", { name: "返回" })).toBeTruthy();
    expect(within(preview).getByRole("button", { name: "关闭文件" })).toBeTruthy();
    expect(within(preview).getByTitle("在 VS Code 中打开")).toBeTruthy();

    // Test VS Code fallback notice when opening a file link from an objective
    fireEvent.click(screen.getByRole("button", { name: "目标" }));
    fireEvent.click(screen.getByText("Declaration identity"));
    fireEvent.click(screen.getByText("src/a.cpp:10"));
    const fallbackPreview = await screen.findByRole("region", { name: "a.cpp" });
    await waitFor(() =>
      expect(
        within(fallbackPreview).getByText("No VS Code window：已改为在此处显示该文件。"),
      ).toBeTruthy(),
    );
    await within(fallbackPreview).findByText("你是不是要找");
  });
});
