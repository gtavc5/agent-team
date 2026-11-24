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

const OPTIONAL_BUILTIN_KEYS: Partial<Record<PiBuiltinName, readonly string[]>> = {
  read: ["offset", "limit"],
  bash: ["timeout"],
  ls: ["path", "file_path", "limit"],
  find: ["path", "file_path", "limit"],
  grep: ["path", "file_path", "glob", "ignoreCase", "literal", "context", "limit"],
};

export interface FormattedPiToolUse {
  toolName: string;
  toolSource: ToolSource;
  content: string;
  toolInput?: ToolInput;
}

function isBuiltin(name: string): name is PiBuiltinName {
  return Object.hasOwn(BUILTIN_TITLES, name);
}

function pathOf(input: Record<string, unknown>): unknown {
  return input.path ?? input.file_path;
}

function inlineCode(value: unknown): string | undefined {
  return typeof value === "string" && value && value === value.trim() && !/[`\r\n]/.test(value)
    ? `\`${value}\``
    : undefined;
}

function summaryLine(head: string, ...parts: Array<string | undefined>): string {
  const summary = parts.filter(Boolean).join(" · ");
  return summary ? `${head} ${summary}` : head;
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

interface Replacement {
  oldText: string;
  newText: string;
}

interface EditArgs {
  replacements: Replacement[];
  invalidReplacements: number;
}

const LEGACY_EDIT_KEYS = ["oldText", "old_string", "newText", "new_string"];

function isReplacement(value: unknown): value is Replacement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { oldText, newText } = value as Record<string, unknown>;
  return typeof oldText === "string" && typeof newText === "string";
}

function parseEditArgs(input: Record<string, unknown>): EditArgs {
  let { edits } = input;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits) as unknown;
    } catch {
      edits = null;
    }
  }
  const entries: unknown[] = Array.isArray(edits) ? edits : edits === undefined ? [] : [edits];
  const replacements = entries.filter(isReplacement);
  let invalidReplacements = entries.length - replacements.length;
  const legacy = {
    oldText: input.oldText ?? input.old_string,
    newText: input.newText ?? input.new_string,
  };
  if (isReplacement(legacy)) {
    replacements.push(legacy);
  } else if (
    LEGACY_EDIT_KEYS.some((key) =>
      replacements.length ? input[key] != null : input[key] !== undefined,
    )
  ) {
    invalidReplacements++;
  }
  return { replacements, invalidReplacements };
}

function extractToolInput(
  title: "Read" | "Write" | "Edit",
  input: Record<string, unknown>,
  editArgs?: EditArgs,
): ToolInput {
  const filePath = pathOf(input);
  const replacements = editArgs?.replacements;
  const edit = replacements?.length === 1 ? replacements[0] : undefined;
  return {
    tool: title,
    ...(typeof filePath === "string" ? { file_path: filePath } : {}),
    ...(edit ? { old_string: edit.oldText, new_string: edit.newText } : {}),
  };
}

function codeBody(value: unknown, lang = ""): string | undefined {
  return typeof value === "string" ? `\n${fenced(value, lang)}` : undefined;
}

function diffBody(replacements: Replacement[]): string {
  const lines = (text: string, prefix: string) =>
    text ? text.split(/\r\n?|\n/).map((line) => `${prefix} ${line}`) : [];
  const diff = replacements
    .map(({ oldText, newText }) => [...lines(oldText, "-"), ...lines(newText, "+")].join("\n"))
    .filter(Boolean)
    .join("\n\n");
  return diff ? `\n${fenced(diff, "diff")}` : "";
}

function formatBuiltin(
  name: PiBuiltinName,
  input: Record<string, unknown>,
  editArgs?: EditArgs,
): string {
  const head = `**${BUILTIN_TITLES[name]}**`;
  // Strict schemas can send null for an omitted optional argument.
  const shown = new Set(OPTIONAL_BUILTIN_KEYS[name]?.filter((key) => input[key] === null));
  const show = (key: string, text: string | undefined) => {
    if (text !== undefined) shown.add(key);
    return text;
  };
  const path = () => show(input.path != null ? "path" : "file_path", inlineCode(pathOf(input)));
  const number = (key: string, unit = "") => {
    const value = input[key];
    return show(
      key,
      typeof value === "number" && Number.isFinite(value) ? `${key} ${value}${unit}` : undefined,
    );
  };
  const flag = (key: string, label: string) =>
    show(key, typeof input[key] === "boolean" ? (input[key] ? label : "") : undefined);
  const rest = () => jsonBlock(input, shown);
  switch (name) {
    case "read":
      return summaryLine(head, path(), number("offset"), number("limit")) + rest();
    case "ls": {
      const directory = path() ?? (pathOf(input) == null ? "`.`" : undefined);
      return summaryLine(head, directory, number("limit")) + rest();
    }
    case "grep":
    case "find": {
      const directory = path();
      const pattern = [show("pattern", inlineCode(input.pattern)), directory && `in ${directory}`]
        .filter(Boolean)
        .join(" ");
      if (name === "find") return summaryLine(head, pattern, number("limit")) + rest();
      const glob = show("glob", inlineCode(input.glob));
      return (
        summaryLine(
          head,
          pattern,
          glob && `glob ${glob}`,
          flag("ignoreCase", "ignore case"),
          flag("literal", "literal"),
          number("context"),
          number("limit"),
        ) + rest()
      );
    }
    case "bash":
      return (
        summaryLine(head, number("timeout", "s")) +
        (show("command", codeBody(input.command, "bash")) ?? "") +
        rest()
      );
    case "write":
      return summaryLine(head, path()) + (show("content", codeBody(input.content)) ?? "") + rest();
    case "edit": {
      shown.add("edits");
      for (const key of LEGACY_EDIT_KEYS) shown.add(key);
      const invalid = editArgs?.invalidReplacements;
      const warning = invalid
        ? `${invalid} invalid replacement${invalid === 1 ? "" : "s"}`
        : undefined;
      return summaryLine(head, path(), warning) + diffBody(editArgs?.replacements ?? []) + rest();
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
    const editArgs = name === "edit" ? parseEditArgs(args) : undefined;
    return {
      toolName: name,
      toolSource: "builtin",
      content: formatBuiltin(name, args, editArgs),
      ...(title === "Read" || title === "Write" || title === "Edit"
        ? { toolInput: extractToolInput(title, args, editArgs) }
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
