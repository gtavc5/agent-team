import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcMessage } from "../../../src/session/codex-rpc";

type Fields = Record<string, unknown>;
const samples = new Map<string, Fields>();
for (const fixture of [
  "steer",
  "resume",
  "interrupt",
  "tools",
  "commands",
  "bad-model",
  "usage-limit",
  "steer-interrupt",
]) {
  const file = join(__dirname, "../../snap/codex", `${fixture}.jsonl`);
  const pending = new Map<RpcMessage["id"], string>();
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    const { sent, frame } = JSON.parse(line) as { sent?: RpcMessage; frame?: RpcMessage };
    if (sent?.method && sent.id != null) pending.set(sent.id, sent.method);
    if (!frame) continue;
    const key = frame.method ?? pending.get(frame.id);
    const fields = frame.method ? frame.params : frame.result;
    if (key && fields) {
      const data = fields as Fields;
      if (!samples.has(key)) samples.set(key, data);
      const item = data.item as Fields | undefined;
      if (typeof item?.type === "string" && !samples.has(`${key}:${item.type}`))
        samples.set(`${key}:${item.type}`, data);
    }
    if (!frame.method) pending.delete(frame.id);
  }
}

// Fresh copy: race tests can rebind identities or inject an error without
// inventing the successful, version-specific part of a Codex envelope.
export function codexFields(method: string): Fields {
  const sample = samples.get(method);
  if (!sample) throw new Error(`Missing recorded Codex method: ${method}`);
  return structuredClone(sample);
}

export function withId(method: string, field: "thread" | "turn", id: unknown, extra: Fields = {}) {
  const sample = codexFields(method);
  return { ...sample, [field]: { ...(sample[field] as Fields), id, ...extra } };
}
