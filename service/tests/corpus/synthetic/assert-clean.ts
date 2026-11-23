import * as fs from "node:fs";
import * as path from "node:path";

type JsonObject = Record<string, unknown>;

const MESSAGE_KEYS = ["role", "content", "toolCallId", "toolName", "isError"] as const;
const MESSAGE_ENTRY_KEYS = ["type", "id", "parentId", "timestamp", "message"] as const;
const TOOL_ARGUMENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  bash: ["command", "timeout"],
  grep: ["pattern", "path", "glob", "context", "ignoreCase", "limit"],
  read: ["path", "offset", "limit"],
};

function failure(line: number, pointer: string, reason: string): never {
  throw new Error(`Synthetic corpus violation at line ${line} ${pointer}: ${reason}`);
}

function objectValue(value: unknown, line: number, pointer: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failure(line, pointer, "expected an object");
  }
  return value as JsonObject;
}

function assertKeys(
  value: JsonObject,
  allowed: readonly string[],
  line: number,
  pointer: string,
  required: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) failure(line, `${pointer}.${key}`, "unknown field");
  }
  for (const key of required) {
    if (!(key in value)) failure(line, `${pointer}.${key}`, "missing field");
  }
}

function assertString(value: unknown, line: number, pointer: string): asserts value is string {
  if (typeof value !== "string") failure(line, pointer, "expected a string");
}

function assertNumber(value: unknown, line: number, pointer: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failure(line, pointer, "expected a finite number");
  }
}

function assertBoolean(value: unknown, line: number, pointer: string): void {
  if (typeof value !== "boolean") failure(line, pointer, "expected a boolean");
}

function assertPrivacy(value: unknown, line: number, pointer = "$"): void {
  if (typeof value === "string") {
    const checks: Array<[RegExp, string]> = [
      [/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/i, "host path"],
      [/(?:sk-|ghp_|AIza|ya29\.|Bearer\s)/i, "token pattern"],
      [/(?:data:[^\s,]+;base64,|\bbase64\b)/i, "Base64 payload"],
      [/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/, "email address"],
      [/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/, "IP address"],
      [/(?<![0-9a-f:])(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]*(?![0-9a-f:])/i, "IP address"],
      [/(?:https?:\/\/|www\.)|\b(?:[a-z0-9-]+\.)+[a-z]{2,63}\b/i, "public domain"],
      [/[A-Za-z0-9+/]{24,}={0,2}/, "possible Base64 payload"],
    ];
    for (const [pattern, reason] of checks) {
      if (pattern.test(value)) failure(line, pointer, reason);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPrivacy(item, line, `${pointer}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:image|images|attachment|attachments|base64|mimeType)$/i.test(key)) {
      failure(line, `${pointer}.${key}`, "image or attachment field");
    }
    assertPrivacy(item, line, `${pointer}.${key}`);
  }
}

function assertContent(content: unknown, line: number, pointer: string): void {
  if (typeof content === "string") return;
  if (!Array.isArray(content)) failure(line, pointer, "expected a string or content blocks");
  for (const [index, rawBlock] of content.entries()) {
    const blockPointer = `${pointer}[${index}]`;
    const block = objectValue(rawBlock, line, blockPointer);
    assertString(block.type, line, `${blockPointer}.type`);
    if (block.type === "text") {
      assertKeys(block, ["type", "text"], line, blockPointer, ["type", "text"]);
      assertString(block.text, line, `${blockPointer}.text`);
    } else if (block.type === "thinking") {
      assertKeys(block, ["type", "thinking"], line, blockPointer, ["type", "thinking"]);
      assertString(block.thinking, line, `${blockPointer}.thinking`);
    } else if (block.type === "toolCall") {
      assertKeys(block, ["type", "id", "name", "arguments"], line, blockPointer, [
        "type",
        "id",
        "name",
        "arguments",
      ]);
      assertString(block.id, line, `${blockPointer}.id`);
      assertString(block.name, line, `${blockPointer}.name`);
      assertToolArguments(block.name, block.arguments, line, `${blockPointer}.arguments`);
    } else {
      failure(line, `${blockPointer}.type`, "unknown content block");
    }
  }
}

function assertToolArguments(
  toolName: string,
  value: unknown,
  line: number,
  pointer: string,
): void {
  const allowed = TOOL_ARGUMENT_KEYS[toolName];
  if (!allowed) failure(line, pointer, "unknown synthetic tool");
  const args = objectValue(value, line, pointer);
  assertKeys(args, allowed, line, pointer);
  for (const [key, item] of Object.entries(args)) {
    if (["command", "pattern", "path", "glob"].includes(key)) {
      assertString(item, line, `${pointer}.${key}`);
    } else if (["timeout", "context", "limit", "offset"].includes(key)) {
      assertNumber(item, line, `${pointer}.${key}`);
    } else if (key === "ignoreCase") {
      assertBoolean(item, line, `${pointer}.${key}`);
    }
  }
}

function assertMessage(value: unknown, line: number, pointer: string): void {
  const message = objectValue(value, line, pointer);
  assertKeys(message, MESSAGE_KEYS, line, pointer, ["role", "content"]);
  assertString(message.role, line, `${pointer}.role`);
  if (!["user", "assistant", "toolResult", "tool_result"].includes(message.role)) {
    failure(line, `${pointer}.role`, "unknown message role");
  }
  assertContent(message.content, line, `${pointer}.content`);
  if (message.toolCallId !== undefined) {
    assertString(message.toolCallId, line, `${pointer}.toolCallId`);
  }
  if (message.toolName !== undefined) {
    assertString(message.toolName, line, `${pointer}.toolName`);
  }
  if (message.isError !== undefined) assertBoolean(message.isError, line, `${pointer}.isError`);
}

function assertTreeIdentity(entry: JsonObject, line: number): void {
  assertString(entry.id, line, "$.id");
  if (entry.parentId !== null && entry.parentId !== undefined) {
    assertString(entry.parentId, line, "$.parentId");
  }
  if (entry.timestamp !== undefined) assertNumber(entry.timestamp, line, "$.timestamp");
}

function assertNotifyData(data: JsonObject, line: number): void {
  assertKeys(data, ["runs"], line, "$.data", ["runs"]);
  if (!Array.isArray(data.runs)) failure(line, "$.data.runs", "expected an array");
  for (const [runIndex, rawRun] of data.runs.entries()) {
    const runPointer = `$.data.runs[${runIndex}]`;
    const run = objectValue(rawRun, line, runPointer);
    assertKeys(run, ["runId", "mode", "status", "children"], line, runPointer, [
      "runId",
      "children",
    ]);
    assertString(run.runId, line, `${runPointer}.runId`);
    if (run.mode !== undefined) assertString(run.mode, line, `${runPointer}.mode`);
    if (run.status !== undefined) assertString(run.status, line, `${runPointer}.status`);
    if (!Array.isArray(run.children)) failure(line, `${runPointer}.children`, "expected an array");
    for (const [childIndex, rawChild] of run.children.entries()) {
      const childPointer = `${runPointer}.children[${childIndex}]`;
      const child = objectValue(rawChild, line, childPointer);
      assertKeys(
        child,
        ["childId", "stepIndex", "sessionFile", "transcriptPath", "outputTruncated", "summary"],
        line,
        childPointer,
        ["childId", "stepIndex"],
      );
      assertString(child.childId, line, `${childPointer}.childId`);
      assertNumber(child.stepIndex, line, `${childPointer}.stepIndex`);
      for (const key of ["sessionFile", "transcriptPath", "summary"] as const) {
        if (child[key] !== undefined) assertString(child[key], line, `${childPointer}.${key}`);
      }
      if (child.outputTruncated !== undefined) {
        assertBoolean(child.outputTruncated, line, `${childPointer}.outputTruncated`);
      }
    }
  }
}

function assertSessionRecord(value: JsonObject, line: number, recordIndex: number): void {
  assertString(value.type, line, "$.type");
  if (recordIndex === 0) {
    assertKeys(value, ["type", "version", "id", "timestamp"], line, "$", ["type", "version", "id"]);
    if (value.type !== "session" || value.version !== 3) {
      failure(line, "$", "expected a Pi Session v3 header");
    }
    assertString(value.id, line, "$.id");
    if (value.timestamp !== undefined) assertNumber(value.timestamp, line, "$.timestamp");
    return;
  }
  if (value.type === "message") {
    assertKeys(value, MESSAGE_ENTRY_KEYS, line, "$", ["type", "id", "parentId", "message"]);
    assertTreeIdentity(value, line);
    assertMessage(value.message, line, "$.message");
  } else if (value.type === "compaction") {
    assertKeys(
      value,
      ["type", "id", "parentId", "timestamp", "summary", "firstKeptEntryId", "tokensBefore"],
      line,
      "$",
      ["type", "id", "parentId", "summary"],
    );
    assertTreeIdentity(value, line);
    assertString(value.summary, line, "$.summary");
    if (value.firstKeptEntryId !== undefined) {
      assertString(value.firstKeptEntryId, line, "$.firstKeptEntryId");
    }
    if (value.tokensBefore !== undefined) assertNumber(value.tokensBefore, line, "$.tokensBefore");
  } else if (value.type === "custom") {
    assertKeys(value, ["type", "id", "parentId", "timestamp", "customType", "data"], line, "$", [
      "type",
      "id",
      "parentId",
      "customType",
      "data",
    ]);
    assertTreeIdentity(value, line);
    assertString(value.customType, line, "$.customType");
    const data = objectValue(value.data, line, "$.data");
    if (value.customType === "synthetic-note") {
      assertKeys(data, ["note"], line, "$.data", ["note"]);
      assertString(data.note, line, "$.data.note");
    } else if (value.customType === "subagent-notify") {
      assertNotifyData(data, line);
    } else {
      failure(line, "$.customType", "unknown synthetic custom entry");
    }
  } else {
    failure(line, "$.type", "unknown Session v3 entry");
  }
}

function assertTranscriptRecord(value: JsonObject, line: number): void {
  assertString(value.recordType, line, "$.recordType");
  if (value.recordType === "message") {
    assertKeys(value, ["recordType", "role", "message", "text", "outputTruncated"], line, "$", [
      "recordType",
      "message",
    ]);
    if (value.role !== undefined) assertString(value.role, line, "$.role");
    assertMessage(value.message, line, "$.message");
    if (value.text !== undefined) assertString(value.text, line, "$.text");
    if (value.outputTruncated !== undefined) {
      assertBoolean(value.outputTruncated, line, "$.outputTruncated");
    }
  } else if (value.recordType === "tool_start") {
    assertKeys(value, ["recordType", "toolCallId", "toolName", "args", "argsPayload"], line, "$", [
      "recordType",
      "toolCallId",
      "toolName",
    ]);
    assertString(value.toolCallId, line, "$.toolCallId");
    assertString(value.toolName, line, "$.toolName");
    if (value.argsPayload !== undefined) {
      assertString(value.argsPayload, line, "$.argsPayload");
      let args: unknown;
      try {
        args = JSON.parse(value.argsPayload);
      } catch {
        failure(line, "$.argsPayload", "invalid tool argument JSON");
      }
      assertToolArguments(value.toolName, args, line, "$.argsPayload");
    } else {
      assertToolArguments(value.toolName, value.args, line, "$.args");
    }
  } else if (value.recordType === "tool_end") {
    assertKeys(value, ["recordType", "toolCallId", "toolName", "isError"], line, "$", [
      "recordType",
      "toolCallId",
    ]);
    assertString(value.toolCallId, line, "$.toolCallId");
    if (value.toolName !== undefined) assertString(value.toolName, line, "$.toolName");
    if (value.isError !== undefined) assertBoolean(value.isError, line, "$.isError");
  } else if (value.recordType === "truncated") {
    assertKeys(value, ["recordType", "message"], line, "$", ["recordType"]);
    if (value.message !== undefined) assertString(value.message, line, "$.message");
  } else {
    failure(line, "$.recordType", "unknown child-transcript record");
  }
}

/** Validate both the exact synthetic schemas and the zero-privacy corpus rules. */
export function assertSyntheticCorpusClean(filePath: string): void {
  const transcript = path.basename(filePath).startsWith("child-transcript");
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  let recordIndex = 0;
  for (const [index, line] of lines.entries()) {
    if (index === lines.length - 1 && line === "") continue;
    if (!line.trim()) failure(index + 1, "$", "blank JSONL record");
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      failure(index + 1, "$", "invalid JSON");
    }
    assertPrivacy(parsed, index + 1);
    const record = objectValue(parsed, index + 1, "$");
    if (transcript) assertTranscriptRecord(record, index + 1);
    else assertSessionRecord(record, index + 1, recordIndex);
    recordIndex += 1;
  }
  if (!transcript && recordIndex === 0) failure(1, "$", "missing Session v3 header");
}
