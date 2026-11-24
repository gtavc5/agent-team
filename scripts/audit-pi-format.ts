import { createReadStream, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { formatPiToolUse } from "../service/src/session/pi-tool-format";

const USAGE = "Usage: npx tsx scripts/audit-pi-format.ts [directory] [--limit <builtin calls>]";
const SINGLE_LINE = new Set(["read", "ls", "grep", "find"]);
const JSON_FALLBACK = /\n(`{3,})json\n\{\n[\s\S]*\n\}\n\1$/;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function audit(directory: string, limit: number): Promise<void> {
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const counts = new Map<string, number>();
  let builtins = 0;
  let anomalies = 0;
  let malformed = 0;
  let filesRead = 0;

  scan: for (const file of files) {
    filesRead++;
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let record: unknown;
        try {
          record = JSON.parse(line) as unknown;
        } catch {
          malformed++;
          continue;
        }
        const entry = object(record);
        const message = entry?.type === "message" ? object(entry.message) : undefined;
        if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
        for (const block of message.content as unknown[]) {
          const call = object(block);
          if (call?.type !== "toolCall" || typeof call.name !== "string") continue;
          const args = object(call.arguments);
          const { toolName, toolSource, content } = formatPiToolUse(call.name, args);
          if (toolSource !== "builtin") continue;
          builtins++;
          const reasons = [];
          if (!args) reasons.push("invalid arguments");
          if (JSON_FALLBACK.test(content)) reasons.push("JSON fallback");
          if (SINGLE_LINE.has(toolName) && content.includes("\n")) reasons.push("multi-line");
          if (
            toolName === "edit" &&
            / · \d+ invalid replacements?$/.test(content.split("\n", 1)[0])
          ) {
            reasons.push("invalid replacement");
          }
          if (reasons.length) {
            anomalies++;
            const values = Object.values(args ?? {});
            const nulls = values.filter((value) => value === null).length;
            const shape = `${toolName}: ${reasons.join(", ")} (${values.length} args, ${nulls} null)`;
            counts.set(shape, (counts.get(shape) ?? 0) + 1);
          }
          if (builtins >= limit) break scan;
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  console.log(`${anomalies}/${builtins} builtin calls flagged across ${filesRead} JSONL files.`);
  for (const [shape, count] of [...counts].sort()) console.log(`  ${count} ${shape}`);
  if (malformed) console.log(`Skipped ${malformed} malformed JSONL lines.`);
  if (anomalies) process.exitCode = 1;
}

async function main(): Promise<void> {
  let directory: string;
  let limit: number;
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      options: { limit: { type: "string" }, help: { type: "boolean" } },
    });
    if (values.help) {
      console.log(USAGE);
      return;
    }
    directory = positionals[0] ?? join(homedir(), ".yaat", "pi-sessions");
    limit = values.limit === undefined ? Infinity : Number(values.limit);
    if (
      positionals.length > 1 ||
      (values.limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0))
    ) {
      throw new Error("Invalid arguments");
    }
  } catch {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  await audit(directory, limit);
}

void main().catch(() => {
  console.error("Could not audit the session directory.");
  process.exitCode = 2;
});
