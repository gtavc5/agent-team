import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { COMMANDS } from "../src/chat/commands";
import { FileOpenContext } from "../src/chat/fileRef";
import { HistoryHint } from "../src/chat/HistoryHint";
import { IssueRefContext, MdBlock } from "../src/chat/markdown";
import {
  BannerItem,
  chipLabelFor,
  EventItem,
  MessageBoundary,
  MessageItem,
  originLabel,
  PanelActionItem,
  SessionLinkContext,
  StepGroup,
  SubAgentItem,
} from "../src/chat/messages";
import { StopControl } from "../src/composer/StopControl";
import { formatDuration, formatRelative, formatRunTime, formatUptime } from "../src/format";
import { resetLocaleForTests, setLocaleOverride, setServerLanguage } from "../src/i18n";
import { chatCatalog, t } from "../src/i18n/chat";
import type { AgentInfo, Message, StreamEvent } from "../src/state/useServer";
import { FakeSocket } from "./fakeSocket";

class ReactSocket extends FakeSocket {
  override receive(frame: unknown) {
    act(() => super.receive(frame));
  }
  override drop() {
    act(() => super.drop());
  }
}

const ALICE: AgentInfo = {
  id: "a1",
  name: "Alice",
  model: "claude-opus-5-5",
  avatar: "🤖",
  color: "#888",
  isDefault: true,
};

const BOB: AgentInfo = {
  id: "a2",
  name: "Bob",
  model: "gpt-5.6",
  avatar: "🧠",
  color: "#4a9",
  isDefault: false,
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  resetLocaleForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("chat i18n catalog", () => {
  it("provides non-empty en and zh-CN entries for every key and interpolates params", () => {
    for (const [key, entry] of Object.entries(chatCatalog)) {
      expect(entry.en.trim().length, `${key}.en`).toBeGreaterThan(0);
      expect(entry["zh-CN"].trim().length, `${key}.zh-CN`).toBeGreaterThan(0);
    }
    expect(t("snapshotSaved", { path: "/tmp/s.json" }, "en")).toBe("Snapshot saved: /tmp/s.json");
    expect(t("snapshotSaved", { path: "/tmp/s.json" }, "zh-CN")).toBe("快照已保存：/tmp/s.json");
  });
});

describe("format.ts localization", () => {
  const NOW = 1_800_000_000_000;

  it("returns exact English in en locale and natural Chinese in zh-CN locale", () => {
    expect(formatRelative(NOW - 10_000, NOW)).toBe("just now");
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatRelative(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatRelative(NOW - 16 * 86_400_000, NOW)).toBe("16d ago");
    expect(formatRelative(NOW - 70 * 86_400_000, NOW)).toBe("2mo ago");
    expect(formatRelative(NOW - 400 * 86_400_000, NOW)).toBe("1y ago");

    expect(formatUptime(300)).toBe("5m");
    expect(formatUptime(7_500)).toBe("2h 5m");
    expect(formatUptime(93_600)).toBe("1d 2h");

    expect(formatDuration(4_200)).toBe("4.2s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(65_400)).toBe("1m 5s");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
    expect(formatRunTime(450)).toBe("450ms");
    expect(formatRunTime(4_200)).toBe("4.2s");

    setServerLanguage("简体中文");

    expect(formatRelative(NOW - 10_000, NOW)).toBe("刚刚");
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe("5分钟前");
    expect(formatRelative(NOW - 3 * 3_600_000, NOW)).toBe("3小时前");
    expect(formatRelative(NOW - 16 * 86_400_000, NOW)).toBe("16天前");
    expect(formatRelative(NOW - 70 * 86_400_000, NOW)).toBe("2个月前");
    expect(formatRelative(NOW - 400 * 86_400_000, NOW)).toBe("1年前");

    expect(formatUptime(300)).toBe("5分钟");
    expect(formatUptime(7_500)).toBe("2小时5分钟");
    expect(formatUptime(93_600)).toBe("1天2小时");

    expect(formatDuration(4_200)).toBe("4.2秒");
    expect(formatDuration(45_000)).toBe("45秒");
    expect(formatDuration(65_400)).toBe("1分5秒");
    expect(formatDuration(3_900_000)).toBe("1小时5分");
    expect(formatDuration(59_960)).toBe("1分0秒");
    expect(formatRunTime(450)).toBe("450毫秒");
    expect(formatRunTime(4_200)).toBe("4.2秒");
  });
});

describe("HistoryHint localization", () => {
  it("renders Chinese states and switches reactively back to English", () => {
    setServerLanguage("zh-CN");
    const { container, rerender } = render(
      <HistoryHint hasMore={false} loading={false} loaded={false} count={0} />,
    );
    expect(container.textContent).toContain("正在加载会话…");

    rerender(<HistoryHint hasMore={true} loading={true} loaded={true} count={5} />);
    expect(container.textContent).toContain("正在加载较早的消息…");

    rerender(<HistoryHint hasMore={true} loading={false} loaded={true} count={5} />);
    expect(container.textContent).toBe("向上滚动加载更多消息");

    rerender(<HistoryHint hasMore={false} loading={false} loaded={true} count={5} />);
    expect(container.textContent).toBe("已是会话开头");

    act(() => {
      setLocaleOverride("en");
    });
    expect(container.textContent).toBe("Beginning of conversation");
  });
});

describe("StopControl localization", () => {
  it("localizes single-agent and multi-agent stop controls", () => {
    setServerLanguage("zh-CN");
    const onStop = vi.fn();
    const { rerender } = render(<StopControl busyAgents={[ALICE]} onStop={onStop} />);
    const single = screen.getByRole("button", { name: "停止 Alice" });
    expect(single.getAttribute("title")).toBe("停止 Alice 的当前轮次");
    expect(single.getAttribute("aria-description")).toBe(
      "中断当前轮次。如果无法中断，代理进程可能会停止。",
    );

    rerender(<StopControl busyAgents={[ALICE, BOB]} onStop={onStop} />);
    const trigger = screen.getByRole("button", { name: "停止运行中的代理 (2)" });
    expect(trigger.title).toBe("选择要停止的当前轮次");
    fireEvent.click(trigger);
    const group = within(screen.getByRole("group", { name: "停止运行中的轮次" }));
    expect(group.getByRole("button", { name: "停止 Alice" })).toBeTruthy();
    expect(group.getByRole("button", { name: "停止 Bob" })).toBeTruthy();
    expect(group.getByRole("button", { name: "全部停止 (2)" })).toBeTruthy();

    act(() => {
      setLocaleOverride("en");
    });
    expect(screen.getByRole("button", { name: "Stop running agents (2)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop all (2)" })).toBeTruthy();
  });
});

describe("commands.ts localization", () => {
  it("keeps slash command names untranslated and dynamically localizes descriptions and placeholders", () => {
    const pr = COMMANDS.find((c) => c.name === "pr")!;
    const format = COMMANDS.find((c) => c.name === "format")!;
    expect(pr.description).toBe("Format, commit, push, and open a PR");
    expect(pr.placeholder).toBe("optional PR title or target repo");
    expect(format.description).toBe("Run code formatter");

    setServerLanguage("简体中文");
    expect(pr.name).toBe("pr");
    expect(pr.description).toBe("格式化、提交、推送并创建 PR");
    expect(pr.placeholder).toBe("可选的 PR 标题或目标仓库");
    expect(format.description).toBe("运行代码格式化工具");
  });
});

describe("markdown.tsx localization", () => {
  it("localizes copy button, issue link tooltip, and untitled details summary", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    setServerLanguage("zh-CN");

    const { container } = render(
      <IssueRefContext.Provider value={{ pattern: /#\d+/g, open: vi.fn() }}>
        <MdBlock>
          {"See #42\n\n```sh\necho hi\n```\n\n<details open>\n\nbody\n\n</details>"}
        </MdBlock>
      </IssueRefContext.Provider>,
    );

    const issueBtn = container.querySelector(".issue-ref")!;
    expect(issueBtn.getAttribute("title")).toBe("问题 #42");

    const summary = container.querySelector("details > summary")!;
    expect(summary.textContent).toBe("详情");

    const copyBtn = container.querySelector(".copy-btn")!;
    expect(copyBtn.textContent).toBe("复制");
    await act(async () => {
      fireEvent.click(copyBtn);
      await Promise.resolve();
    });
    expect(copyBtn.textContent).toBe("已复制");

    act(() => {
      setLocaleOverride("en");
    });
    expect(container.querySelector(".issue-ref")!.getAttribute("title")).toBe("Issue #42");
    expect(container.querySelector("details > summary")!.textContent).toBe("Details");
    expect(container.querySelector(".copy-btn")!.textContent).toBe("Copied");
  });
});

describe("messages.tsx localization", () => {
  it("localizes originLabel and ScheduleWakeup chip while preserving technical tool names", () => {
    expect(originLabel({ role: "lead", workspaceId: "w1", name: "proj" })).toBe("Lead");
    expect(originLabel({ role: "panel", workspaceId: "w1", name: "board" })).toBe("Panel · board");
    expect(originLabel({ role: "peer", workspaceId: "w1", name: "core" })).toBe("core · lead");
    expect(chipLabelFor("ScheduleWakeup")).toBe("⏰ Wake-up");
    expect(chipLabelFor("Bash")).toBe("Bash");
    expect(chipLabelFor("mcp__github__get_issue")).toBe("github · get_issue");

    setServerLanguage("zh-CN");
    expect(originLabel({ role: "lead", workspaceId: "w1", name: "proj" })).toBe("主代理");
    expect(originLabel({ role: "panel", workspaceId: "w1", name: "board" })).toBe("面板 · board");
    expect(originLabel({ role: "peer", workspaceId: "w1", name: "core" })).toBe("core · 主代理");
    expect(chipLabelFor("ScheduleWakeup")).toBe("⏰ 定时唤醒");
    expect(chipLabelFor("Bash")).toBe("Bash");
    expect(chipLabelFor("mcp__github__get_issue")).toBe("github · get_issue");
  });

  it("localizes BannerItem, PanelActionItem, EventItem, SubAgentItem, StepGroup, and MessageItem", () => {
    setServerLanguage("zh-CN");

    const longBody = "Line 1\nLine 2";
    const { container: bannerBox } = render(
      <BannerItem ev={{ kind: "notice", level: "wakeup", content: longBody }} />,
    );
    expect(bannerBox.querySelector(".banner-label")!.textContent).toBe("已唤醒");
    const toggle = within(bannerBox).getByRole("button", { name: "更多" });
    fireEvent.click(toggle);
    expect(within(bannerBox).getByRole("button", { name: "收起" })).toBeTruthy();

    const { container: actionBox } = render(
      <SessionLinkContext.Provider value={{ open: vi.fn(), nameOf: () => "worker-1" }}>
        <PanelActionItem
          action="start_session"
          ev={{
            kind: "tool_use",
            toolName: "mcp__panel__start_session",
            content: "**start_session** `ws-1`\n> do task",
            toolResult: "Started ws-1",
          }}
        />
      </SessionLinkContext.Provider>,
    );
    expect(actionBox.querySelector(".banner-label")!.textContent).toBe("新会话");
    expect(actionBox.querySelector(".action-target")!.getAttribute("title")).toBe("打开该会话");

    const thinkingEv: StreamEvent = {
      kind: "thinking",
      content: "hmm",
      durationMs: 13_700,
      tokens: 1234,
    };
    const { container: evBox } = render(
      <FileOpenContext.Provider value={vi.fn()}>
        <EventItem ev={thinkingEv} />
        <EventItem
          ev={{
            kind: "tool_use",
            toolName: "ViewImage",
            content: "**ViewImage** `img.png`",
            durationMs: 420,
          }}
        />
        <EventItem ev={{ kind: "tool_result", content: "12345678" }} />
        <EventItem
          ev={{ kind: "thinking", content: "", contentLength: 2048 }}
          onLoadDetails={vi.fn()}
        />
      </FileOpenContext.Provider>,
    );
    expect(evBox.querySelector(".chip-thinking")!.textContent).toBe("思考了 13.7秒 · 1.2k tokens");
    expect(evBox.querySelector(".event-time")!.getAttribute("title")).toBe(
      "从调用到返回结果的耗时",
    );
    expect(evBox.querySelector(".event-time")!.textContent).toBe("420毫秒");
    expect(evBox.querySelector("code.file-ref")!.getAttribute("title")).toBe("在文件中打开图片");
    expect(within(evBox).getByRole("button", { name: "显示 · 8 字符" })).toBeTruthy();
    expect(evBox.querySelector(".event-placeholder")!.textContent).toBe("2.0k 字符 · 点击加载");

    const { container: subBox } = render(
      <SubAgentItem
        ev={{
          kind: "subagent_start",
          content: "",
          subagent: {
            taskId: "t1",
            description: "",
            status: "running",
            effort: "high",
            durationMs: 2500,
            prompt: "Investigate",
            usage: { totalTokens: 4000, toolUses: 3, durationMs: 2500 },
          },
        }}
        onCancel={vi.fn()}
      />,
    );
    const subToggle = within(subBox).getByRole("button", { name: "展开子代理：子代理" });
    expect(subBox.querySelector(".subagent-status-icon")!.getAttribute("title")).toBe("运行中");
    expect(subBox.querySelector(".subagent-effort")!.getAttribute("title")).toBe("推理强度：high");
    expect(subBox.querySelector(".subagent-time")!.getAttribute("title")).toBe("运行时长");
    expect(within(subBox).getByRole("button", { name: "取消" }).getAttribute("title")).toBe(
      "取消此子代理",
    );
    fireEvent.click(subToggle);
    expect(within(subBox).getByRole("button", { name: "收起子代理：子代理" })).toBeTruthy();
    expect(subBox.querySelector(".subagent-usage")!.textContent).toBe("4k tokens · 3 次工具调用");
    expect(within(subBox).getByRole("button", { name: "收起子代理轨迹" }).textContent).toContain(
      "收起",
    );

    const { container: stepBox } = render(
      <StepGroup
        group={{
          step: 1,
          events: [
            { kind: "thinking", content: "plan" },
            { kind: "tool_use", toolName: "Read", content: "**Read** `a.ts`" },
          ],
        }}
      />,
    );
    expect(stepBox.querySelector(".step-summary")!.textContent).toBe("1 次思考 · 1 次工具调用");
    fireEvent.click(within(stepBox).getByRole("button", { name: "展开步骤" }));
    expect(within(stepBox).getByRole("button", { name: "收起步骤" })).toBeTruthy();
    expect(within(stepBox).getByRole("button", { name: "收起步骤轨迹" })).toBeTruthy();

    const agentMsg: Message = {
      id: "m1",
      kind: "agent",
      agentId: "a1",
      content: "Done",
      timestamp: 0,
      status: "done",
      effort: "high",
      fast: true,
      context: { tokens: 84_000, window: 200_000 },
    };
    const userQueued: Message = {
      id: "m2",
      kind: "user",
      agentId: null,
      content: "next",
      timestamp: 0,
      status: "queued",
      steering: false,
      forwardRef: { messageId: "m1", fromAgent: "Alice", fromAvatar: "🤖", preview: "Done" },
    };
    const unknownMsg: Message = {
      id: "m3",
      kind: "user",
      agentId: null,
      content: "maybe",
      timestamp: 0,
      status: "outcome_unknown",
    };

    const { container: msgBox } = render(
      <>
        <MessageItem msg={agentMsg} agents={[ALICE]} onQuote={vi.fn()} />
        <MessageItem
          msg={userQueued}
          agents={[ALICE]}
          onCancelQueued={vi.fn()}
          onJumpToMessage={vi.fn()}
        />
        <MessageItem msg={unknownMsg} agents={[ALICE]} />
      </>,
    );
    expect(msgBox.textContent).toContain("推理 high");
    expect(msgBox.textContent).toContain("⚡ 快速");
    expect(msgBox.textContent).toContain("上下文 84k / 200k · 42%");
    expect(msgBox.querySelector(".btn-quote")!.getAttribute("title")).toBe("引用此消息");
    expect(msgBox.querySelector(".queued-badge")!.textContent).toContain("排队中");
    expect(msgBox.querySelector(".queued-cancel")!.getAttribute("title")).toBe("从队列中移除");
    expect(msgBox.querySelector(".forward-ref")!.getAttribute("aria-label")).toBe(
      "跳转到来自 Alice 的引用消息：Done",
    );
    expect(msgBox.querySelector(".delivery-outcome-unknown")!.textContent).toContain(
      "消息投递结果未知。",
    );
  });

  it("localizes MessageBoundary fallback text", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setServerLanguage("zh-CN");
    function Boom(): never {
      throw new Error("boom");
    }
    const { container } = render(
      <MessageBoundary messageId="bad">
        <Boom />
      </MessageBoundary>,
    );
    expect(container.textContent).toBe("无法渲染此消息。");

    act(() => {
      setLocaleOverride("en");
    });
    expect(container.textContent).toBe("This message could not be rendered.");
  });
});

describe("App shell localization", () => {
  it("renders Chinese shell strings from server config.user.language and falls back cleanly to English", () => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", ReactSocket);

    const { container } = render(<App />);
    const sock = FakeSocket.instances.at(-1)!;
    act(() => sock.open());
    sock.receive({
      type: "init",
      workspaces: [
        {
          id: "w1",
          name: "alpha",
          project: "proj",
          hostId: "local",
          cwd: "/repo/proj",
          agents: [ALICE, { ...BOB, busy: true }],
          messages: [],
          createdAt: 1,
          archivedAt: Date.now() - 3 * 86_400_000,
          projectLink: { projectId: "p1", role: "worker", reports: true },
        },
        {
          id: "w2",
          name: "beta",
          project: "proj",
          hostId: "local",
          cwd: "/repo/proj",
          agents: [ALICE],
          messages: [],
          createdAt: 1,
        },
      ],
      projects: [
        {
          id: "p1",
          name: "YAAT",
          root: "/repo/proj",
          createdAt: 1,
          status: "sealed",
          sealedReason: "done",
          objectives: [],
        },
      ],
      config: {
        user: { name: "User", avatar: "👤", language: "简体中文" },
        archiveAfterDays: 7,
        presets: [],
        models: [],
        commands: [],
        hosts: {},
      },
      hosts: [],
    });
    sock.receive({ type: "workspace_messages", workspaceId: "w1", messages: [], hasMore: false });
    sock.receive({
      type: "ui_dialog_request",
      dialog: {
        workspaceId: "w2",
        agentId: "a1",
        processGeneration: 1,
        requestId: "r1",
        method: "confirm",
        title: "Confirm",
        message: "Proceed?",
        createdAt: 1,
      },
    });

    expect(container.querySelector(".ui-dialog-alert")!.textContent).toContain(
      "还有 1 个会话等待你的回复",
    );
    expect(screen.getByRole("button", { name: "打开会话" })).toBeTruthy();
    expect(container.querySelector(".sealed-badge")!.textContent).toBe("已封存 · 只读");
    expect(container.querySelector(".sealed-banner")!.textContent).toBe(
      "此项目已封存。历史记录、目标、问题和笔记均为只读。 原因：done",
    );
    expect(container.querySelector(".archived-banner")!.textContent).toContain(
      "已归档（3天前 · 已空闲超过 7 天）。发送消息即可恢复。",
    );
    expect(container.querySelector(".empty-state")!.textContent).toBe("发送消息以开始工作。");
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe(
      "项目已封存 · 只读",
    );
    expect(screen.getByRole("button", { name: "附加图片" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
    expect(container.querySelector(".agents-chip")!.getAttribute("title")).toBe("代理与会话");

    // Switch back to English via override and verify reactive update
    act(() => {
      setLocaleOverride("en");
    });
    expect(container.querySelector(".ui-dialog-alert")!.textContent).toContain(
      "1 other session waiting for your response",
    );
    expect(screen.getByRole("button", { name: "Open session" })).toBeTruthy();
    expect(container.querySelector(".sealed-badge")!.textContent).toBe("Sealed · read-only");
    expect(container.querySelector(".archived-banner")!.textContent).toContain(
      "Archived 3d ago · idle for over 7 days. Sending a message restores it.",
    );
    expect(container.querySelector(".empty-state")!.textContent).toBe(
      "Send a message to start working.",
    );
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe(
      "Project sealed · read-only",
    );
  });
});
