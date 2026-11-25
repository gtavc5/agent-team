import { EventEmitter } from "node:events";
import type * as http from "node:http";
import { describe, expect, it } from "vitest";
import { isChineseLanguage, pickText } from "../../src/i18n";
import { Auth } from "../../src/server/auth";
import { mergeLocalCommands } from "../../src/server/commands";
import { HostRegistry } from "../../src/session/host";
import type { SessionConfig } from "../../src/session/types";
import { Workspace, type Message } from "../../src/workspace/workspace";
import { FakeHost, FakeSession } from "./fakes";

class RichFakeSession extends FakeSession {
  usageData: Record<string, unknown> | null = {
    session: {
      total_cost_usd: 0.1234,
      total_duration_ms: 12000,
      total_lines_added: 10,
      total_lines_removed: 3,
    },
    subscription_type: "pro",
  };
  contextData: Record<string, unknown> | null = {
    model: "gpt-6.2-sol",
    totalTokens: 12000,
    maxTokens: 100000,
    percentage: 12,
    categories: [{ name: "System", tokens: 4000 }],
    apiUsage: {
      input_tokens: 10000,
      output_tokens: 2000,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 1000,
    },
  };
  setEffort(level: string): void {
    this.getState().config.effort = level;
  }
  getAvailableThinkingLevels(): string[] {
    return ["low", "medium", "high"];
  }
  getUsageInfo(): Promise<Record<string, unknown> | null> {
    return Promise.resolve(this.usageData);
  }
  getContextUsage(): Promise<Record<string, unknown> | null> {
    return Promise.resolve(this.contextData);
  }
}

class RichFakeHost extends FakeHost {
  richSession: RichFakeSession | null = null;
  override createSession(_agentId: string, config: SessionConfig): RichFakeSession {
    this.richSession = new RichFakeSession(config);
    this.lastSession = this.richSession;
    return this.richSession;
  }
}

function makeWorkspace(language?: () => string | undefined) {
  const host = new RichFakeHost();
  const registry = new HostRegistry();
  registry.register(host);
  const messages: Message[] = [];
  const ws = new Workspace("ws-i18n", "i18n", "proj", "local", "/tmp", registry, {
    onNewMessage: (_wsId, msg) => messages.push(msg),
    onStreamEvent: () => {},
    onMessageDone: () => {},
    userLanguage: language,
    modelOptions: () => [
      {
        id: "gpt-6.2-sol",
        label: "GPT-6.2-Sol",
        backend: "codex",
        effortLevels: ["low", "medium", "high"],
        fast: true,
      },
      {
        id: "gpt-6.1-sol",
        label: "GPT-6.1-Sol",
        backend: "codex",
        effortLevels: ["low", "medium", "high"],
      },
    ],
  });
  ws.addAgent("Allen", "gpt-6.2-sol", "A", "#fff", { effort: "high" });
  return { ws, host, messages };
}

function lastReply(messages: Message[]): string {
  const reply = [...messages].reverse().find((m) => m.kind === "agent");
  return reply?.content ?? "";
}

describe("service i18n helpers and commands", () => {
  it("detects Chinese language strings accurately", () => {
    expect(isChineseLanguage(undefined)).toBe(false);
    expect(isChineseLanguage("")).toBe(false);
    expect(isChineseLanguage("English")).toBe(false);
    expect(isChineseLanguage("en-US")).toBe(false);
    expect(isChineseLanguage("简体中文")).toBe(true);
    expect(isChineseLanguage("中文")).toBe(true);
    expect(isChineseLanguage("zh-CN")).toBe(true);
    expect(isChineseLanguage("zh")).toBe(true);
    expect(isChineseLanguage("Chinese")).toBe(true);
    expect(pickText("简体中文", "Hello", "你好")).toBe("你好");
    expect(pickText("en", "Hello", "你好")).toBe("Hello");
  });

  it("returns exact English local commands by default and zh-CN when configured", () => {
    const extra = [
      { name: "goal", description: "ignored", argumentHint: "" },
      { name: "custom", description: "Custom command", argumentHint: "" },
    ];
    const en = mergeLocalCommands(extra);
    expect(en.find((c) => c.name === "goal")).toBeUndefined();
    expect(en.find((c) => c.name === "custom")).toEqual(extra[1]);
    expect(en.find((c) => c.name === "effort")).toMatchObject({
      description: "Show or set the model reasoning effort level",
      source: "panel",
    });
    expect(en.find((c) => c.name === "model")).toMatchObject({
      description: "Show or switch the agent's model; the conversation carries over",
      argumentHint: "[model id]",
      source: "panel",
    });

    const zh = mergeLocalCommands(extra, "简体中文");
    expect(zh.find((c) => c.name === "goal")).toBeUndefined();
    expect(zh.find((c) => c.name === "custom")).toEqual(extra[1]);
    expect(zh.find((c) => c.name === "effort")).toMatchObject({
      description: "查看或设置模型推理强度",
      source: "panel",
    });
    expect(zh.find((c) => c.name === "model")).toMatchObject({
      description: "查看或切换当前 Agent 的模型（保留对话上下文）",
      argumentHint: "[模型 ID]",
      source: "panel",
    });
    expect(zh.find((c) => c.name === "usage")?.description).toBe("查看当前会话的 Token 用量与费用");
  });

  it("localizes Workspace slash command replies when userLanguage is Chinese and preserves English default", async () => {
    const state: { lang?: string } = {};
    const { ws, host, messages } = makeWorkspace(() => state.lang);

    // English default
    await ws.sendMessage("/model");
    expect(lastReply(messages)).toContain("**Allen** runs on **GPT-6.2-Sol**");
    await ws.sendMessage("/effort");
    expect(lastReply(messages)).toContain("Use `/effort <level>` to change it.");
    await ws.sendMessage("/effort medium");
    expect(lastReply(messages)).toBe(
      "Effort for **Allen** set to **medium** (was high). Applies from the next message.",
    );
    await ws.sendMessage("/goal");
    expect(lastReply(messages)).toBe("/goal is disabled.");
    await ws.sendMessage("/usage");
    expect(lastReply(messages)).toContain("## Session Usage");
    await ws.sendMessage("/context");
    expect(lastReply(messages)).toContain("## Context Usage");
    expect(lastReply(messages)).toContain("**Occupancy:** Empty");

    // Switch dynamically to Simplified Chinese
    state.lang = "简体中文";
    await ws.sendMessage("/model");
    expect(lastReply(messages)).toContain("**Allen** 当前使用 **GPT-6.2-Sol**");
    expect(lastReply(messages)).toContain("可用模型：");
    await ws.sendMessage("/model gpt-6.1-sol");
    expect(lastReply(messages)).toContain("**Allen** 已从 GPT-6.2-Sol 切换到 **GPT-6.1-Sol**");
    expect(lastReply(messages)).toContain("从下一条消息开始生效。");
    await ws.sendMessage("/effort");
    expect(lastReply(messages)).toContain("当前推理强度：medium");
    expect(lastReply(messages)).toContain("可用档位：");
    await ws.sendMessage("/effort high");
    expect(lastReply(messages)).toBe(
      "**Allen** 的推理强度已设为 **high**（原为 medium）。从下一条消息开始生效。",
    );
    await ws.sendMessage("/effort nope");
    expect(lastReply(messages)).toContain("不支持推理强度 `nope`");
    await ws.sendMessage("/fast on");
    expect(lastReply(messages)).toBe(
      "**Allen** 的快速模式已 **开启**。响应更快，消耗更高。从下一条消息开始生效。",
    );
    await ws.sendMessage("/fast on");
    expect(lastReply(messages)).toBe("**Allen** 的快速模式已是 **开启** 状态。");
    await ws.sendMessage("/fast maybe");
    expect(lastReply(messages)).toContain("用法：`/fast [on|off]`");
    await ws.sendMessage("/fast off");
    expect(lastReply(messages)).toBe("**Allen** 的快速模式已 **关闭**。从下一条消息开始生效。");
    await ws.sendMessage("/goal");
    expect(lastReply(messages)).toBe("/goal 已停用。");
    await ws.sendMessage("/usage");
    expect(lastReply(messages)).toContain("## 会话用量");
    expect(lastReply(messages)).toContain("**会话费用：** $0.1234");
    await ws.sendMessage("/context");
    expect(lastReply(messages)).toContain("## 上下文占用");
    // Cumulative API usage does not create a context observation in a fresh workspace.
    expect(lastReply(messages)).toContain("**占用：** 空");
    expect(lastReply(messages)).not.toContain("### API 用量（本会话）");

    host.richSession!.usageData = null;
    await ws.sendMessage("/usage");
    expect(lastReply(messages)).toBe("当前没有活跃会话——请先发送一条消息以启动会话。");
  });

  it("renders login page in English by default and Simplified Chinese when configured", () => {
    const state: { lang?: string } = {};
    const auth = new Auth(
      () => ({
        username: "agent",
        password: "secret",
        session_secret: "0".repeat(64),
        max_age_days: 7,
      }),
      () => state.lang,
    );

    const request = (method: string): http.IncomingMessage =>
      Object.assign(new EventEmitter(), { method, headers: {} }) as unknown as http.IncomingMessage;

    const runGet = () => {
      let body = "";
      const res = {
        setHeader: () => {},
        end: (chunk?: string) => {
          body += chunk ?? "";
        },
      } as unknown as http.ServerResponse;
      auth.handleLogin(request("GET"), res);
      return body;
    };

    expect(runGet()).toContain("<title>Login — Agent Team</title>");
    state.lang = "简体中文";
    const zhHtml = runGet();
    expect(zhHtml).toContain('<html lang="zh-CN">');
    expect(zhHtml).toContain("<title>登录 — Agent Team</title>");
    expect(zhHtml).toContain("<label>用户名</label>");
  });
});
