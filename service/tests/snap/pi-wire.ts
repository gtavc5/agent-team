import { readFileSync } from "node:fs";
import { join } from "node:path";

type Frame = Record<string, unknown> & {
  type: string;
  command?: string;
  message?: { role?: string; [key: string]: unknown };
  assistantMessageEvent?: { type: string };
  data?: unknown;
};
export function piFrames(name: string): Frame[] {
  return readFileSync(join(__dirname, "pi", `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .flatMap((line) => (JSON.parse(line) as { frame?: Frame }).frame ?? []);
}
const frames = [
  "basic-turn",
  "tools-bash-edit",
  "messages/steer",
  "messages/startup",
  "interrupt-abort",
  "extension-ui-dialog",
  "compaction-and-retry",
].flatMap(piFrames);

// Rebind a matching reply or, for injected command outcomes, the standard
// successful response envelope. No captured IDs leave their own connection.
export function piReply(command: string): Frame {
  return structuredClone(
    frames.find((f) => f.command === command && f.type === "response") ??
      piFrame("response", { command: "prompt" }),
  );
}

/** Race tests schedule these independently of their original arrival order. */
export function piFrame(
  type: string,
  opts: { role?: string; command?: string; update?: string } = {},
): Frame {
  const frame = frames.find(
    (f) =>
      f.type === type &&
      (!opts.role || f.message?.role === opts.role) &&
      (!opts.command || f.command === opts.command) &&
      (!opts.update || f.assistantMessageEvent?.type === opts.update),
  );
  if (!frame) throw new Error(`Missing recorded Pi ${type}`);
  return structuredClone(frame);
}
