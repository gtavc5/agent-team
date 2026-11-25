import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLocaleForTests, setLocaleOverride, setServerLanguage } from "../src/i18n";
import { panelMessages, tPanel } from "../src/i18n/panels";
import { AgentsPanel, type AgentsPanelActions } from "../src/panels/AgentsPanel";
import { ChangeCount, ChangesList, DiffView, type Changes } from "../src/panels/ChangesView";
import { FilesPanel, type FileView } from "../src/panels/FilesPanel";
import { Rail } from "../src/panels/Rail";
import { soon } from "../src/panels/SessionTasks";
import { SidePanel } from "../src/panels/SidePanel";
import { scopeSummary, stateSummary } from "../src/panels/scope";
import type { AgentInfo, ModelOption, Project, Workspace } from "../src/state/useServer";

const NOW = 1_800_000_000_000;

const makeAgent = (id: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  name: id,
  model: "claude-opus-5-5",
  avatar: "A",
  color: "#fff",
  isDefault: true,
  ...over,
});

const makeWorkspace = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  project: "repo",
  hostId: "local",
  cwd: `/home/me/work/${id}`,
  git: null,
  pr: null,
  agents: [makeAgent(`${id}-a`)],
  messages: [],
  createdAt: NOW - 60_000,
  lastMessageAt: NOW - 60_000,
  ...over,
});

const makeActions = (): AgentsPanelActions => ({
  onOpen: vi.fn(),
  onStop: vi.fn(),
  onArchive: vi.fn(),
  onRestore: vi.fn(),
  onSetReporting: vi.fn(),
  onAddAgent: vi.fn(),
  onClearContext: vi.fn(),
  onRemoveAgent: vi.fn(),
  onSetModel: vi.fn(),
  onSetEffort: vi.fn(),
  onStopTask: vi.fn(),
  onCancelWake: vi.fn(),
  onStopAll: vi.fn(),
});

afterEach(() => {
  resetLocaleForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.getSelection()?.removeAllRanges();
});

describe("panels i18n catalog", () => {
  it("provides non-empty en and zh-CN entries for every key and interpolates params", () => {
    for (const [key, entry] of Object.entries(panelMessages)) {
      expect(entry.en.trim().length, `${key}.en`).toBeGreaterThan(0);
      expect(entry["zh-CN"].trim().length, `${key}.zh-CN`).toBeGreaterThan(0);
    }
    expect(tPanel("panelCloseLabel", { title: "Files" }, "en")).toBe("Close Files");
    expect(tPanel("panelCloseLabel", { title: "文件" }, "zh-CN")).toBe("关闭 文件");
  });
});

describe("Rail and SidePanel localization", () => {
  it("localizes Rail navigation label and updates reactively", () => {
    const { container } = render(
      <Rail
        className="side-rail"
        items={[{ id: "files", label: "Files", icon: "files", active: false, onClick: vi.fn() }]}
      />,
    );
    const nav = container.querySelector("nav")!;
    expect(nav.getAttribute("aria-label")).toBe("Panels");

    act(() => setLocaleOverride("zh-CN"));
    expect(nav.getAttribute("aria-label")).toBe("面板");

    act(() => setLocaleOverride("en"));
    expect(nav.getAttribute("aria-label")).toBe("Panels");
  });

  it("localizes SidePanel controls and tooltips in zh-CN and falls back to en", () => {
    vi.stubGlobal("innerWidth", 1440);
    setLocaleOverride("zh-CN");
    const { container, rerender } = render(
      <SidePanel
        title="文件"
        pinned={false}
        maximized={false}
        inset={260}
        width={null}
        onPin={vi.fn()}
        onMaximize={vi.fn()}
        onClose={vi.fn()}
        onWidth={vi.fn()}
      >
        <div>body</div>
      </SidePanel>,
    );
    expect(container.querySelector(".side-panel-resize")!.getAttribute("title")).toBe(
      "拖动调整宽度 · 双击恢复自动宽度",
    );
    expect(container.querySelector(".side-panel-max")!.getAttribute("title")).toBe(
      "在聊天区域最大化",
    );
    expect(container.querySelector(".side-panel-pin")!.getAttribute("title")).toBe(
      "固定在聊天侧边",
    );
    expect(container.querySelector(".side-panel-close")!.getAttribute("aria-label")).toBe(
      "关闭 文件",
    );

    rerender(
      <SidePanel
        title="文件"
        pinned={false}
        maximized
        inset={260}
        width={null}
        onPin={vi.fn()}
        onMaximize={vi.fn()}
        onClose={vi.fn()}
        onWidth={vi.fn()}
      >
        <div>body</div>
      </SidePanel>,
    );
    expect(container.querySelector(".side-panel-max")!.getAttribute("title")).toBe(
      "还原到聊天侧边",
    );

    vi.stubGlobal("innerWidth", 500);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    rerender(
      <SidePanel
        title="Files"
        pinned={false}
        maximized={false}
        inset={260}
        width={null}
        onPin={vi.fn()}
        onMaximize={vi.fn()}
        onClose={vi.fn()}
        onWidth={vi.fn()}
      >
        <div>body</div>
      </SidePanel>,
    );
    expect(container.querySelector(".side-panel-pin")!.getAttribute("title")).toBe(
      "窗口过窄，无法固定在聊天侧边",
    );

    act(() => setLocaleOverride("en"));
    expect(container.querySelector(".side-panel-pin")!.getAttribute("title")).toBe(
      "Too narrow to pin beside the chat",
    );
    expect(container.querySelector(".side-panel-close")!.getAttribute("aria-label")).toBe(
      "Close Files",
    );
  });
});

describe("scope localization", () => {
  it("formats stateSummary and scopeSummary in en and zh-CN", () => {
    const project: Project = {
      id: "p1",
      name: "yaat",
      root: "/repo",
      leadWorkspaceId: "lead",
      createdAt: 0,
      objectives: [],
    };
    const lead = makeWorkspace("lead", {
      projectLink: { projectId: "p1", role: "lead" },
      agents: [makeAgent("a1", { state: "working" })],
    });
    const worker = makeWorkspace("w1", {
      projectLink: { projectId: "p1", role: "worker" },
      agents: [makeAgent("a2", { state: "waiting" })],
    });
    const solo = makeWorkspace("solo", {
      agents: [makeAgent("a1")],
    });
    const archived = makeWorkspace("old", { archivedAt: NOW - 10 });

    expect(stateSummary(["working", "waiting", "sleeping"])).toBe(
      "1 working · 1 waiting · 1 sleeping",
    );
    expect(stateSummary(["idle"])).toBe("idle");
    expect(scopeSummary([lead, worker], project)).toBe("yaat · 2 sessions · 1 working · 1 waiting");
    expect(scopeSummary([solo], undefined)).toBe("solo · 1 agent · idle");
    expect(scopeSummary([archived], undefined)).toBe("old · archived");

    setServerLanguage("zh-CN");
    expect(stateSummary(["working", "waiting", "sleeping"])).toBe("1 工作中 · 1 等待中 · 1 休眠中");
    expect(stateSummary(["idle"])).toBe("空闲");
    expect(scopeSummary([lead, worker], project)).toBe("yaat · 2 个会话 · 1 工作中 · 1 等待中");
    expect(scopeSummary([solo], undefined)).toBe("solo · 1 个代理 · 空闲");
    expect(scopeSummary([archived], undefined)).toBe("old · 已归档");
  });
});

describe("AgentsPanel and SessionTasks localization", () => {
  it("renders session cards, tasks, dialogs, and overview tags in zh-CN", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setLocaleOverride("zh-CN");

    const project: Project = {
      id: "p1",
      name: "yaat",
      root: "/repo",
      leadWorkspaceId: "lead",
      createdAt: 0,
      objectives: [],
    };
    const models: ModelOption[] = [
      { id: "claude-opus-5-5", label: "Opus 5.5", backend: "pi" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", backend: "pi" },
    ];
    const active = makeWorkspace("w1", {
      name: "modules",
      cwd: "/repo/.worktrees/modules",
      git: { branch: "feat/i18n", dirty: 3, ahead: 0, behind: 0 },
      projectLink: { projectId: "p1", role: "worker" },
      agents: [
        makeAgent("kisara", {
          state: "working",
          context: { tokens: 50_000, window: 200_000 },
          effort: "high",
          effortLevels: ["low", "medium", "high"],
          backgroundTasks: [
            { id: "b1", type: "local_bash", description: "npm test", since: NOW - 15_000 },
            { id: "m1", type: "monitor", description: "watch build", since: NOW - 5_000 },
          ],
        }),
        makeAgent("isla", {
          state: "sleeping",
          wake: { at: NOW + 12 * 60_000, reason: "" },
        }),
        makeAgent("codex-bot", {
          state: "idle",
          canSwitchBackend: true,
        }),
      ],
    });
    const awaiting = makeWorkspace("w2", {
      name: "review",
      awaitsUser: true,
      agents: [],
      projectLink: { projectId: "p1", role: "worker" },
    });
    const archived = makeWorkspace("w3", {
      name: "old",
      archivedAt: NOW - 10,
      projectLink: { projectId: "p1", role: "worker" },
    });

    const { container, getByText } = render(
      <AgentsPanel
        sessions={[active, awaiting, archived]}
        project={project}
        activeWsId="w1"
        connected
        models={models}
        codexAuth={{
          cliAvailable: true,
          authenticated: false,
          status: "unauthenticated",
          checkedAt: NOW,
        }}
        actions={makeActions()}
      />,
    );

    expect(container.querySelector(".ap-archived summary")!.textContent).toBe("已归档 · 1");
    const activeCard = within(container.querySelector('[aria-label="modules"]') as HTMLElement);
    expect(activeCard.getByLabelText("折叠 modules")).toBeTruthy();
    expect(activeCard.getByTitle("打开此会话")).toBeTruthy();
    expect(activeCard.getByText("3 处更改")).toBeTruthy();
    expect(activeCard.getByText("+ 代理")).toBeTruthy();
    expect(activeCard.getByText("全部停止")).toBeTruthy();
    expect(activeCard.getByLabelText("kisara 的模型")).toBeTruthy();
    expect(activeCard.getByLabelText("kisara 的推理强度")).toBeTruthy();
    expect(activeCard.getByText("Codex（未登录）")).toBeTruthy();
    expect(activeCard.getByLabelText("清空 kisara 的上下文")).toBeTruthy();
    expect(activeCard.getByLabelText("移除 kisara")).toBeTruthy();
    expect(activeCard.getByText("工作中 · 2 个后台任务")).toBeTruthy();
    expect(activeCard.getByText("终端")).toBeTruthy();
    expect(activeCard.getByText("监控")).toBeTruthy();
    expect(activeCard.getByLabelText("停止 npm test")).toBeTruthy();
    expect(activeCard.getByText("唤醒")).toBeTruthy();
    expect(activeCard.getByText("定时唤醒")).toBeTruthy();
    expect(activeCard.getByText("取消")).toBeTruthy();
    expect(container.querySelector(".tp-wake .tp-when")!.textContent).toContain("12分钟后");

    // Confirm dialog localization
    fireEvent.click(activeCard.getByLabelText("清空 kisara 的上下文"));
    expect(getByText("清空 kisara 的上下文？")).toBeTruthy();
    expect(getByText("该代理将使用全新的上下文继续对话。")).toBeTruthy();
    expect(getByText("清空上下文")).toBeTruthy();

    const awaitingCard = within(container.querySelector('[aria-label="review"]') as HTMLElement);
    expect(awaitingCard.getByText("待回复")).toBeTruthy();
    expect(awaitingCard.getByTitle("等待你的回复")).toBeTruthy();
    expect(awaitingCard.getByText("暂无代理。")).toBeTruthy();
    expect(awaitingCard.getByText("归档")).toBeTruthy();

    // Sealed project footer
    const sealed = render(
      <AgentsPanel
        sessions={[awaiting]}
        project={{ ...project, status: "sealed" }}
        activeWsId="w2"
        connected
        models={models}
        actions={makeActions()}
      />,
    );
    expect(sealed.getByText("已封存 · 只读")).toBeTruthy();

    // Overview folded tags + soon() in zh-CN vs en
    const overview = render(
      <AgentsPanel
        sessions={[active]}
        project={project}
        activeWsId="w1"
        connected
        models={models}
        actions={makeActions()}
        overview
      />,
    );
    expect(overview.container.querySelector(".ap-brief-tasks")!.textContent).toBe(
      "2 个后台任务 · 12分钟后唤醒",
    );
    expect(soon(30_000)).toBe("30秒");
    expect(soon(75 * 60_000)).toBe("1小时15分钟");

    setLocaleOverride("en");
    expect(soon(30_000)).toBe("30s");
    expect(soon(75 * 60_000)).toBe("1h 15m");
  });
});

describe("ChangesView and FilesPanel localization", () => {
  it("localizes ChangeCount, ChangesList, and DiffView in zh-CN", () => {
    setLocaleOverride("zh-CN");
    const { container: countEl } = render(<ChangeCount added={null} removed={null} />);
    expect(countEl.textContent).toBe("二进制");

    const changes: Changes = {
      top: "/w",
      branch: "feat",
      base: "origin/main",
      against: "abc",
      truncated: true,
      files: [{ path: "src/a.ts", status: "modified", added: 2, removed: 1 }],
    };
    const list = render(
      <ChangesList changes={changes} open={vi.fn()} closed={new Set()} toggle={vi.fn()} />,
    );
    expect(list.container.querySelector(".changes-head")!.textContent).toBe(
      "对比 origin/main · 1 个文件",
    );
    expect(list.container.querySelector(".change-status")!.getAttribute("title")).toBe("已修改");
    expect(list.getByText("仅列出前一部分文件。")).toBeTruthy();

    const empty = render(
      <ChangesList
        changes={{ ...changes, base: null, truncated: false, files: [] }}
        open={vi.fn()}
        closed={new Set()}
        toggle={vi.fn()}
      />,
    );
    expect(empty.container.querySelector(".changes-head")!.textContent).toBe("未提交 · 0 个文件");
    expect(empty.getByText("无更改")).toBeTruthy();

    const binDiff = render(
      <DiffView diff={{ path: "a.png", diff: "", binary: true, truncated: false }} lang={null} />,
    );
    expect(binDiff.getByText("二进制文件已更改")).toBeTruthy();

    const emptyDiff = render(
      <DiffView diff={{ path: "a.ts", diff: "", binary: false, truncated: false }} lang={null} />,
    );
    expect(emptyDiff.getByText("文本内容无更改")).toBeTruthy();

    const truncDiff = render(
      <DiffView
        diff={{ path: "a.ts", diff: "@@ -1,1 +1,1 @@\n-a\n+b\n", binary: false, truncated: true }}
        lang={null}
      />,
    );
    expect(truncDiff.getByText("仅显示差异的前一部分。")).toBeTruthy();
  });

  it("localizes FilesPanel controls, folder states, markdown toggle, and binary notice in zh-CN", async () => {
    setLocaleOverride("zh-CN");
    const views: Record<string, FileView> = {
      "/empty": { kind: "dir", path: "/empty", truncated: true, entries: [] },
      "/w/README.md": {
        kind: "text",
        path: "/w/README.md",
        size: 100,
        content: "# Hi\n",
        truncated: true,
      },
      "/w/a.bin": { kind: "binary", path: "/w/a.bin", size: 2048 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const path = new URLSearchParams(url.split("?")[1]).get("path")!;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(views[path]),
        });
      }),
    );

    const roots = [
      { label: "w · main", path: "/w" },
      { label: "wt · feat", path: "/wt" },
    ];
    const dir = render(<FilesPanel wsId="w1" target={{ path: "/empty" }} roots={roots} />);
    await waitFor(() => expect(dir.getByText("空文件夹")).toBeTruthy());
    expect(dir.getByText("仅列出前一部分条目。")).toBeTruthy();
    expect(dir.getByTitle("上级文件夹")).toBeTruthy();
    expect(dir.getByLabelText("文件夹")).toBeTruthy();
    expect((dir.getByLabelText("文件夹") as HTMLSelectElement).selectedOptions[0].textContent).toBe(
      "其他位置",
    );
    expect(dir.getByTitle("复制路径").textContent).toBe("复制");
    expect(dir.getByTitle("查看相对基准分支的更改")).toBeTruthy();
    dir.unmount();

    const md = render(<FilesPanel wsId="w1" target={{ path: "/w/README.md" }} roots={roots} />);
    await waitFor(() => expect(md.getByText("源码")).toBeTruthy());
    expect(md.getByText("原始文件")).toBeTruthy();
    expect(md.getByText("仅显示前 5 B（共 100 B）。")).toBeTruthy();
    fireEvent.click(md.getByText("源码"));
    expect(md.getByText("预览")).toBeTruthy();
    md.unmount();

    const bin = render(<FilesPanel wsId="w1" target={{ path: "/w/a.bin" }} roots={roots} />);
    await waitFor(() => expect(bin.getByText("查看原始文件")).toBeTruthy());
    expect(bin.container.textContent).toContain("二进制文件 · 2.0 KB · 查看原始文件");
  });
});
