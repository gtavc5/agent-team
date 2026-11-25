import { isChineseLanguage } from "../i18n";
import type { CommandInfo } from "../session/types";

// Commands handled by this server (Workspace.tryHandleCommand) rather than
// forwarded to the agent. Merged into the SDK command list for autocomplete.
const LOCAL_COMMANDS_EN: CommandInfo[] = [
  {
    name: "effort",
    description: "Show or set the model reasoning effort level",
    argumentHint: "[low|medium|high|xhigh|max|ultra]",
  },
  {
    name: "model",
    description: "Show or switch the agent's model; the conversation carries over",
    argumentHint: "[model id]",
  },
  {
    name: "fast",
    description: "Toggle fast mode (quicker responses, higher usage)",
    argumentHint: "[on|off]",
  },
  { name: "context", description: "Show context window usage", argumentHint: "" },
  { name: "usage", description: "Show session token usage and cost", argumentHint: "" },
];

const LOCAL_COMMANDS_ZH: CommandInfo[] = [
  {
    name: "effort",
    description: "查看或设置模型推理强度",
    argumentHint: "[low|medium|high|xhigh|max|ultra]",
  },
  {
    name: "model",
    description: "查看或切换当前 Agent 的模型（保留对话上下文）",
    argumentHint: "[模型 ID]",
  },
  {
    name: "fast",
    description: "切换快速模式（响应更快，消耗更高）",
    argumentHint: "[on|off]",
  },
  { name: "context", description: "查看上下文窗口占用情况", argumentHint: "" },
  { name: "usage", description: "查看当前会话的 Token 用量与费用", argumentHint: "" },
];

export function mergeLocalCommands(commands: CommandInfo[], language?: string): CommandInfo[] {
  const active = commands.filter((c) => c.name !== "goal");
  const local = isChineseLanguage(language) ? LOCAL_COMMANDS_ZH : LOCAL_COMMANDS_EN;
  return [...local.map((command): CommandInfo => ({ ...command, source: "panel" })), ...active];
}
