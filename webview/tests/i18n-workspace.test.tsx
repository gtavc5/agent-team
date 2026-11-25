import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLocaleForTests, setLocaleOverride, setServerLanguage } from "../src/i18n";
import { tWorkspace, workspaceMessages } from "../src/i18n/workspace";
import { groupWorkspaces } from "../src/sidebar/groups";
import { QuotaPanel } from "../src/sidebar/QuotaPanel";
import { detailWindowLabel, quotaRowLabels, shortWindowLabel } from "../src/sidebar/quota";
import { Sidebar, type SidebarProps } from "../src/sidebar/Sidebar";
import type {
  AgentInfo,
  CodexAuthState,
  ModelOption,
  Project,
  UiDialogRequest,
  Workspace,
} from "../src/state/useServer";
import {
  AddAgentDialog,
  CODEX_LOGIN_COMMAND,
  CodexSetupDialog,
  ConfirmDialog,
  CreateProjectDialog,
  CreateWorkspaceDialog,
} from "../src/workspace/dialogs";
import { ExtensionUi } from "../src/workspace/ExtensionUi";
import { GitBar } from "../src/workspace/GitBar";
import { ReportSwitch } from "../src/workspace/ReportSwitch";
import { RoleTag } from "../src/workspace/RoleTag";
import { UiDialogModal } from "../src/workspace/UiDialogModal";

const NOW = 1_800_000_000_000;

afterEach(() => {
  resetLocaleForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  history.replaceState(null, "", location.pathname);
});

describe("workspace i18n catalog", () => {
  it("has non-empty en and zh-CN strings and matching placeholders for every key", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, entry] of Object.entries(workspaceMessages)) {
      expect(entry.en.trim().length, `${key}.en`).toBeGreaterThan(0);
      expect(entry["zh-CN"].trim().length, `${key}.zh-CN`).toBeGreaterThan(0);
      expect(placeholders(entry["zh-CN"]), `${key} placeholders`).toEqual(placeholders(entry.en));
    }
    expect(tWorkspace("deleteSessionTitle", { name: "demo" }, "en")).toBe("Delete demo?");
    expect(tWorkspace("deleteSessionTitle", { name: "demo" }, "zh-CN")).toBe("删除 demo？");
  });
});

describe("Sidebar and groups localization", () => {
  const project: Project = {
    id: "p1",
    name: "clice",
    root: "/repo/clice",
    leadWorkspaceId: "lead",
    createdAt: NOW - 10_000,
    objectives: [],
  };

  const lead: Workspace = {
    id: "lead",
    name: "clice · lead",
    project: "clice",
    hostId: "local",
    cwd: "/repo/clice",
    git: { branch: "feat/i18n", dirty: 2, ahead: 1, behind: 0 },
    pr: null,
    agents: [],
    messages: [],
    createdAt: NOW - 5000,
    lastMessageAt: NOW - 4000,
    projectLink: { projectId: "p1", role: "lead" },
  };

  const worker: Workspace = {
    id: "w1",
    name: "worker-one",
    project: "clice",
    hostId: "local",
    cwd: "/wt/clice-w1",
    git: null,
    pr: null,
    agents: [],
    messages: [],
    createdAt: NOW - 4000,
    lastMessageAt: NOW - 3000,
    awaitsUser: true,
    projectLink: { projectId: "p1", role: "worker", isolated: true },
  };

  const archivedWorker: Workspace = {
    ...worker,
    id: "w-arch",
    name: "old-worker",
    archivedAt: NOW - 1000,
  };

  const looseArchived: Workspace = {
    id: "loose-arch",
    name: "loose-old",
    project: "other",
    hostId: "local",
    cwd: "",
    git: null,
    pr: null,
    agents: [],
    messages: [],
    createdAt: NOW - 9000,
    lastMessageAt: NOW - 8000,
    archivedAt: NOW - 500,
  };

  const baseProps = (over: Partial<SidebarProps> = {}): SidebarProps => ({
    workspaces: [lead, worker, archivedWorker, looseArchived],
    projects: [project],
    activeWsId: "lead",
    connected: false,
    groupOverrides: {},
    finishedStatus: {},
    searchQuery: "",
    searchHits: null,
    systemStatus: {
      osName: "Linux",
      osArch: "x64",
      cpuModel: "CPU",
      cpuCores: 8,
      cpuUsage: 24,
      memTotal: 1024 * 1024 * 1024 * 16,
      memUsed: 1024 * 1024 * 1024 * 4,
      uptime: 3600,
      hostname: "dev",
    },
    now: NOW,
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onDeleteProject: vi.fn(),
    onToggleGroup: vi.fn(),
    onSearchChange: vi.fn(),
    onJump: vi.fn(),
    onCreate: vi.fn(),
    onCreateProject: vi.fn(),
    onCreateIn: vi.fn(),
    onReplayDemo: vi.fn(),
    onDebugSnapshot: vi.fn(),
    onPurgeArchived: vi.fn(),
    onArchiveProject: vi.fn(),
    onRestoreProject: vi.fn(),
    onRenameProject: vi.fn(),
    ...over,
  });

  it("localizes groups fallback label and sidebar controls in zh-CN, falling back cleanly to en", () => {
    setServerLanguage("简体中文");

    const noPathGroup = groupWorkspaces([{ ...looseArchived, archivedAt: undefined }]);
    expect(noPathGroup[0].key).toBe("(no path)");
    expect(noPathGroup[0].label).toBe("（无路径）");

    const { container, rerender } = render(<Sidebar {...baseProps()} />);

    expect(screen.getByText("工作区")).toBeTruthy();
    expect(screen.getByText("离线")).toBeTruthy();
    expect(screen.getByTitle("新建会话")).toBeTruthy();
    expect(screen.getByTitle("新建项目")).toBeTruthy();
    expect(screen.getByPlaceholderText("搜索消息…")).toBeTruthy();
    expect(screen.getByTitle("打开 clice 的 Lead 会话")).toBeTruthy();
    expect(screen.getByLabelText("折叠 clice")).toBeTruthy();
    expect(screen.getByTitle("在 clice 中新建会话")).toBeTruthy();
    expect(screen.getByTitle("归档 clice 及其会话")).toBeTruthy();
    expect(screen.getByRole("button", { name: "归档" })).toBeTruthy();
    expect(screen.getByTitle("2 个已更改文件，领先 1 个提交")).toBeTruthy();
    expect(screen.getByText("隔离")).toBeTruthy();
    expect(screen.getByText("轮到你")).toBeTruthy();
    expect(screen.getByTitle("等待你的回复")).toBeTruthy();
    expect(screen.getByText("CPU")).toBeTruthy();
    expect(screen.getByText("内存")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "调试工具（服务诊断：离线）" }));
    expect(screen.getByRole("link", { name: "服务诊断（离线）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "回放演示" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "捕获调试快照" })).toBeTruthy();

    // Open project archive and loose archive sections
    fireEvent.click(container.querySelector(".ws-archive-toggle")!);
    expect(screen.getByTitle("删除 clice 的已归档会话")).toBeTruthy();
    expect(screen.getByRole("button", { name: "清空" })).toBeTruthy();
    fireEvent.click(container.querySelector(".ws-archived .ws-archived-header")!);
    expect(screen.getByTitle("删除不属于任何项目的已归档工作区")).toBeTruthy();

    // Delete session confirm dialog
    fireEvent.click(screen.getAllByTitle("删除会话")[0]);
    const deleteDialog = within(screen.getByRole("dialog"));
    expect(deleteDialog.getByText("删除 worker-one？")).toBeTruthy();
    expect(deleteDialog.getByText("此会话及其消息历史将被删除。")).toBeTruthy();
    expect(deleteDialog.getByRole("button", { name: "取消" })).toBeTruthy();
    expect(deleteDialog.getByRole("button", { name: "删除会话" })).toBeTruthy();
    fireEvent.click(deleteDialog.getByRole("button", { name: "取消" }));

    // Search states
    rerender(<Sidebar {...baseProps({ searchQuery: "x", searchHits: null })} />);
    expect(screen.getByText("搜索中…")).toBeTruthy();
    rerender(<Sidebar {...baseProps({ searchQuery: "x", searchHits: [] })} />);
    expect(screen.getByText("无结果")).toBeTruthy();

    // Empty workspaces
    rerender(<Sidebar {...baseProps({ workspaces: [], projects: [], searchQuery: "" })} />);
    expect(screen.getByText("暂无工作区")).toBeTruthy();

    // Switch reactively back to English
    act(() => {
      setLocaleOverride("en");
    });
    expect(screen.getByText("Workspaces")).toBeTruthy();
    expect(screen.getByText("offline")).toBeTruthy();
    expect(screen.getByText("No workspaces yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Service diagnostics (offline)" })).toBeTruthy();
  });
});

describe("QuotaPanel and quota helper localization", () => {
  it("renders quota headers, short/detail labels, status text, and reset timestamps in zh-CN", () => {
    setServerLanguage("zh-CN");
    const observedAt = NOW - 120_000;

    expect(
      quotaRowLabels([
        {
          provider: "native-codex",
          name: "Codex",
          observedAt,
          availability: "available",
          windows: [],
        },
        {
          provider: "openai-codex",
          name: "Codex",
          observedAt,
          availability: "available",
          windows: [],
        },
      ]),
    ).toEqual(["Codex · 原生", "Codex · Pi"]);

    expect(shortWindowLabel("weekly")).toBe("周");
    expect(shortWindowLabel("daily")).toBe("日");
    expect(shortWindowLabel("monthly total")).toBe("月");
    expect(shortWindowLabel("monthly code")).toBe("代码");
    expect(shortWindowLabel("primary")).toBe("主");
    expect(shortWindowLabel("secondary")).toBe("次");
    expect(detailWindowLabel("weekly")).toBe("每周");
    expect(detailWindowLabel("5h")).toBe("5小时");
    expect(detailWindowLabel("monthly code")).toBe("月度代码");

    render(
      <QuotaPanel
        now={NOW}
        connected
        quota={{
          refreshing: false,
          acpPrepareStep: "yaat acp prepare",
          rows: [
            {
              provider: "antigravity-acp",
              name: "Gemini",
              availability: "available",
              observedAt: NOW - 16 * 60_000,
              windows: [{ label: "weekly", usedPct: 34, resetsAt: NOW + 3_600_000 }],
            },
            {
              provider: "native-codex",
              name: "Codex",
              availability: "unavailable",
              reason: "usage unavailable",
              observedAt: 0,
              windows: [],
            },
            {
              provider: "acp-2",
              name: "Setup",
              availability: "unavailable",
              reason: "waiting for ACP setup",
              observedAt: 0,
              windows: [],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("配额使用")).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新" }).title).toBe("刷新配额");

    const agyRow = screen.getByRole("button", { name: /Agy · Gemini/ });
    expect(agyRow.textContent).toContain("已过期");
    expect(agyRow.textContent).toContain("周 34%");
    fireEvent.click(agyRow);
    expect(screen.getByText(/每周:/)).toBeTruthy();
    expect(screen.getByText("已用 34%")).toBeTruthy();
    expect(screen.getByText(/重置于 /)).toBeTruthy();
    expect(screen.getByText(/已过期 · 更新于 16分钟前/)).toBeTruthy();

    const codexRow = screen.getByRole("button", { name: /Codex/ });
    fireEvent.click(codexRow);
    expect(screen.getByText("不可用 · 用量不可用")).toBeTruthy();
    expect(screen.getAllByText("尚未获取").length).toBeGreaterThanOrEqual(1);

    const setupRow = screen.getByRole("button", { name: /acp-2 · Setup/ });
    expect(setupRow.textContent).toContain("等待配置");
    fireEvent.click(setupRow);
    expect(screen.getByText(/等待显式完成 ACP 配置/)).toBeTruthy();
  });
});

describe("Workspace dialogs localization", () => {
  const models: ModelOption[] = [
    {
      id: "google/gemini-4",
      label: "Gemini 4",
      backend: "pi",
      effortLevels: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
  ];
  const unauthedCodex: CodexAuthState = {
    cliAvailable: true,
    authenticated: false,
    status: "unauthenticated",
    accountType: null,
    checkedAt: 1,
  };

  it("localizes ConfirmDialog, AddAgentDialog, CodexSetupDialog, CreateProjectDialog, and CreateWorkspaceDialog", async () => {
    setServerLanguage("zh-CN");

    const c = render(
      <ConfirmDialog title="确认操作" body="确定继续？" onConfirm={() => {}} onClose={() => {}} />,
    );
    expect(c.getByRole("button", { name: "取消" })).toBeTruthy();
    expect(c.getByRole("button", { name: "确认" })).toBeTruthy();
    c.unmount();

    const add = render(
      <AddAgentDialog
        presets={[{ name: "Kisara", avatar: "K", color: "#fff" }]}
        models={models}
        codexAuth={unauthedCodex}
        onOpenCodexSetup={() => {}}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(add.getByRole("dialog", { name: "添加代理" })).toBeTruthy();
    expect(add.getByText("名称（或使用预设）")).toBeTruthy();
    expect(add.getByLabelText("模型")).toBeTruthy();
    expect(add.getByText("Codex（未登录）")).toBeTruthy();
    expect(add.getByRole("button", { name: "登录 Codex…" })).toBeTruthy();
    const effortSelect = add.getByLabelText("推理强度") as HTMLSelectElement;
    expect([...effortSelect.options].map((o) => o.textContent)).toEqual([
      "默认（中）",
      "低",
      "中",
      "高",
    ]);
    expect(add.getByRole("button", { name: "添加" })).toBeTruthy();
    add.unmount();

    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(true) },
      configurable: true,
    });
    const setup = render(
      <CodexSetupDialog
        codexAuth={unauthedCodex}
        rechecking={false}
        onRecheck={() => {}}
        onClose={() => {}}
      />,
    );
    expect(setup.getByRole("dialog", { name: "登录 Codex" })).toBeTruthy();
    expect(setup.getByText(CODEX_LOGIN_COMMAND)).toBeTruthy();
    await act(async () => {
      fireEvent.click(setup.getByRole("button", { name: "复制" }));
      await Promise.resolve();
    });
    expect(setup.getByRole("button", { name: "已复制" })).toBeTruthy();
    fireEvent.click(setup.getByRole("button", { name: "重新检查" }));
    expect(setup.getByRole("status").textContent).toContain("仍未登录");
    expect(setup.getByRole("button", { name: "关闭" })).toBeTruthy();
    setup.unmount();

    const proj = render(<CreateProjectDialog onClose={() => {}} onCreate={() => {}} />);
    expect(proj.getByRole("dialog", { name: "新建项目" })).toBeTruthy();
    expect(proj.getByPlaceholderText("项目名称…")).toBeTruthy();
    expect(proj.getByLabelText("仓库路径")).toBeTruthy();
    fireEvent.click(proj.getByLabelText("不使用 Git 仓库创建"));
    expect(proj.getByPlaceholderText("无仓库")).toBeTruthy();
    expect(proj.getByRole("button", { name: "创建项目" })).toBeTruthy();
    proj.unmount();

    const wsDialog = render(
      <CreateWorkspaceDialog
        hosts={[
          { id: "local", label: "Local", type: "local", connected: true },
          { id: "ssh", label: "Remote", type: "remote", connected: true },
        ]}
        onClose={() => {}}
        onCreate={() => {}}
        onListDirs={() => {}}
        dirSuggestions={{ prefix: "", dirs: [] }}
      />,
    );
    expect(wsDialog.getByRole("dialog", { name: "新建会话" })).toBeTruthy();
    expect(wsDialog.getByLabelText("目录路径")).toBeTruthy();
    fireEvent.change(wsDialog.getByLabelText("目录路径"), { target: { value: "/repo/new" } });
    expect(wsDialog.getByLabelText("项目")).toBeTruthy();
    expect(wsDialog.getByLabelText("主机")).toBeTruthy();
    expect(wsDialog.getByRole("button", { name: "创建会话" })).toBeTruthy();
  });
});

describe("Workspace controls localization", () => {
  it("localizes ExtensionUi, GitBar, ReportSwitch, RoleTag, and UiDialogModal in zh-CN", () => {
    setServerLanguage("zh-CN");

    const agent: AgentInfo = {
      id: "a1",
      name: "Alice",
      model: "pi/model",
      avatar: "A",
      color: "#fff",
      isDefault: true,
    };
    const ws: Workspace = {
      id: "w1",
      name: "w1",
      project: "p",
      hostId: "local",
      cwd: "/repo",
      agents: [agent],
      messages: [],
      createdAt: NOW,
    };

    const ext = render(
      <ExtensionUi
        workspace={ws}
        placement="aboveEditor"
        dismiss={() => {}}
        ui={{
          agents: [
            { workspaceId: "w1", agentId: "a1", processGeneration: 1, statuses: [], widgets: [] },
          ],
          notices: [
            {
              kind: "notify",
              id: "n1",
              workspaceId: "w1",
              agentId: "a1",
              processGeneration: 1,
              level: "info",
              message: "ready",
              expiresAt: NOW + 10_000,
            },
          ],
        }}
      />,
    );
    expect(ext.getByRole("region", { name: "Alice 扩展界面" })).toBeTruthy();
    expect(ext.getByRole("button", { name: "关闭通知" })).toBeTruthy();
    ext.unmount();

    const gitBar = render(
      <GitBar
        git={{ branch: "feat/ui", dirty: 2, ahead: 1, behind: 3 }}
        pr={{
          number: 42,
          title: "Add zh-CN",
          url: "https://example.com/pr/42",
          state: "open",
          draft: false,
          checks: "success",
        }}
      />,
    );
    expect(
      gitBar.getByTitle("2 个已更改文件 · 领先上游 1 个提交 · 落后上游 3 个提交"),
    ).toBeTruthy();
    const prLink = gitBar.getByRole("link", { name: /#42/ });
    expect(prLink.className).toContain("pr-open");
    expect(prLink.getAttribute("title")).toBe("Add zh-CN（开启，检查通过）");
    expect(gitBar.getByText("开启")).toBeTruthy();
    gitBar.unmount();

    const reportOn = render(
      <ReportSwitch link={{ projectId: "p1", role: "worker" }} onSet={() => {}} />,
    );
    expect(reportOn.getByRole("button", { name: "向 Lead 汇报" }).title).toContain(
      "向项目的 Lead 汇报",
    );
    reportOn.unmount();

    const reportOff = render(
      <ReportSwitch
        link={{ projectId: "p1", role: "worker", unreported: true }}
        onSet={() => {}}
      />,
    );
    expect(reportOff.getByRole("button", { name: "未汇报" }).title).toContain("你的独立会话");
    reportOff.unmount();

    const role = render(
      <>
        <RoleTag link={{ projectId: "p1", role: "lead" }} name="main" />
        <RoleTag link={{ projectId: "p1", role: "worker", isolated: true }} />
      </>,
    );
    expect(role.getByText("Lead")).toBeTruthy();
    expect(role.getByText("隔离").getAttribute("title")).toContain("仅可见自身任务");
    role.unmount();

    const dialogReq: UiDialogRequest = {
      requestId: "req-1",
      workspaceId: "w1",
      agentId: "a1",
      processGeneration: 1,
      method: "input",
      title: "需要输入",
      createdAt: NOW,
      timeoutMs: 60_000,
      expiresAt: Date.now() + 25_000,
    };
    const modal = render(<UiDialogModal dialog={dialogReq} onRespond={() => true} />);
    const modalScope = within(modal.getByRole("dialog", { name: "需要输入" }));
    expect(modalScope.getByLabelText("剩余时间").textContent).toMatch(/^剩余 \d+ 秒$/);
    expect(modalScope.getByLabelText("回复")).toBeTruthy();
    expect(modalScope.getByRole("button", { name: "取消" })).toBeTruthy();
    fireEvent.click(modalScope.getByRole("button", { name: "提交" }));
    expect(modalScope.getByRole("status").textContent).toBe("回复已发送，正在等待会话处理…");

    // Verify English default when reset
    act(() => {
      resetLocaleForTests();
    });
    expect(modalScope.getByLabelText("Time remaining").textContent).toMatch(/s remaining$/);
    expect(modalScope.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(modalScope.getByRole("status").textContent).toBe(
      "Answer sent; waiting for the session…",
    );
  });
});
