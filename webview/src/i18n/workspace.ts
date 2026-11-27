import { createTranslator, type MessageCatalog } from "./core";

export const workspaceMessages = {
  // Common actions & buttons
  cancel: {
    en: "Cancel",
    "zh-CN": "取消",
  },
  confirm: {
    en: "Confirm",
    "zh-CN": "确认",
  },
  close: {
    en: "Close",
    "zh-CN": "关闭",
  },
  submit: {
    en: "Submit",
    "zh-CN": "提交",
  },
  add: {
    en: "Add",
    "zh-CN": "添加",
  },
  copy: {
    en: "Copy",
    "zh-CN": "复制",
  },
  copied: {
    en: "Copied",
    "zh-CN": "已复制",
  },
  copyFailed: {
    en: "Copy failed",
    "zh-CN": "复制失败",
  },
  clear: {
    en: "Clear",
    "zh-CN": "清空",
  },
  archive: {
    en: "Archive",
    "zh-CN": "归档",
  },
  restore: {
    en: "Restore",
    "zh-CN": "恢复",
  },
  refresh: {
    en: "Refresh",
    "zh-CN": "刷新",
  },
  refreshing: {
    en: "Refreshing…",
    "zh-CN": "刷新中…",
  },

  // Sidebar & workspace groups
  workspaces: {
    en: "Workspaces",
    "zh-CN": "工作区",
  },
  offline: {
    en: "offline",
    "zh-CN": "离线",
  },
  darkTheme: { en: "Dark theme", "zh-CN": "深色主题" },
  openUsage: { en: "Usage", "zh-CN": "用量统计" },
  newSession: {
    en: "New session",
    "zh-CN": "新建会话",
  },
  newProject: {
    en: "New project",
    "zh-CN": "新建项目",
  },
  replayDemoTitle: {
    en: "Replay demo",
    "zh-CN": "回放演示",
  },
  saveDebugSnapshotTitle: {
    en: "Capture debug snapshot",
    "zh-CN": "捕获调试快照",
  },
  searchMessagesPlaceholder: {
    en: "Search messages…",
    "zh-CN": "搜索消息…",
  },
  searching: {
    en: "Searching…",
    "zh-CN": "搜索中…",
  },
  noResults: {
    en: "No results",
    "zh-CN": "无结果",
  },
  noWorkspacesYet: {
    en: "No workspaces yet",
    "zh-CN": "暂无工作区",
  },
  noPath: {
    en: "(no path)",
    "zh-CN": "（无路径）",
  },
  noRepository: {
    en: "No repository",
    "zh-CN": "无仓库",
  },
  openProjectLead: {
    en: "Open the lead of {name}",
    "zh-CN": "打开 {name} 的 Lead 会话",
  },
  foldGroup: {
    en: "Fold {name}",
    "zh-CN": "折叠 {name}",
  },
  unfoldGroup: {
    en: "Unfold {name}",
    "zh-CN": "展开 {name}",
  },
  projectNameLabel: {
    en: "Project name",
    "zh-CN": "项目名称",
  },
  doubleClickRename: {
    en: "Double-click to rename",
    "zh-CN": "双击重命名",
  },
  sealed: {
    en: "Sealed",
    "zh-CN": "已封存",
  },
  newSessionIn: {
    en: "New session in {name}",
    "zh-CN": "在 {name} 中新建会话",
  },
  newWorkspaceIn: {
    en: "New workspace in {path}",
    "zh-CN": "在 {path} 中新建工作区",
  },
  archiveProjectWithSessions: {
    en: "Archive {name} with its sessions",
    "zh-CN": "归档 {name} 及其会话",
  },
  restoreProjectTooltip: {
    en: "Bring {name} back among the projects",
    "zh-CN": "将 {name} 恢复到项目列表",
  },
  deleteProject: {
    en: "Delete project",
    "zh-CN": "删除项目",
  },
  deleteSession: {
    en: "Delete session",
    "zh-CN": "删除会话",
  },
  deleteSessionTitle: {
    en: "Delete {name}?",
    "zh-CN": "删除 {name}？",
  },
  deleteSessionBody: {
    en: "This session and its message history will be deleted.",
    "zh-CN": "此会话及其消息历史将被删除。",
  },
  yourTurnStatus: { en: "Your turn", "zh-CN": "轮到你" },
  yourTurnWithPrompt: { en: "Your turn: {prompt}", "zh-CN": "轮到你：{prompt}" },
  failedSession: { en: "Failed", "zh-CN": "失败" },
  unreadResult: { en: "Unread result", "zh-CN": "未读结果" },
  needYouCount: { en: "{count} need you", "zh-CN": "{count} 个等待你回复" },
  failedCount: { en: "{count} failed", "zh-CN": "{count} 个失败" },
  unreadCount: { en: "{count} unread", "zh-CN": "{count} 个未读" },
  archiveSession: { en: "Archive session", "zh-CN": "归档会话" },
  idleSessions: { en: "... ({count})", "zh-CN": "空闲（{count}）" },
  foldIdleTitle: { en: "Fold {count} idle session", "zh-CN": "折叠 {count} 个空闲会话" },
  foldIdlePluralTitle: { en: "Fold {count} idle sessions", "zh-CN": "折叠 {count} 个空闲会话" },
  foldMoreIdle: { en: "Fold (+{count})", "zh-CN": "折叠（+{count}）" },
  foldIdle: { en: "Fold ({count})", "zh-CN": "折叠空闲会话（{count}）" },
  queuedSession: { en: "Queued", "zh-CN": "已排队" },
  quietSession: { en: "Quiet", "zh-CN": "暂无动静" },
  quietSessionDetail: { en: "Quiet: {detail}", "zh-CN": "暂无动静：{detail}" },
  retryingSession: { en: "Retrying", "zh-CN": "正在重试" },
  retryingSessionAttempt: {
    en: "Retrying (attempt {attempt})",
    "zh-CN": "正在重试（第 {attempt} 次）",
  },
  archived: {
    en: "Archived",
    "zh-CN": "已归档",
  },
  deleteArchivedProjectSessions: {
    en: "Delete the archived sessions of {name}",
    "zh-CN": "删除 {name} 的已归档会话",
  },
  archivedProjects: {
    en: "Archived projects",
    "zh-CN": "已归档项目",
  },
  archivedProjectsTitle: {
    en: "Projects filed away. Their leads and history are still there.",
    "zh-CN": "已归档的项目。它们的 Lead 会话和历史记录仍保留。",
  },
  archivedWorkspacesTitle: {
    en: "Idle workspaces. History stays on disk; sending a message restores one.",
    "zh-CN": "空闲工作区。历史记录保留在磁盘上，发送消息即可恢复。",
  },
  deleteLooseArchivedTitle: {
    en: "Delete the archived workspaces that belong to no project",
    "zh-CN": "删除不属于任何项目的已归档工作区",
  },
  debugTools: { en: "Debug tools", "zh-CN": "调试工具" },
  unhealthy: { en: "unhealthy", "zh-CN": "异常" },
  debugToolsStatus: {
    en: "Debug tools (service diagnostics {state})",
    "zh-CN": "调试工具（服务诊断：{state}）",
  },
  diagnosticsStatus: { en: "Service diagnostics ({state})", "zh-CN": "服务诊断（{state}）" },
  savingSnapshot: { en: "Saving snapshot…", "zh-CN": "正在保存快照…" },
  savedSnapshot: { en: "Snapshot saved", "zh-CN": "快照已保存" },
  failedSnapshot: { en: "Snapshot failed", "zh-CN": "快照保存失败" },
  openWorkspaceMenu: {
    en: "Open workspace menu: {attention}",
    "zh-CN": "打开工作区菜单：{attention}",
  },
  serviceDiagnostics: {
    en: "Service diagnostics",
    "zh-CN": "服务诊断",
  },
  cpuLabel: {
    en: "CPU",
    "zh-CN": "CPU",
  },
  memLabel: {
    en: "Mem",
    "zh-CN": "内存",
  },

  // Git & PR summary
  gitDirtyFile: {
    en: "{count} changed file",
    "zh-CN": "{count} 个已更改文件",
  },
  gitDirtyFiles: {
    en: "{count} changed files",
    "zh-CN": "{count} 个已更改文件",
  },
  gitAhead: {
    en: "{count} ahead",
    "zh-CN": "领先 {count} 个提交",
  },
  gitBehind: {
    en: "{count} behind",
    "zh-CN": "落后 {count} 个提交",
  },
  gitAheadUpstream: {
    en: "{count} ahead of upstream",
    "zh-CN": "领先上游 {count} 个提交",
  },
  gitBehindUpstream: {
    en: "{count} behind upstream",
    "zh-CN": "落后上游 {count} 个提交",
  },
  gitClean: {
    en: "clean",
    "zh-CN": "工作区干净",
  },
  gitListSep: {
    en: ", ",
    "zh-CN": "，",
  },
  prMerged: {
    en: "merged",
    "zh-CN": "已合并",
  },
  prClosed: {
    en: "closed",
    "zh-CN": "已关闭",
  },
  prDraft: {
    en: "draft",
    "zh-CN": "草稿",
  },
  prOpen: {
    en: "open",
    "zh-CN": "开启",
  },
  prCheckSuccess: {
    en: "success",
    "zh-CN": "通过",
  },
  prCheckFailure: {
    en: "failure",
    "zh-CN": "失败",
  },
  prCheckPending: {
    en: "pending",
    "zh-CN": "进行中",
  },
  prChecksDetail: {
    en: ", checks {checks}",
    "zh-CN": "，检查{checks}",
  },
  prTitleTooltip: {
    en: "{title} ({state}{checks})",
    "zh-CN": "{title}（{state}{checks}）",
  },

  // Quota panel
  noQuotaData: { en: "No quota data", "zh-CN": "暂无配额数据" },
  quotaUsed: {
    en: "Quota used",
    "zh-CN": "配额使用",
  },
  refreshQuota: {
    en: "Refresh quota",
    "zh-CN": "刷新配额",
  },
  quotaNativeLabel: {
    en: "{base} · native",
    "zh-CN": "{base} · 原生",
  },
  quotaShortWeekly: {
    en: "wk",
    "zh-CN": "周",
  },
  quotaShortDaily: {
    en: "1d",
    "zh-CN": "日",
  },
  quotaShortMonthly: {
    en: "mo",
    "zh-CN": "月",
  },
  quotaShortCode: {
    en: "code",
    "zh-CN": "代码",
  },
  quotaShortPrimary: {
    en: "1st",
    "zh-CN": "主",
  },
  quotaShortSecondary: {
    en: "2nd",
    "zh-CN": "次",
  },
  quotaDetailWeekly: {
    en: "Weekly",
    "zh-CN": "每周",
  },
  quotaDetailDaily: {
    en: "Daily",
    "zh-CN": "每日",
  },
  quotaDetailMonthly: {
    en: "Monthly",
    "zh-CN": "每月",
  },
  quotaDetailMonthlyTotal: {
    en: "Monthly total",
    "zh-CN": "月度总额",
  },
  quotaDetailMonthlyCode: {
    en: "Monthly code",
    "zh-CN": "月度代码",
  },
  quotaDetailPrimary: {
    en: "Primary",
    "zh-CN": "主配额",
  },
  quotaDetailSecondary: {
    en: "Secondary",
    "zh-CN": "次配额",
  },
  quotaDetailHours: {
    en: "{n}h",
    "zh-CN": "{n}小时",
  },
  quotaDetailDays: {
    en: "{n}d",
    "zh-CN": "{n}天",
  },
  quotaDetailMinutes: {
    en: "{n}m",
    "zh-CN": "{n}分钟",
  },
  quotaNotConfigured: {
    en: "not configured",
    "zh-CN": "未配置",
  },
  quotaWaitingSetup: {
    en: "waiting for setup",
    "zh-CN": "等待配置",
  },
  quotaWarmingUp: {
    en: "warming up",
    "zh-CN": "正在获取",
  },
  quotaWaitingExplicitAcpSetup: {
    en: "Waiting for explicit ACP setup",
    "zh-CN": "等待显式完成 ACP 配置",
  },
  quotaReasonWaitingAcpSetup: {
    en: "waiting for ACP setup",
    "zh-CN": "等待 ACP 配置",
  },
  quotaReasonWaitingPiSession: {
    en: "waiting for Pi session",
    "zh-CN": "等待 Pi 会话",
  },
  quotaReasonCheckingUsage: {
    en: "checking usage",
    "zh-CN": "正在查询用量",
  },
  quotaReasonUsageUnavailable: {
    en: "usage unavailable",
    "zh-CN": "用量不可用",
  },
  quotaReasonNoQuotaAdapter: {
    en: "no quota adapter",
    "zh-CN": "无配额适配器",
  },
  quotaAvailabilityAvailable: {
    en: "available",
    "zh-CN": "可用",
  },
  quotaAvailabilityUnavailable: {
    en: "unavailable",
    "zh-CN": "不可用",
  },
  quotaAvailabilityUnsupported: {
    en: "unsupported",
    "zh-CN": "不支持",
  },
  quotaStale: {
    en: "stale",
    "zh-CN": "已过期",
  },
  quotaPctUsed: {
    en: "{pct}% used",
    "zh-CN": "已用 {pct}%",
  },
  quotaResetsAt: {
    en: "Resets {time}",
    "zh-CN": "重置于 {time}",
  },
  quotaUpdatedAt: {
    en: "Updated {time}",
    "zh-CN": "更新于 {time}",
  },
  quotaNotYetObserved: {
    en: "Not yet observed",
    "zh-CN": "尚未获取",
  },

  // Workspace dialogs
  addAgentTitle: {
    en: "Add Agent",
    "zh-CN": "添加代理",
  },
  nameOrUsePreset: {
    en: "Name (or use preset)",
    "zh-CN": "名称（或使用预设）",
  },
  modelLabel: {
    en: "Model",
    "zh-CN": "模型",
  },
  noModelsAvailable: {
    en: "No models available",
    "zh-CN": "暂无可用模型",
  },
  codexNotSignedIn: {
    en: "Codex (not signed in)",
    "zh-CN": "Codex（未登录）",
  },
  signInToCodexEllipsis: {
    en: "Sign in to Codex…",
    "zh-CN": "登录 Codex…",
  },
  effortLabel: {
    en: "Effort",
    "zh-CN": "推理强度",
  },
  reasoningEffort: {
    en: "Reasoning effort",
    "zh-CN": "推理强度",
  },
  signInToCodex: {
    en: "Sign in to Codex",
    "zh-CN": "登录 Codex",
  },
  codexSetupBody: {
    en: "Run this command in your terminal to sign in with your Codex account, then re-check to unlock Codex models and quota:",
    "zh-CN": "请在终端运行以下命令登录你的 Codex 账号，完成后重新检查即可解锁 Codex 模型与配额：",
  },
  recheck: {
    en: "Re-check",
    "zh-CN": "重新检查",
  },
  checking: {
    en: "Checking…",
    "zh-CN": "检查中…",
  },
  codexSignedIn: {
    en: "Codex is signed in.",
    "zh-CN": "Codex 已登录。",
  },
  checkFailed: {
    en: "Check failed: {error}",
    "zh-CN": "检查失败：{error}",
  },
  codexCliUnavailable: {
    en: "Codex CLI binary is unavailable on the server.",
    "zh-CN": "服务器上未找到 Codex CLI 可执行文件。",
  },
  codexStillNotSignedIn: {
    en: "Still not signed in. Finish running the command above, then click Re-check.",
    "zh-CN": "仍未登录。请先在终端运行上方命令，然后点击“重新检查”。",
  },
  newProjectTitle: {
    en: "New Project",
    "zh-CN": "新建项目",
  },
  nameLabel: {
    en: "Name",
    "zh-CN": "名称",
  },
  projectNamePlaceholder: {
    en: "Project name…",
    "zh-CN": "项目名称…",
  },
  repositoryPath: {
    en: "Repository path",
    "zh-CN": "仓库路径",
  },
  createWithoutGit: {
    en: "Create without a Git repository",
    "zh-CN": "不使用 Git 仓库创建",
  },
  createWithoutGitHelp: {
    en: "A project without Git still has objectives, issues, notes and a lead session.",
    "zh-CN": "不使用 Git 的项目仍然拥有目标、问题、笔记和 Lead 会话。",
  },
  createProject: {
    en: "Create project",
    "zh-CN": "创建项目",
  },
  newSessionTitle: {
    en: "New Session",
    "zh-CN": "新建会话",
  },
  directoryPath: {
    en: "Directory path",
    "zh-CN": "目录路径",
  },
  sessionNamePlaceholder: {
    en: "Session name…",
    "zh-CN": "会话名称…",
  },
  projectLabel: {
    en: "Project",
    "zh-CN": "项目",
  },
  hostLabel: {
    en: "Host",
    "zh-CN": "主机",
  },
  createSession: {
    en: "Create session",
    "zh-CN": "创建会话",
  },

  // Effort select
  effortDefaultFallback: {
    en: "default ({level})",
    "zh-CN": "默认（{level}）",
  },
  effortDefault: {
    en: "default",
    "zh-CN": "默认",
  },
  effortOff: {
    en: "off",
    "zh-CN": "关闭",
  },
  effortMinimal: {
    en: "minimal",
    "zh-CN": "极低",
  },
  effortLow: {
    en: "low",
    "zh-CN": "低",
  },
  effortMedium: {
    en: "medium",
    "zh-CN": "中",
  },
  effortHigh: {
    en: "high",
    "zh-CN": "高",
  },
  effortXhigh: {
    en: "xhigh",
    "zh-CN": "超高",
  },
  effortMax: {
    en: "max",
    "zh-CN": "最高",
  },

  // Workspace controls & extension UI
  agentExtensionUi: {
    en: "{name} extension UI",
    "zh-CN": "{name} 扩展界面",
  },
  dismissNotification: {
    en: "Dismiss notification",
    "zh-CN": "关闭通知",
  },
  reportsToLead: {
    en: "Reports to lead",
    "zh-CN": "向 Lead 汇报",
  },
  notReporting: {
    en: "Not reporting",
    "zh-CN": "未汇报",
  },
  reportsToLeadTitle: {
    en: "Reports to the project's lead, which may send it work. Click to stop: it keeps reading the board and history",
    "zh-CN": "向项目的 Lead 汇报，Lead 可能会向其指派工作。点击停止汇报（仍可读取看板和历史记录）",
  },
  notReportingTitle: {
    en: "Your own session: the lead neither hears from it nor sends it work. Click to report to the lead",
    "zh-CN": "你的独立会话：Lead 不会接收其汇报，也不会向其指派工作。点击开始向 Lead 汇报",
  },
  roleLead: {
    en: "lead",
    "zh-CN": "Lead",
  },
  roleIsolated: {
    en: "isolated",
    "zh-CN": "隔离",
  },
  roleIsolatedTitle: {
    en: "Sees only its own task: none of the board, notes, issues or other sessions",
    "zh-CN": "仅可见自身任务：无法访问看板、笔记、问题或其他会话",
  },
  timeRemainingLabel: {
    en: "Time remaining",
    "zh-CN": "剩余时间",
  },
  secondsRemaining: {
    en: "{seconds}s remaining",
    "zh-CN": "剩余 {seconds} 秒",
  },
  expired: {
    en: "expired",
    "zh-CN": "已超时",
  },
  choicesLabel: {
    en: "Choices",
    "zh-CN": "选项",
  },
  responseLabel: {
    en: "Response",
    "zh-CN": "回复",
  },
  answerSentWaiting: {
    en: "Answer sent; waiting for the session…",
    "zh-CN": "回复已发送，正在等待会话处理…",
  },
} as const satisfies MessageCatalog;

export type WorkspaceMessageKey = keyof typeof workspaceMessages;

export const { t: tWorkspace, useT: useWorkspaceT } = createTranslator(workspaceMessages);
