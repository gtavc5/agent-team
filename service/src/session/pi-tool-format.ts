import { fenced, formatPanelTool, type ToolInput, type ToolSource } from "./types";

const BUILTIN_TITLES = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  find: "Find",
  ls: "Ls",
} as const;

type PiBuiltinName = keyof typeof BUILTIN_TITLES;

export interface FormattedPiToolUse {
  toolName: string;
  toolSource: ToolSource;
  content: string;
  toolInput?: ToolInput;
}

function isBuiltin(name: string): name is PiBuiltinName {
  return Object.hasOwn(BUILTIN_TITLES, name);
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

function pathOf(input: Record<string, unknown>): unknown {
  return input.path ?? input.file_path;
}

function jsonBlock(
  input: Record<string, unknown>,
  excluded: ReadonlySet<string> = new Set(),
): string {
  const rest = Object.fromEntries(
    Object.entries(input).filter(([key, value]) => !excluded.has(key) && value !== undefined),
  );
  return Object.keys(rest).length ? `\n${fenced(JSON.stringify(rest, null, 2), "json")}` : "";
}

function extractToolInput(
  title: "Read" | "Write" | "Edit",
  input: Record<string, unknown>,
): ToolInput {
  const filePath = pathOf(input);
  const oldString = input.oldText ?? input.old_string;
  const newString = input.newText ?? input.new_string;
  return {
    tool: title,
    ...(typeof filePath === "string" ? { file_path: filePath } : {}),
    ...(title === "Edit" && typeof oldString === "string" ? { old_string: oldString } : {}),
    ...(title === "Edit" && typeof newString === "string" ? { new_string: newString } : {}),
  };
}

const PATH_KEYS = new Set(["path", "file_path"]);
const EDIT_VALUE_KEYS = new Set(["oldText", "old_string", "newText", "new_string"]);

function formatBuiltin(name: PiBuiltinName, input: Record<string, unknown>): string {
  const title = BUILTIN_TITLES[name];
  const head = `**${title}**`;
  switch (name) {
    case "read":
    case "ls":
      return `${head} \`${str(pathOf(input))}\`${jsonBlock(input, PATH_KEYS)}`;
    case "grep":
    case "find":
      return `${head} \`${str(input.pattern)}\`${jsonBlock(input, new Set(["pattern"]))}`;
    case "bash":
      return `${head}\n${fenced(str(input.command), "bash")}${jsonBlock(
        input,
        new Set(["command"]),
      )}`;
    case "write":
      return `${head} \`${str(pathOf(input))}\`\n${fenced(str(input.content))}${jsonBlock(
        input,
        new Set([...PATH_KEYS, "content"]),
      )}`;
    case "edit": {
      const oldString = str(input.oldText ?? input.old_string ?? "");
      const newString = str(input.newText ?? input.new_string ?? "");
      const diff = `${oldString
        .split("\n")
        .map((line) => `- ${line}`)
        .join("\n")}\n${newString
        .split("\n")
        .map((line) => `+ ${line}`)
        .join("\n")}`;
      return `${head} \`${str(pathOf(input))}\`\n${fenced(diff, "diff")}${jsonBlock(
        input,
        new Set([...PATH_KEYS, ...EDIT_VALUE_KEYS]),
      )}`;
    }
  }
}

// Keys already represented on formatPanelTool's first line. Its other known
// fields are repeated as JSON so every argument remains independently searchable.
const PANEL_FIRST_LINE_KEYS: Record<string, readonly string[]> = {
  start_session: ["title", "cwd"],
  message_session: ["session_id"],
  message_project: ["project_id"],
  read_session: ["session_id"],
  stop_session: ["session_id"],
  archive_session: ["session_id"],
  update_objective: ["id", "status", "title"],
  read_note: ["slug"],
  write_note: ["slug", "expected_version"],
};

function formatOwnedPanelTool(name: string, input: Record<string, unknown>): string {
  const formatted = formatPanelTool(name, input);
  const firstLineKeys = PANEL_FIRST_LINE_KEYS[name];
  if (!firstLineKeys && !["report_progress", "finish_task", "list_notes"].includes(name)) {
    // formatPanelTool's default branch already emits the complete JSON object.
    return formatted;
  }
  return `${formatted}${jsonBlock(input, new Set(firstLineKeys ?? []))}`;
}

export function formatPiToolUse(
  name: string,
  input: Record<string, unknown> | undefined,
  bridgeOwnedTools?: ReadonlySet<string>,
): FormattedPiToolUse {
  const args = input ?? {};
  if (bridgeOwnedTools?.has(name)) {
    return {
      toolName: `mcp__panel__${name}`,
      toolSource: "panel",
      content: formatOwnedPanelTool(name, args),
    };
  }

  if (isBuiltin(name)) {
    const title = BUILTIN_TITLES[name];
    return {
      toolName: name,
      toolSource: "builtin",
      content: input ? formatBuiltin(name, args) : `**${title}**`,
      ...(title === "Read" || title === "Write" || title === "Edit"
        ? { toolInput: extractToolInput(title, args) }
        : {}),
    };
  }

  return {
    toolName: name,
    toolSource: name.startsWith("mcp__") ? "mcp" : "extension",
    content: `**${name}**${input ? `\n${fenced(JSON.stringify(args, null, 2), "json")}` : ""}`,
  };
}

// Pi tool results contain text and non-text content blocks. Non-text blocks
// stay visible as placeholders without inlining binary data into Markdown.
export function extractPiToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return "[content]";
      const value = block as Record<string, unknown>;
      if (value.type === "text") return typeof value.text === "string" ? value.text : "";
      return `[${typeof value.type === "string" && value.type ? value.type : "content"}]`;
    })
    .join("\n");
}
