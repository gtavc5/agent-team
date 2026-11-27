import { act, cleanup, fireEvent, render, renderHook, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { resetLocaleForTests, setLocaleOverride } from "../src/i18n";
import { AgentsPanel, type AgentsPanelActions } from "../src/panels/AgentsPanel";
import { Sidebar, type SidebarProps } from "../src/sidebar/Sidebar";
import { useServer, type AgentInfo, type Project, type Workspace } from "../src/state/useServer";
import { FakeSocket } from "./fakeSocket";

const NOW = 1_800_000_000_000;

const agent = (id: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  name: id,
  model: "claude-opus-5-5",
  avatar: "A",
  color: "#fff",
  isDefault: true,
  ...over,
});

const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  project: "clice",
  hostId: "local",
  cwd: `/repo/${id}`,
  git: null,
  pr: null,
  agents: [agent(`${id}-a`)],
  messages: [],
  createdAt: NOW - 50_000,
  lastMessageAt: NOW - 1_000,
  ...over,
});

const project: Project = {
  id: "p1",
  name: "clice",
  root: "/repo",
  leadWorkspaceId: "lead",
  createdAt: NOW - 100_000,
  objectives: [],
};

const lead = ws("lead", {
  name: "clice · lead",
  cwd: "/repo",
  projectLink: { projectId: "p1", role: "lead" },
});

const makeActions = (over: Partial<AgentsPanelActions> = {}): AgentsPanelActions => ({
  onOpen: vi.fn(),
  onStop: vi.fn(),
  onArchive: vi.fn(),
  onRestore: vi.fn(),
  onSetReporting: vi.fn(),
  onHandBackToLead: vi.fn(),
  onAddAgent: vi.fn(),
  onClearContext: vi.fn(),
  onRemoveAgent: vi.fn(),
  onSetModel: vi.fn(),
  onSetEffort: vi.fn(),
  onStopTask: vi.fn(),
  onCancelWake: vi.fn(),
  onStopAll: vi.fn(),
  ...over,
});

const sidebarProps = (over: Partial<SidebarProps> = {}): SidebarProps => ({
  workspaces: [lead],
  projects: [project],
  activeWsId: "lead",
  connected: true,
  groupOverrides: {},
  searchQuery: "",
  searchHits: null,
  systemStatus: null,
  now: NOW,
  onSelect: vi.fn(),
  onDelete: vi.fn(),
  onToggleGroup: vi.fn(),
  onSearchChange: vi.fn(),
  onJump: vi.fn(),
  onCreate: vi.fn(),
  onCreateIn: vi.fn(),
  onReplayDemo: vi.fn(),
  onDebugSnapshot: vi.fn(),
  onPurgeArchived: vi.fn(),
  ...over,
});

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  resetLocaleForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Sidebar awaitsUserPrompt tooltip", () => {
  it("shows awaitsUserPrompt in the your-turn badge tooltip in en and zh-CN", () => {
    const prompt = "Should we keep backward-compatible v1 flags?";
    const waiting = ws("w1", {
      name: "worker-one",
      projectLink: { projectId: "p1", role: "worker" },
      awaitsUser: true,
      awaitsUserPrompt: prompt,
    });
    const noPrompt = ws("w2", {
      name: "worker-two",
      projectLink: { projectId: "p1", role: "worker" },
      awaitsUser: true,
    });

    const { container } = render(
      <Sidebar {...sidebarProps({ workspaces: [lead, waiting, noPrompt] })} />,
    );

    const row = (name: string) =>
      [...container.querySelectorAll(".task-item")].find((el) => el.textContent?.includes(name))!;

    const badge1 = row("worker-one").querySelector(".session-attention.attention-yourTurn")!;
    expect(badge1.textContent).toBe("Your turn");
    expect(badge1.getAttribute("title")).toBe(`Your turn: ${prompt}`);

    const badge2 = row("worker-two").querySelector(".session-attention.attention-yourTurn")!;
    expect(badge2.textContent).toBe("Your turn");
    expect(badge2.getAttribute("title")).toBeNull();

    act(() => setLocaleOverride("zh-CN"));
    expect(badge1.textContent).toBe("轮到你");
    expect(badge1.getAttribute("title")).toBe(`轮到你：${prompt}`);
  });
});

describe("AgentsPanel waiting question preview", () => {
  it("renders the waiting prompt preview under header/brief in en and zh-CN and opens the session on click", () => {
    const prompt = "Should we drop the legacy v1 fallback before merging?";
    const waiting = ws("w1", {
      name: "worker-one",
      projectLink: { projectId: "p1", role: "worker" },
      awaitsUser: true,
      awaitsUserPrompt: prompt,
    });
    const actions = makeActions();
    const { container } = render(
      <AgentsPanel
        sessions={[lead, waiting]}
        project={project}
        activeWsId="lead"
        connected
        models={[]}
        actions={actions}
        overview
      />,
    );

    const card = container.querySelector('[aria-label="worker-one"]')!;
    const tag = card.querySelector(".awaits-tag")!;
    expect(tag.textContent).toBe("your turn");
    expect(tag.getAttribute("title")).toBe(`Your turn: ${prompt}`);

    const preview = card.querySelector<HTMLButtonElement>(".ap-awaits-prompt")!;
    expect(preview).not.toBeNull();
    expect(preview.textContent).toBe(prompt);
    expect(preview.getAttribute("title")).toBe(prompt);
    // In folded overview mode, the preview sits after .ap-brief.
    expect(preview.previousElementSibling?.className).toBe("ap-brief");

    fireEvent.click(preview);
    expect(actions.onOpen).toHaveBeenCalledWith("w1");

    act(() => setLocaleOverride("zh-CN"));
    expect(tag.textContent).toBe("待回复");
    expect(tag.getAttribute("title")).toBe(`轮到你：${prompt}`);
  });

  it("hides the preview when awaitsUserPrompt is absent or whitespace, or session is not idle awaitsUser", () => {
    const absent = ws("absent", {
      projectLink: { projectId: "p1", role: "worker" },
      awaitsUser: true,
    });
    const blank = ws("blank", {
      projectLink: { projectId: "p1", role: "worker" },
      awaitsUser: true,
      awaitsUserPrompt: "   ",
    });
    const notAwaiting = ws("not-awaiting", {
      projectLink: { projectId: "p1", role: "worker" },
      awaitsUser: false,
      awaitsUserPrompt: "stale prompt",
    });
    const working = ws("working", {
      projectLink: { projectId: "p1", role: "worker" },
      awaitsUser: true,
      awaitsUserPrompt: "question while working",
      agents: [agent("a", { busy: true, state: "working" })],
    });
    const archived = ws("archived", {
      projectLink: { projectId: "p1", role: "worker" },
      awaitsUser: true,
      awaitsUserPrompt: "archived question",
      archivedAt: NOW - 10,
    });

    const { container } = render(
      <AgentsPanel
        sessions={[absent, blank, notAwaiting, working, archived]}
        project={project}
        activeWsId="absent"
        connected
        models={[]}
        actions={makeActions()}
      />,
    );

    expect(container.querySelectorAll(".ap-awaits-prompt")).toHaveLength(0);
    expect(
      container.querySelector('[aria-label="absent"] .awaits-tag')!.getAttribute("title"),
    ).toBe("Waiting for your reply");
  });
});

describe("AgentsPanel hand back to lead action", () => {
  it("renders Hand back to lead only for idle, live, reporting managed workers with userTookOver", () => {
    const eligible = ws("eligible", {
      projectLink: { projectId: "p1", role: "worker" },
      userTookOver: true,
    });
    const noTakeover = ws("no-takeover", {
      projectLink: { projectId: "p1", role: "worker" },
      userTookOver: false,
    });
    const unreported = ws("unreported", {
      projectLink: { projectId: "p1", role: "worker", unreported: true },
      userTookOver: true,
    });
    const leadTakeover = ws("lead", {
      name: "clice · lead",
      projectLink: { projectId: "p1", role: "lead" },
      userTookOver: true,
    });
    const standalone = ws("standalone", {
      userTookOver: true,
    });
    const busyWorker = ws("busy-worker", {
      projectLink: { projectId: "p1", role: "worker" },
      userTookOver: true,
      agents: [agent("a", { busy: true, state: "working" })],
    });
    const waitingWorker = ws("waiting-worker", {
      projectLink: { projectId: "p1", role: "worker" },
      userTookOver: true,
      agents: [agent("a", { state: "waiting" })],
    });
    const archivedWorker = ws("archived-worker", {
      projectLink: { projectId: "p1", role: "worker" },
      userTookOver: true,
      archivedAt: NOW - 10,
    });

    const actions = makeActions();
    const { container, rerender } = render(
      <AgentsPanel
        sessions={[
          leadTakeover,
          eligible,
          noTakeover,
          unreported,
          standalone,
          busyWorker,
          waitingWorker,
          archivedWorker,
        ]}
        project={project}
        activeWsId="eligible"
        connected
        models={[]}
        actions={actions}
      />,
    );

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".ap-hand-back")];
    expect(buttons).toHaveLength(1);
    const eligibleCard = container.querySelector('[aria-label="eligible"]')!;
    const btn = eligibleCard.querySelector<HTMLButtonElement>(".ap-hand-back")!;
    expect(btn.textContent).toBe("Hand back to lead");
    expect(btn.getAttribute("title")).toBe(
      "Return control of this worker session to the project lead",
    );

    fireEvent.click(btn);
    expect(actions.onHandBackToLead).toHaveBeenCalledTimes(1);
    expect(actions.onHandBackToLead).toHaveBeenCalledWith("eligible");

    // In zh-CN and folded overview mode, the button stays accessible and does not unfold on click.
    act(() => setLocaleOverride("zh-CN"));
    rerender(
      <AgentsPanel
        sessions={[eligible]}
        project={project}
        activeWsId="lead"
        connected
        models={[]}
        actions={actions}
        overview
      />,
    );
    const foldedCard = container.querySelector('[aria-label="eligible"]')!;
    expect(foldedCard.className).not.toContain("open");
    const zhBtn = within(foldedCard as HTMLElement).getByRole("button", { name: "交回 Lead" });
    expect(zhBtn.getAttribute("title")).toBe("将此工作会话的控制权交回项目 Lead");
    fireEvent.click(zhBtn);
    expect(actions.onHandBackToLead).toHaveBeenCalledTimes(2);
    expect(foldedCard.className).not.toContain("open");

    // Sealed projects hide the mutating hand-back action.
    rerender(
      <AgentsPanel
        sessions={[eligible]}
        project={{ ...project, status: "sealed" }}
        activeWsId="eligible"
        connected
        models={[]}
        actions={actions}
      />,
    );
    expect(container.querySelector(".ap-hand-back")).toBeNull();
  });
});

describe("useServer handoff state and handBackToLead", () => {
  it("preserves and clears awaitsUserPrompt and userTookOver across workspace_updated and sends hand_back_to_lead", () => {
    const { result } = renderHook(() => useServer());
    const sock = FakeSocket.instances.at(-1)!;
    act(() => sock.open());

    const worker = ws("w1", {
      name: "worker-one",
      projectLink: { projectId: "p1", role: "worker" },
      awaitsUser: true,
      awaitsUserPrompt: "Proceed with migration?",
      userTookOver: true,
    });

    act(() => {
      sock.receive({
        type: "init",
        workspaces: [lead, worker],
        projects: [project],
        config: { presets: [], models: [], commands: [], hosts: {} },
        hosts: [],
      });
    });

    const getW1 = () => result.current.workspaces.find((w) => w.id === "w1")!;
    expect(getW1().awaitsUserPrompt).toBe("Proceed with migration?");
    expect(getW1().userTookOver).toBe(true);

    act(() => {
      result.current.handBackToLead("w1");
    });
    expect(sock.frames()).toContainEqual({ type: "hand_back_to_lead", workspaceId: "w1" });

    // Server clears fields by omitting them on workspace_updated.
    const cleared: Workspace = {
      ...worker,
      awaitsUser: false,
    };
    delete cleared.awaitsUserPrompt;
    delete cleared.userTookOver;
    act(() => {
      sock.receive({ type: "workspace_updated", workspace: cleared });
    });

    expect(getW1().awaitsUser).toBe(false);
    expect(getW1().awaitsUserPrompt).toBeUndefined();
    expect(getW1().userTookOver).toBeUndefined();
  });

  it("wires AgentsPanel hand-back click in App to send hand_back_to_lead", () => {
    localStorage.setItem("activeWsId", "lead");
    render(<App />);
    const sock = FakeSocket.instances.at(-1)!;
    act(() => sock.open());

    const worker = ws("w1", {
      name: "modules",
      projectLink: { projectId: "p1", role: "worker" },
      awaitsUser: true,
      awaitsUserPrompt: "Confirm API name?",
      userTookOver: true,
    });

    act(() => {
      sock.receive({
        type: "init",
        workspaces: [lead, worker],
        projects: [project],
        config: { presets: [], models: [], commands: [], hosts: {} },
        hosts: [],
      });
    });

    fireEvent.click(document.querySelector(".agents-chip")!);
    const preview = document.querySelector<HTMLButtonElement>(".ap-awaits-prompt")!;
    expect(preview.textContent).toBe("Confirm API name?");

    const handBackBtn = document.querySelector<HTMLButtonElement>(".ap-hand-back")!;
    fireEvent.click(handBackBtn);
    expect(sock.frames()).toContainEqual({ type: "hand_back_to_lead", workspaceId: "w1" });
  });
});
