import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { App } from "../src/App";
import { MessageItem, StepGroup } from "../src/chat/messages";
import { BoardPage } from "../src/project/BoardPage";
import { reachable } from "../src/project/NotesView";
import { applyEventsToMessage } from "../src/state/stream";
import {
  useServer,
  type AgentInfo,
  type CommandInfo,
  type Message,
  type ModelOption,
  type Project,
  type UiDialogMethod,
  type UiDialogRequest,
  type Workspace,
} from "../src/state/useServer";
import { CreateProjectDialog } from "../src/workspace/dialogs";
import { UiDialogModal } from "../src/workspace/UiDialogModal";
import { QuotaPanel } from "../src/sidebar/Sidebar";
import { FakeSocket } from "./fakeSocket";

const NOW = 1_800_000_000_000;
const agent: AgentInfo = {
  id: "a1",
  name: "Alice",
  model: "pi/model-one",
  avatar: "A",
  color: "#fff",
  isDefault: true,
  effortLevels: ["low", "high"],
};
const workspace = (id: string, agents: AgentInfo[] = [agent]): Workspace => ({
  id,
  name: id,
  project: "repo",
  hostId: "local",
  cwd: `/${id}`,
  agents,
  messages: [],
  createdAt: NOW,
});
const command = (name: string, source: CommandInfo["source"] = "pi"): CommandInfo => ({
  name,
  description: `${name} description`,
  argumentHint: "",
  source,
});
const dialog = (method: UiDialogMethod, over: Partial<UiDialogRequest> = {}): UiDialogRequest => ({
  requestId: "request-1",
  workspaceId: "w1",
  agentId: "a1",
  processGeneration: 3,
  method,
  title: `${method} title`,
  message: `${method} message`,
  timeoutMs: 60_000,
  createdAt: NOW,
  expiresAt: Date.now() + 60_000,
  ...over,
});

function receive(sock: FakeSocket, frame: unknown) {
  act(() => sock.receive(frame));
}

function initFrame(
  workspaces: Workspace[] = [workspace("w1")],
  over: Record<string, unknown> = {},
) {
  return {
    type: "init",
    workspaces,
    config: { presets: [], models: [], commands: [], hosts: {} },
    hosts: [],
    ...over,
  };
}

it("hydrates sidebar quota on init and reconnect, refreshes without a turn and labels stale bars", () => {
  const app = render(<App />);
  const sock = FakeSocket.instances.at(-1)!;
  act(() => sock.open());
  const row = {
    provider: "antigravity-acp",
    name: "Gemini",
    availability: "available",
    observedAt: Date.now() - 120000,
    windows: [{ label: "weekly", usedPct: 34, resetsAt: Date.now() + 3600000 }],
  };
  const quota = {
    refreshing: false,
    rows: [
      row,
      {
        provider: "native-codex",
        name: "",
        availability: "unavailable",
        observedAt: 0,
        windows: [],
      },
    ],
  };
  receive(sock, initFrame([], { quota }));
  expect(app.getByRole("progressbar", { name: "weekly" }).getAttribute("aria-valuenow")).toBe("34");
  expect(app.getByText(/stale · 2m ago/)).toBeTruthy();
  expect(app.getByText(/Resets /)).toBeTruthy();
  expect(app.getByText("unavailable")).toBeTruthy();
  fireEvent.click(app.getByRole("button", { name: "Refresh" }));
  expect(sock.frames()).toContainEqual({ type: "refresh_quota" });
  receive(sock, { type: "quota_snapshot", quota: { ...quota, refreshing: true } });
  expect((app.getByRole("button", { name: "Refreshing…" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  receive(sock, initFrame([], { quota: { refreshing: false, rows: [] } }));
  expect(app.queryByRole("progressbar", { name: "weekly" })).toBeNull();
});

it("ages quota without websocket traffic", () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    const view = render(
      <QuotaPanel
        now={now}
        connected={false}
        quota={{
          refreshing: false,
          rows: [
            {
              provider: "acp",
              name: "g",
              availability: "available",
              observedAt: now,
              windows: [{ label: "5h", usedPct: 20 }],
            },
          ],
        }}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(60_001);
    });
    expect(view.getByText(/stale · 1m ago/)).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
let localStore: Map<string, string>;
beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  localStore = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => localStore.get(key) ?? null,
    setItem: (key: string, value: string) => void localStore.set(key, String(value)),
    removeItem: (key: string) => void localStore.delete(key),
    clear: () => localStore.clear(),
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("per-agent commands and dynamic models", () => {
  it("isolates workspaces and agents, applies increments, and cleans removed owners", () => {
    const { result } = renderHook(() => useServer());
    const sock = FakeSocket.instances.at(-1)!;
    act(() => sock.open());
    receive(
      sock,
      initFrame([workspace("w1"), workspace("w2")], {
        commands: [command("global", "panel")],
        commandsByAgent: {
          w1: { a1: [command("one")], a2: [command("two", "extension")] },
          w2: { a1: [command("other", "skill")] },
        },
      }),
    );
    const select = (workspaceId: string, agentId: string) =>
      act(() => result.current.selectCommandAgent(workspaceId, agentId));

    expect(result.current.commands.map((c) => c.name)).toEqual(["global"]);
    select("w1", "a1");
    expect(result.current.commands.map((c) => c.name)).toEqual(["one"]);
    select("w1", "a2");
    expect(result.current.commands.map((c) => c.name)).toEqual(["two"]);
    select("w2", "a1");
    expect(result.current.commands.map((c) => c.name)).toEqual(["other"]);

    receive(sock, {
      type: "agent_commands_update",
      workspaceId: "w1",
      agentId: "a1",
      commands: [command("updated", "prompt")],
    });
    select("w1", "a1");
    expect(result.current.commands).toMatchObject([{ name: "updated", source: "prompt" }]);
    receive(sock, { type: "agent_removed", workspaceId: "w1", agentId: "a1" });
    expect(result.current.commands.map((c) => c.name)).toEqual(["global"]);
    expect(result.current.commandsByAgent.w1.a1).toBeUndefined();
    expect(result.current.commandsByAgent.w1.a2).toHaveLength(1);

    select("w2", "a1");
    receive(sock, { type: "workspace_deleted", workspaceId: "w2" });
    expect(result.current.commandsByAgent.w2).toBeUndefined();
    expect(result.current.commands.map((c) => c.name)).toEqual(["global"]);

    const models: ModelOption[] = [
      { id: "pi/new-model", label: "New model", backend: "pi", effortLevels: ["minimal"] },
    ];
    receive(sock, { type: "models_update", models });
    expect(result.current.models).toEqual(models);
  });

  it("uses the selected agent's commands in the slash menu and labels their source", () => {
    render(<App />);
    const sock = FakeSocket.instances.at(-1)!;
    act(() => sock.open());
    receive(
      sock,
      initFrame([workspace("w1")], {
        commandsByAgent: {
          w1: { a1: [command("duplicate", "extension"), command("duplicate", "skill")] },
        },
      }),
    );
    const input = document.querySelector<HTMLTextAreaElement>(".chat-input")!;
    fireEvent.change(input, { target: { value: "/", selectionStart: 1 } });
    expect([...document.querySelectorAll(".command-source")].map((el) => el.textContent)).toEqual([
      "extension",
      "skill",
    ]);
    expect(document.querySelectorAll(".command-item")).toHaveLength(2);
  });
});

describe("extension UI", () => {
  const owner = { workspaceId: "w1", agentId: "a1", processGeneration: 7 };
  const snapshot = {
    ...owner,
    statuses: [{ key: "k", text: "ready" }],
    widgets: [{ key: "w", placement: "belowEditor", lines: ["<img src=x>", "**not markdown**"] }],
  };
  it("hydrates and updates plain text on the requested side of the composer", () => {
    const view = render(<App />);
    const sock = FakeSocket.instances.at(-1)!;
    act(() => sock.open());
    receive(sock, initFrame(undefined, { extensionUi: [snapshot] }));
    const above = () => view.container.querySelector('[data-placement="aboveEditor"]');
    const below = () => view.container.querySelector('[data-placement="belowEditor"]');
    const row = view.container.querySelector(".input-row");
    expect(above()?.nextElementSibling).toBe(row);
    expect(below()?.previousElementSibling).toBe(row);
    expect(above()?.textContent).toContain("ready");
    expect(below()?.textContent).toContain("<img src=x>\n**not markdown**");
    expect(below()?.querySelector("img")).toBeNull();
    const send = (change: object) =>
      receive(sock, { type: "extension_ui", event: { ...owner, change } });
    send({ kind: "widget", key: "w", placement: "aboveEditor", lines: ["moved"] });
    expect(above()?.textContent).toContain("moved");
    expect(below()).toBeNull();
    send({ kind: "status", key: "k", text: "updated" });
    expect(above()?.textContent).not.toContain("ready");
    expect(above()?.textContent).toContain("updated");
    send({ kind: "widget", key: "w", placement: "aboveEditor" });
    send({ kind: "status", key: "k" });
    expect(above()).toBeNull();
    send({ kind: "notify", id: "n", level: "error", message: "transient" });
    expect(above()?.querySelector(".extension-notice.error")?.textContent).toContain("transient");
    fireEvent.click(view.getByRole("button", { name: "Dismiss notification" }));
    expect(view.queryByText("transient")).toBeNull();
    send({ kind: "notify", id: "n2", level: "warning", message: "not replayed" });
    receive(sock, initFrame(undefined, { extensionUi: [snapshot] }));
    expect(view.queryByText("not replayed")).toBeNull();
    expect(below()).not.toBeNull();
  });
  it("keeps another owner's error visible through a burst of notices until its own expiry", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useServer());
      const sock = FakeSocket.instances.at(-1)!;
      act(() => sock.open());
      receive(sock, initFrame([workspace("w1"), workspace("w2")]));
      const notice = (workspaceId: string, id: string) =>
        receive(sock, {
          type: "extension_ui",
          event: {
            ...owner,
            workspaceId,
            change: { kind: "notify", id, level: "error", message: id },
          },
        });
      notice("w1", "first");
      act(() => {
        vi.advanceTimersByTime(100);
      });
      for (let i = 0; i < 10; i++) notice("w2", String(i));
      expect(result.current.extensionUi.notices.map((n) => n.id)).toEqual([
        "first",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
      ]);
      act(() => {
        vi.advanceTimersByTime(7900);
      });
      expect(result.current.extensionUi.notices).toHaveLength(8);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(result.current.extensionUi.notices).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("isolates snapshots and live state across workspace, agent and retired generations", () => {
    const { result } = renderHook(() => useServer());
    const sock = FakeSocket.instances.at(-1)!;
    act(() => sock.open());
    const other = { ...snapshot, workspaceId: "w2" };
    receive(sock, initFrame(undefined, { extensionUi: [snapshot, other] }));
    const send = (gen: number, change: object) =>
      receive(sock, { type: "extension_ui", event: { ...owner, processGeneration: gen, change } });
    send(7, { kind: "notify", id: "n", message: "expiring", level: "info" });
    send(8, { kind: "reset" });
    send(7, { kind: "status", key: "late", text: "gone" });
    expect(result.current.extensionUi.notices).toEqual([]);
    expect(result.current.extensionUi.agents).toContainEqual({
      ...owner,
      processGeneration: 8,
      statuses: [],
      widgets: [],
    });
    receive(sock, {
      type: "workspace_messages",
      workspaceId: "w1",
      messages: [],
      hasMore: false,
      extensionUi: [],
    });
    expect(result.current.extensionUi.agents).toEqual([other]);
    receive(sock, { type: "agent_removed", workspaceId: "w2", agentId: "a1" });
    expect(result.current.extensionUi.agents).toEqual([]);
  });
});

describe("blocking UI dialog protocol", () => {
  it("deduplicates identities, resolves exactly one generation, and replaces workspace snapshots", () => {
    const { result } = renderHook(() => useServer());
    const sock = FakeSocket.instances.at(-1)!;
    act(() => sock.open());
    const first = dialog("select");
    const otherWorkspace = dialog("confirm", { workspaceId: "w2", requestId: "other" });
    receive(sock, initFrame([workspace("w1"), workspace("w2")], { pendingDialogs: [first] }));
    receive(sock, { type: "ui_dialog_request", dialog: first });
    expect(result.current.pendingDialogs).toHaveLength(1);

    const nextGeneration = dialog("select", { processGeneration: 4 });
    receive(sock, { type: "ui_dialog_request", dialog: nextGeneration });
    receive(sock, { type: "ui_dialog_request", dialog: otherWorkspace });
    expect(result.current.pendingDialogs).toHaveLength(3);
    receive(sock, { type: "ui_dialog_resolved", dialog: first });
    expect(result.current.pendingDialogs.map((d) => d.processGeneration)).toEqual([4, 3]);

    const replacement = dialog("editor", { requestId: "replacement" });
    receive(sock, {
      type: "workspace_messages",
      workspaceId: "w1",
      messages: [],
      hasMore: false,
      pendingDialogs: [replacement],
    });
    expect(result.current.pendingDialogs).toEqual([otherWorkspace, replacement]);

    act(() => {
      result.current.respondUiDialog(replacement, { value: "answer", cancelled: false });
    });
    expect(sock.frames()).toContainEqual({
      type: "ui_dialog_response",
      workspaceId: "w1",
      agentId: "a1",
      processGeneration: 3,
      requestId: "replacement",
      value: "answer",
      cancelled: false,
    });
    receive(sock, { type: "ui_dialog_resolved", dialog: replacement });
    expect(result.current.pendingDialogs).toEqual([otherWorkspace]);
    receive(sock, { type: "agent_removed", workspaceId: "w2", agentId: "a1" });
    expect(result.current.pendingDialogs).toEqual([]);
  });

  it("offers non-current dialogs in the top bar and responds from the mounted modal", () => {
    render(<App />);
    const sock = FakeSocket.instances.at(-1)!;
    act(() => sock.open());
    receive(sock, initFrame([workspace("w1"), workspace("w2")]));
    receive(sock, {
      type: "ui_dialog_request",
      dialog: dialog("select", {
        workspaceId: "w2",
        title: "Permission needed",
        options: ["Allow", "Deny"],
      }),
    });
    expect(document.querySelector(".ui-dialog-alert")!.textContent).toContain(
      "1 other session waiting",
    );
    fireEvent.click(document.querySelector<HTMLButtonElement>(".ui-dialog-alert button")!);
    expect(document.querySelector<HTMLElement>(".ui-dialog")!.textContent).toContain(
      "Permission needed",
    );
    fireEvent.click(document.querySelector<HTMLButtonElement>(".ui-dialog-option")!);
    expect(sock.frames()).toContainEqual(
      expect.objectContaining({
        type: "ui_dialog_response",
        workspaceId: "w2",
        requestId: "request-1",
        value: "Allow",
      }),
    );
    receive(sock, {
      type: "ui_dialog_resolved",
      workspaceId: "w2",
      agentId: "a1",
      processGeneration: 3,
      requestId: "request-1",
    });
    expect(document.querySelector(".ui-dialog")).toBeNull();
  });

  it("renders select and confirm, submits their answers, and allows cancellation", () => {
    const onSelect = vi.fn(() => true);
    const select = render(
      <UiDialogModal dialog={dialog("select", { options: ["One", "Two"] })} onRespond={onSelect} />,
    );
    fireEvent.click(select.getByRole("button", { name: "Two" }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ method: "select" }), {
      value: "Two",
    });
    expect((select.getByRole("button", { name: "One" }) as HTMLButtonElement).disabled).toBe(true);
    expect(select.getByLabelText("Time remaining").textContent).toMatch(/remaining/);
    select.unmount();

    const onConfirm = vi.fn(() => true);
    const confirm = render(<UiDialogModal dialog={dialog("confirm")} onRespond={onConfirm} />);
    fireEvent.click(confirm.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenLastCalledWith(expect.anything(), { confirmed: true });
    confirm.unmount();

    const onCancel = vi.fn(() => true);
    const cancelled = render(<UiDialogModal dialog={dialog("confirm")} onRespond={onCancel} />);
    fireEvent.click(cancelled.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledWith(expect.anything(), { cancelled: true });
  });

  it("renders input and editor with prefill and submits their current values", () => {
    const onInput = vi.fn(() => true);
    const input = render(
      <UiDialogModal
        dialog={dialog("input", { placeholder: "name", prefill: "before" })}
        onRespond={onInput}
      />,
    );
    fireEvent.change(input.getByLabelText("Response"), { target: { value: "typed" } });
    fireEvent.click(input.getByRole("button", { name: "Submit" }));
    expect(onInput).toHaveBeenCalledWith(expect.anything(), { value: "typed" });
    input.unmount();

    const onEditor = vi.fn(() => true);
    const editor = render(
      <UiDialogModal dialog={dialog("editor", { prefill: "first line" })} onRespond={onEditor} />,
    );
    const textarea = editor.getByLabelText("Response") as HTMLTextAreaElement;
    expect(textarea.value).toBe("first line");
    fireEvent.change(textarea, { target: { value: "first line\nsecond line" } });
    fireEvent.click(editor.getByRole("button", { name: "Submit" }));
    expect(onEditor).toHaveBeenCalledWith(expect.anything(), {
      value: "first line\nsecond line",
    });
  });
});

describe("Project v2", () => {
  it("creates rooted or repository-less projects and sends seal requests", () => {
    const onCreate = vi.fn();
    const view = render(<CreateProjectDialog onClose={() => {}} onCreate={onCreate} />);
    fireEvent.change(view.getByLabelText("Name"), { target: { value: " Research " } });
    fireEvent.click(view.getByLabelText("Create without a Git repository"));
    expect((view.getByLabelText("Repository path") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith("Research", null);
    view.unmount();

    const { result } = renderHook(() => useServer());
    const sock = FakeSocket.instances.at(-1)!;
    act(() => sock.open());
    act(() => {
      result.current.createProject("Code", "/repo/code");
      result.current.sealProject("p1", "finished");
    });
    expect(sock.frames()).toEqual([
      { type: "create_project", name: "Code", root: "/repo/code" },
      { type: "seal_project", projectId: "p1", reason: "finished" },
    ]);
  });

  it("renders root:null sealed projects read-only without assuming a repository", () => {
    const project: Project = {
      id: "p1",
      name: "Research",
      root: null,
      leadWorkspaceId: "w1",
      lead: { hostId: "local", workspaceId: "w1" },
      createdAt: NOW,
      schemaVersion: 2,
      status: "sealed",
      sealedAt: NOW,
      sealedReason: "complete",
      objectives: [],
    };
    const view = render(
      <BoardPage
        project={project}
        sessions={new Map()}
        onClose={() => {}}
        onOpenSession={() => {}}
        onAskLead={() => {}}
        onRename={() => {}}
        onArchive={() => {}}
        onSeal={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(view.getByText("Sealed · read-only")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Delete project" })).toBeNull();
    expect(view.queryByRole("button", { name: "Seal project" })).toBeNull();
    expect(view.queryByTitle("Rename")).toBeNull();
    expect(view.getByRole("button", { name: "Notes" })).toBeTruthy();
    expect(reachable("notes/design.md", null)).toBe(true);
    expect(reachable("/repo/design.md", null)).toBe(false);
  });

  it("keeps a sealed project's chat history visible while disabling its composer", () => {
    const project: Project = {
      id: "p1",
      name: "Research",
      root: null,
      leadWorkspaceId: "w1",
      createdAt: NOW,
      status: "sealed",
      objectives: [],
    };
    const lead = {
      ...workspace("w1"),
      projectLink: { projectId: "p1", role: "lead" as const },
    };
    localStorage.setItem("activeWsId", "w1");
    render(<App />);
    const sock = FakeSocket.instances.at(-1)!;
    act(() => sock.open());
    receive(sock, initFrame([lead], { projects: [project] }));
    expect(document.querySelector(".sealed-banner")!.textContent).toContain("read-only");
    expect(document.querySelector<HTMLTextAreaElement>(".chat-input")!.disabled).toBe(true);
    expect(document.querySelector(".task-delete")).toBeNull();
  });
});

describe("stream and message rendering", () => {
  it("keeps the maximum event count when subagent_done folds onto its start", () => {
    const message = (startCount: number): Message => ({
      id: "m1",
      kind: "agent",
      agentId: "a1",
      content: "",
      timestamp: NOW,
      status: "streaming",
      events: [
        {
          kind: "subagent_start",
          content: "",
          subagent: { taskId: "task", description: "work", eventCount: startCount },
        },
      ],
    });
    for (const [startCount, doneCount, expected] of [
      [12, 4, 12],
      [3, 19, 19],
    ]) {
      const out = applyEventsToMessage(message(startCount), [
        {
          kind: "subagent_done",
          content: "",
          subagent: {
            taskId: "task",
            description: "",
            status: "completed",
            eventCount: doneCount,
          },
        },
      ]);
      expect(out.events![0].subagent!.eventCount).toBe(expected);
    }
  });

  it("shows dispatching and outcome_unknown as distinct delivery states", () => {
    const base: Message = {
      id: "m1",
      kind: "user",
      agentId: null,
      content: "do the work",
      timestamp: NOW,
      status: "dispatching",
    };
    const sending = render(<MessageItem msg={base} agents={[agent]} />);
    expect(sending.getByRole("status").textContent).toContain("Sending to the agent");
    expect(sending.container.querySelector(".message-dispatching")).not.toBeNull();
    sending.unmount();

    const unknown = render(
      <MessageItem msg={{ ...base, status: "outcome_unknown" }} agents={[agent]} />,
    );
    expect(unknown.getByRole("alert").textContent).toMatch(/may still process this message/i);
    expect(unknown.getByRole("alert").textContent).toMatch(/will not resend it automatically/i);
    expect(unknown.container.querySelector(".message-outcome-unknown")).not.toBeNull();
  });

  it("keeps Notes tools as ordinary folded chip-panel steps", () => {
    const events = (["list_notes", "read_note", "write_note"] as const).map((toolName) => ({
      kind: "tool_use",
      toolName: `mcp__panel__${toolName}`,
      content: `**${toolName}**`,
    }));
    const view = render(<StepGroup group={{ step: 0, events }} />);
    expect(view.container.querySelectorAll(".step-tools .chip-panel")).toHaveLength(3);
    expect(view.container.querySelector(".banner-action")).toBeNull();
    fireEvent.click(view.container.querySelector(".step-header")!);
    expect(view.container.querySelectorAll(".events-list .chip-panel")).toHaveLength(3);
    expect(view.container.querySelector(".step-group")).not.toBeNull();
  });
});
