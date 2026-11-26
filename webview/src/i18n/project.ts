import { createTranslator, type MessageCatalog } from "./core";

export const projectMessages = {
  // Board dialog & header
  issuesDialogLabel: { en: "{name} issues", "zh-CN": "{name} 问题" },
  notesDialogLabel: { en: "{name} notes", "zh-CN": "{name} 笔记" },
  boardDialogLabel: {
    en: "{name} objectives",
    "zh-CN": "{name} 目标看板",
  },
  sealedBadge: {
    en: "Sealed · read-only",
    "zh-CN": "已封存 · 只读",
  },
  showGroupLabel: {
    en: "Show",
    "zh-CN": "显示",
  },
  tabObjectives: {
    en: "Objectives",
    "zh-CN": "目标",
  },
  tabIssues: {
    en: "Issues",
    "zh-CN": "问题",
  },
  tabNotes: {
    en: "Notes",
    "zh-CN": "笔记",
  },
  issuesSummary: {
    en: "{open} open · {decision} to decide · {accepted} accepted",
    "zh-CN": "{open} 待处理 · {decision} 待决策 · {accepted} 已接受",
  },
  objectivesSummary: {
    en: "{active} active · {later} later · {done} done",
    "zh-CN": "{active} 进行中 · {later} 稍后 · {done} 已完成",
  },
  searchIssuesPlaceholder: {
    en: "Search issues…",
    "zh-CN": "搜索问题…",
  },
  searchObjectivesPlaceholder: {
    en: "Search objectives…",
    "zh-CN": "搜索目标…",
  },
  viewGroupLabel: {
    en: "View",
    "zh-CN": "视图",
  },
  viewList: {
    en: "List",
    "zh-CN": "列表",
  },
  viewDependencies: {
    en: "Dependencies",
    "zh-CN": "依赖图",
  },
  closeLabel: {
    en: "Close",
    "zh-CN": "关闭",
  },
  renameTitle: {
    en: "Rename",
    "zh-CN": "重命名",
  },
  projectNameLabel: {
    en: "Project name",
    "zh-CN": "项目名称",
  },

  // Objective statuses, priorities, stages, tasks
  statusActive: {
    en: "Active",
    "zh-CN": "进行中",
  },
  statusLater: {
    en: "Later",
    "zh-CN": "稍后",
  },
  statusDone: {
    en: "Done",
    "zh-CN": "已完成",
  },
  statusDropped: {
    en: "Dropped",
    "zh-CN": "已放弃",
  },
  priorityHigh: {
    en: "high",
    "zh-CN": "高",
  },
  priorityNormal: {
    en: "normal",
    "zh-CN": "普通",
  },
  priorityLow: {
    en: "low",
    "zh-CN": "低",
  },
  priorityDetail: {
    en: "{priority} priority",
    "zh-CN": "{priority}优先级",
  },
  stageBlocked: {
    en: "blocked",
    "zh-CN": "阻塞",
  },
  stageReady: {
    en: "ready",
    "zh-CN": "就绪",
  },
  stageInProgress: {
    en: "in progress",
    "zh-CN": "进行中",
  },
  stageReview: {
    en: "review",
    "zh-CN": "待审阅",
  },
  stageBlockedBy: {
    en: "blocked by {count}",
    "zh-CN": "被 {count} 项阻塞",
  },
  taskTodo: {
    en: "todo",
    "zh-CN": "待办",
  },
  taskDoing: {
    en: "doing",
    "zh-CN": "进行中",
  },
  taskReview: {
    en: "review",
    "zh-CN": "待审阅",
  },
  taskDone: {
    en: "done",
    "zh-CN": "已完成",
  },
  taskDropped: {
    en: "dropped",
    "zh-CN": "已放弃",
  },

  // Board navigation & actions
  filtersLabel: {
    en: "Filters",
    "zh-CN": "筛选",
  },
  allAreas: {
    en: "All areas",
    "zh-CN": "全部领域",
  },
  statusGroupLabel: {
    en: "Status",
    "zh-CN": "状态",
  },
  archiveFilterLabel: {
    en: "Archive",
    "zh-CN": "归档",
  },
  restoreProject: {
    en: "Restore project",
    "zh-CN": "恢复项目",
  },
  archiveProject: {
    en: "Archive project",
    "zh-CN": "归档项目",
  },
  sealProject: {
    en: "Seal project",
    "zh-CN": "封存项目",
  },
  deleteProject: {
    en: "Delete project",
    "zh-CN": "删除项目",
  },

  // Board banners & empty states
  brokenFileSuffix: {
    en: "cannot be read: {error}",
    "zh-CN": "无法读取：{error}",
  },
  listAnd: {
    en: " and ",
    "zh-CN": " 和 ",
  },
  duplicateIssueTwice: {
    en: "is in {modules} twice: only the first is shown, and the agents cannot change it until one is renamed.",
    "zh-CN": "在 {modules} 中出现了两次：当前仅显示第一条，在重命名其中一个之前 Agent 无法修改它。",
  },
  duplicateIssueMultiple: {
    en: "is in {modules}: only the first is shown, and the agents cannot change it until one is renamed.",
    "zh-CN": "同时存在于 {modules} 中：当前仅显示第一条，在重命名其中一个之前 Agent 无法修改它。",
  },
  emptyIssues: {
    en: "No issues yet. The agents record the known defects here, each with its evidence and the objectives that work on it, and delete one once its fix is merged.",
    "zh-CN": "暂无问题。Agent 会在这里记录已知缺陷及其证据和关联目标，并在修复合并后将其删除。",
  },
  emptyObjectives: {
    en: "No objectives yet. Tell the lead what you want done, put off or dropped; it keeps the board.",
    "zh-CN": "暂无目标。告诉 Lead 你想完成、延后或放弃什么事项，由它来维护项目看板。",
  },
  nothingMatches: {
    en: "Nothing matches.",
    "zh-CN": "没有匹配项。",
  },
  nothingArchived: {
    en: "Nothing archived.",
    "zh-CN": "暂无归档目标。",
  },

  // Objective cards & dependency graph
  tasksProgressTitle: {
    en: "{done} of {total} tasks done",
    "zh-CN": "已完成 {done}/{total} 个任务",
  },
  toDecideCount: {
    en: "{count} to decide",
    "zh-CN": "{count} 项待决策",
  },
  issueCountOne: {
    en: "{count} issue",
    "zh-CN": "{count} 个问题",
  },
  issueCountMany: {
    en: "{count} issues",
    "zh-CN": "{count} 个问题",
  },
  archivedRelative: {
    en: "archived {time}",
    "zh-CN": "归档于 {time}",
  },
  notShownTitle: {
    en: "Not shown: {ids}",
    "zh-CN": "未显示：{ids}",
  },
  notShownBadge: {
    en: "+{count} not shown",
    "zh-CN": "+{count} 未显示",
  },
  graphStepColumn: {
    en: "Step {step}",
    "zh-CN": "第 {step} 步",
  },
  graphIndependentColumn: {
    en: "Independent",
    "zh-CN": "独立目标",
  },

  // Objective & shared details
  backLabel: {
    en: "Back",
    "zh-CN": "返回",
  },
  askLead: {
    en: "Ask the lead",
    "zh-CN": "询问 Lead",
  },
  closeDetailsLabel: {
    en: "Close details",
    "zh-CN": "关闭详情",
  },
  archivedPill: {
    en: "Archived",
    "zh-CN": "已归档",
  },
  updatedRelative: {
    en: "updated {time}",
    "zh-CN": "更新于 {time}",
  },
  notAnObjective: {
    en: "Not an objective",
    "zh-CN": "目标不存在",
  },
  archivedParen: {
    en: " (archived)",
    "zh-CN": "（已归档）",
  },
  objectiveRefTitle: {
    en: "{status}{note}: {detail}",
    "zh-CN": "{status}{note}：{detail}",
  },
  sectionGoal: {
    en: "Goal",
    "zh-CN": "目标",
  },
  sectionDependsOn: {
    en: "Depends on",
    "zh-CN": "前置依赖",
  },
  noDependencies: {
    en: "Nothing: it can start any time.",
    "zh-CN": "无前置依赖，可随时开始。",
  },
  sectionNeededBy: {
    en: "Needed by",
    "zh-CN": "下游依赖",
  },
  sectionWhereItStands: {
    en: "Where it stands",
    "zh-CN": "当前进展",
  },
  writtenRelative: {
    en: "written {time}",
    "zh-CN": "写于 {time}",
  },
  writtenRelativeAt: {
    en: "written {time} at {commit}",
    "zh-CN": "写于 {time} · {commit}",
  },
  sectionTasksProgress: {
    en: "Tasks · {done}/{total}",
    "zh-CN": "任务 · {done}/{total}",
  },
  sectionTasks: {
    en: "Tasks",
    "zh-CN": "任务",
  },
  noTasks: {
    en: "No tasks yet.",
    "zh-CN": "暂无任务。",
  },
  sectionToDecide: {
    en: "To decide · {count}",
    "zh-CN": "待决策 · {count}",
  },
  sectionSettled: {
    en: "Settled",
    "zh-CN": "已决策",
  },
  sectionIssuesOpen: {
    en: "Issues · {count} open",
    "zh-CN": "问题 · {count} 个待处理",
  },
  acceptedIssuesNote: {
    en: "{count} accepted, not to be fixed.",
    "zh-CN": "{count} 个已接受，暂不修复。",
  },
  sectionSessions: {
    en: "Sessions",
    "zh-CN": "关联会话",
  },
  sectionNotes: {
    en: "Notes",
    "zh-CN": "笔记",
  },

  // Issues view
  issueStateOpen: {
    en: "Open",
    "zh-CN": "待处理",
  },
  issueStateDecision: {
    en: "To decide",
    "zh-CN": "待决策",
  },
  issueStateAccepted: {
    en: "Accepted",
    "zh-CN": "已接受",
  },
  evidenceR: {
    en: "Reproduced by a script",
    "zh-CN": "已通过脚本复现",
  },
  evidenceV: {
    en: "Confirmed by a probe",
    "zh-CN": "已通过探针验证",
  },
  evidenceH: {
    en: "Read from the code only",
    "zh-CN": "仅从代码分析推断",
  },
  evidenceS: {
    en: "Still there on an earlier re-test",
    "zh-CN": "早前复测时仍然存在",
  },
  evidenceC: {
    en: "Another agent's probe, not checked here",
    "zh-CN": "其他 Agent 验证，此处未复核",
  },
  issueFiltersLabel: {
    en: "Issue filters",
    "zh-CN": "问题筛选",
  },
  allModules: {
    en: "All modules",
    "zh-CN": "全部模块",
  },
  issueStateGroupLabel: {
    en: "State",
    "zh-CN": "状态",
  },
  issueEvidenceGroupLabel: {
    en: "Evidence",
    "zh-CN": "证据",
  },
  issueTagsGroupLabel: {
    en: "Tags",
    "zh-CN": "标签",
  },
  issueDetailLabel: {
    en: "Issue {id}",
    "zh-CN": "问题 {id}",
  },
  sectionIssueGroupNotes: {
    en: "In common with its group",
    "zh-CN": "同组说明",
  },
  sectionIssueModuleNotes: {
    en: "About the module",
    "zh-CN": "模块说明",
  },
  sectionObjectives: {
    en: "Objectives",
    "zh-CN": "关联目标",
  },
  noLinkedObjectives: {
    en: "No objective works on it yet.",
    "zh-CN": "暂无关联目标。",
  },

  // Notes view & file preview
  openFallbackNotice: {
    en: "{why}: the file is shown here instead.",
    "zh-CN": "{why}：已改为在此处显示该文件。",
  },
  notAFolder: {
    en: "Not a folder",
    "zh-CN": "不是文件夹",
  },
  loading: {
    en: "Loading…",
    "zh-CN": "加载中…",
  },
  noNotes: {
    en: "No notes yet.",
    "zh-CN": "暂无笔记。",
  },
  notesTreeLabel: {
    en: "Notes",
    "zh-CN": "笔记",
  },
  notAFile: {
    en: "not a file",
    "zh-CN": "不是文件",
  },
  vscodeOpenFailed: {
    en: "VS Code could not open it: {why}.",
    "zh-CN": "VS Code 无法打开：{why}。",
  },
  openInVscodeTitle: {
    en: "Open it in VS Code",
    "zh-CN": "在 VS Code 中打开",
  },
  closeFileLabel: {
    en: "Close the file",
    "zh-CN": "关闭文件",
  },
  didYouMean: {
    en: "Did you mean",
    "zh-CN": "你是不是要找",
  },
  binaryFileNote: {
    en: "A binary file: nothing to show.",
    "zh-CN": "二进制文件，无法预览。",
  },
  truncatedTextNote: {
    en: "Showing the first {shown} of {total}.",
    "zh-CN": "仅显示前 {shown}（共 {total}）。",
  },
  truncatedDirNote: {
    en: "Only the first entries are listed.",
    "zh-CN": "仅列出前一部分条目。",
  },
  notesEmptyPrompt: {
    en: "The lead's notes: rules, ideas, what each objective found out. Pick one to read it.",
    "zh-CN": "Lead 的笔记：规则、想法以及各目标的调研结论。选择一篇即可阅读。",
  },
} as const satisfies MessageCatalog;

export type ProjectMessageKey = keyof typeof projectMessages;

export const { t: tProject, useT: useProjectT } = createTranslator(projectMessages);
