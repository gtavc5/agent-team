import { createTranslator, type MessageCatalog } from "./core";

export const panelMessages = {
  // Rail
  panelsNavLabel: {
    en: "Panels",
    "zh-CN": "面板",
  },

  // SidePanel
  panelResizeTitle: {
    en: "Drag to resize · double-click for the automatic width",
    "zh-CN": "拖动调整宽度 · 双击恢复自动宽度",
  },
  panelRestoreTitle: {
    en: "Back beside the chat",
    "zh-CN": "还原到聊天侧边",
  },
  panelMaximizeTitle: {
    en: "Maximise over the chat",
    "zh-CN": "在聊天区域最大化",
  },
  panelPinTitle: {
    en: "Pin beside the chat",
    "zh-CN": "固定在聊天侧边",
  },
  panelPinTooNarrowTitle: {
    en: "Too narrow to pin beside the chat",
    "zh-CN": "窗口过窄，无法固定在聊天侧边",
  },
  panelCloseLabel: {
    en: "Close {title}",
    "zh-CN": "关闭 {title}",
  },

  // Scope & states
  stateWorking: {
    en: "working",
    "zh-CN": "工作中",
  },
  stateWaiting: {
    en: "waiting",
    "zh-CN": "等待中",
  },
  stateWaitingFull: {
    en: "waiting on background work",
    "zh-CN": "等待后台任务",
  },
  stateSleeping: {
    en: "sleeping",
    "zh-CN": "休眠中",
  },
  stateIdle: {
    en: "idle",
    "zh-CN": "空闲",
  },
  stateArchived: {
    en: "archived",
    "zh-CN": "已归档",
  },
  stateOnline: {
    en: "online",
    "zh-CN": "在线",
  },
  stateOffline: {
    en: "offline",
    "zh-CN": "离线",
  },
  stateCountWorking: {
    en: "{count} working",
    "zh-CN": "{count} 工作中",
  },
  stateCountWaiting: {
    en: "{count} waiting",
    "zh-CN": "{count} 等待中",
  },
  stateCountSleeping: {
    en: "{count} sleeping",
    "zh-CN": "{count} 休眠中",
  },
  scopeWorkspaceArchived: {
    en: "{name} · archived",
    "zh-CN": "{name} · 已归档",
  },
  scopeAgentCountOne: {
    en: "{count} agent",
    "zh-CN": "{count} 个代理",
  },
  scopeAgentCountMany: {
    en: "{count} agents",
    "zh-CN": "{count} 个代理",
  },
  scopeSessionCountOne: {
    en: "{count} session",
    "zh-CN": "{count} 个会话",
  },
  scopeSessionCountMany: {
    en: "{count} sessions",
    "zh-CN": "{count} 个会话",
  },

  // AgentsPanel
  archivedCount: {
    en: "Archived · {count}",
    "zh-CN": "已归档 · {count}",
  },
  stop: {
    en: "Stop",
    "zh-CN": "停止",
  },
  foldSessionLabel: {
    en: "Fold {name}",
    "zh-CN": "折叠 {name}",
  },
  unfoldSessionLabel: {
    en: "Unfold {name}",
    "zh-CN": "展开 {name}",
  },
  openThisSessionTitle: {
    en: "Open this session",
    "zh-CN": "打开此会话",
  },
  waitingForReplyTitle: {
    en: "Waiting for your reply",
    "zh-CN": "等待你的回复",
  },
  yourTurnTag: {
    en: "your turn",
    "zh-CN": "待回复",
  },
  gitDirtyCount: {
    en: "{count} changed",
    "zh-CN": "{count} 处更改",
  },
  noAgents: {
    en: "No agents.",
    "zh-CN": "暂无代理。",
  },
  sealedReadOnly: {
    en: "Sealed · read-only",
    "zh-CN": "已封存 · 只读",
  },
  addAgent: {
    en: "+ Agent",
    "zh-CN": "+ 代理",
  },
  stopEverythingTitle: {
    en: "Stop the turn, every background task and the wake-ups of this session",
    "zh-CN": "停止当前轮次、所有后台任务及此会话的定时唤醒",
  },
  stopEverything: {
    en: "Stop everything",
    "zh-CN": "全部停止",
  },
  restore: {
    en: "Restore",
    "zh-CN": "恢复",
  },
  archive: {
    en: "Archive",
    "zh-CN": "归档",
  },
  inBackgroundCount: {
    en: "{count} in background",
    "zh-CN": "{count} 个后台任务",
  },
  wakeIn: {
    en: "wake in {time}",
    "zh-CN": "{time}后唤醒",
  },
  agentModelLabel: {
    en: "{name}'s model",
    "zh-CN": "{name} 的模型",
  },
  switchModelTitle: {
    en: "Switch model; the conversation carries over",
    "zh-CN": "切换模型；对话上下文会保留",
  },
  codexNotSignedIn: {
    en: "Codex (not signed in)",
    "zh-CN": "Codex（未登录）",
  },
  agentReasoningEffortLabel: {
    en: "{name}'s reasoning effort",
    "zh-CN": "{name} 的推理强度",
  },
  clearContext: {
    en: "Clear context",
    "zh-CN": "清空上下文",
  },
  clearAgentContextLabel: {
    en: "Clear {name}'s context",
    "zh-CN": "清空 {name} 的上下文",
  },
  remove: {
    en: "Remove",
    "zh-CN": "移除",
  },
  removeAgentLabel: {
    en: "Remove {name}",
    "zh-CN": "移除 {name}",
  },
  contextUnknown: { en: "ctx unknown", "zh-CN": "上下文占用未知" },
  contextEstimateTitle: {
    en: "Estimate: {used} of {total} tokens",
    "zh-CN": "估算：已使用 {used} / {total} tokens",
  },
  contextTokensTitle: {
    en: "{used} of {total} tokens",
    "zh-CN": "已使用 {used} / {total} tokens",
  },
  clearAgentContextTitle: {
    en: "Clear {name}'s context?",
    "zh-CN": "清空 {name} 的上下文？",
  },
  removeAgentTitle: {
    en: "Remove {name}?",
    "zh-CN": "移除 {name}？",
  },
  clearAgentContextBody: {
    en: "The agent will start with a fresh context.",
    "zh-CN": "该代理将使用全新的上下文继续对话。",
  },
  removeAgentBody: {
    en: "This agent will be removed from the session.",
    "zh-CN": "该代理将从此会话中移除。",
  },
  removeAgent: {
    en: "Remove agent",
    "zh-CN": "移除代理",
  },

  // SessionTasks
  taskTypeShell: {
    en: "shell",
    "zh-CN": "终端",
  },
  taskTypeAgent: {
    en: "agent",
    "zh-CN": "代理",
  },
  taskTypeMonitor: {
    en: "monitor",
    "zh-CN": "监控",
  },
  taskQueued: { en: "Queued", "zh-CN": "已排队" },
  taskStopLabel: {
    en: "Stop {target}",
    "zh-CN": "停止 {target}",
  },
  taskTypeWakeUp: {
    en: "wake-up",
    "zh-CN": "唤醒",
  },
  taskScheduledWakeUp: {
    en: "scheduled wake-up",
    "zh-CN": "定时唤醒",
  },
  taskWakeIn: {
    en: "in {time}",
    "zh-CN": "{time}后",
  },
  taskWakeDue: {
    en: "due",
    "zh-CN": "已到期",
  },
  taskCancelWakeTitle: {
    en: "A wake-up lives in the session's CLI process: cancelling closes it, and the session resumes on the next message",
    "zh-CN": "定时唤醒保存在会话的 CLI 进程中：取消后会关闭该进程，下次发送消息时会恢复会话",
  },
  cancel: {
    en: "Cancel",
    "zh-CN": "取消",
  },
  durationSeconds: {
    en: "{secs}s",
    "zh-CN": "{secs}秒",
  },
  durationMinutes: {
    en: "{mins}m",
    "zh-CN": "{mins}分钟",
  },
  durationHoursMinutes: {
    en: "{hours}h {mins}m",
    "zh-CN": "{hours}小时{mins}分钟",
  },

  // ChangesView
  binary: {
    en: "binary",
    "zh-CN": "二进制",
  },
  changeStatusAdded: {
    en: "added",
    "zh-CN": "已新增",
  },
  changeStatusModified: {
    en: "modified",
    "zh-CN": "已修改",
  },
  changeStatusDeleted: {
    en: "deleted",
    "zh-CN": "已删除",
  },
  changeStatusRenamed: {
    en: "renamed",
    "zh-CN": "已重命名",
  },
  changeStatusUntracked: {
    en: "untracked",
    "zh-CN": "未跟踪",
  },
  changesAgainstPrefix: {
    en: "against ",
    "zh-CN": "对比 ",
  },
  changesNotCommitted: {
    en: "not committed",
    "zh-CN": "未提交",
  },
  fileCountOne: {
    en: "{count} file",
    "zh-CN": "{count} 个文件",
  },
  fileCountMany: {
    en: "{count} files",
    "zh-CN": "{count} 个文件",
  },
  noChanges: {
    en: "No changes",
    "zh-CN": "无更改",
  },
  changesTruncated: {
    en: "Only the first files are listed.",
    "zh-CN": "仅列出前一部分文件。",
  },
  binaryFileChanged: {
    en: "Binary file changed",
    "zh-CN": "二进制文件已更改",
  },
  noTextChanges: {
    en: "No changes in its text",
    "zh-CN": "文本内容无更改",
  },
  diffTruncated: {
    en: "Only the first part of the diff is shown.",
    "zh-CN": "仅显示差异的前一部分。",
  },

  // FilesPanel
  emptyFolder: {
    en: "Empty folder",
    "zh-CN": "空文件夹",
  },
  dirTruncated: {
    en: "Only the first entries are listed.",
    "zh-CN": "仅列出前一部分条目。",
  },
  askLinesTitle: {
    en: "Ask about these lines in the chat",
    "zh-CN": "在聊天中询问这些代码行",
  },
  askLinesSingle: {
    en: "Ask · L{from}",
    "zh-CN": "询问 · L{from}",
  },
  askLinesRange: {
    en: "Ask · L{from}–{to}",
    "zh-CN": "询问 · L{from}–{to}",
  },
  allChangesTitle: {
    en: "All changes",
    "zh-CN": "全部更改",
  },
  filesTitle: {
    en: "Files",
    "zh-CN": "文件",
  },
  changesTitle: {
    en: "Changes",
    "zh-CN": "更改",
  },
  openFileTitle: {
    en: "Open the file",
    "zh-CN": "打开文件",
  },
  open: {
    en: "Open",
    "zh-CN": "打开",
  },
  backToFilesTitle: {
    en: "Back to the files",
    "zh-CN": "返回文件列表",
  },
  loading: {
    en: "Loading…",
    "zh-CN": "加载中…",
  },
  parentFolderTitle: {
    en: "Parent folder",
    "zh-CN": "上级文件夹",
  },
  folderSelectLabel: {
    en: "Folder",
    "zh-CN": "文件夹",
  },
  folderElsewhere: {
    en: "Elsewhere",
    "zh-CN": "其他位置",
  },
  markdownPreview: {
    en: "Preview",
    "zh-CN": "预览",
  },
  markdownSource: {
    en: "Source",
    "zh-CN": "源码",
  },
  copyPathTitle: {
    en: "Copy path",
    "zh-CN": "复制路径",
  },
  copied: {
    en: "Copied",
    "zh-CN": "已复制",
  },
  copy: {
    en: "Copy",
    "zh-CN": "复制",
  },
  rawFile: {
    en: "Raw",
    "zh-CN": "原始文件",
  },
  changesAgainstBaseTitle: {
    en: "Changes against the base branch",
    "zh-CN": "查看相对基准分支的更改",
  },
  fileTruncated: {
    en: "Showing the first {shown} of {total}.",
    "zh-CN": "仅显示前 {shown}（共 {total}）。",
  },
  binaryFilePrefix: {
    en: "Binary file · {size} · ",
    "zh-CN": "二进制文件 · {size} · ",
  },
  openRawLink: {
    en: "open raw",
    "zh-CN": "查看原始文件",
  },
} as const satisfies MessageCatalog;

export type PanelMessageKey = keyof typeof panelMessages;

export const { t: tPanel, useT: usePanelT } = createTranslator(panelMessages);
