import { createHmac, timingSafeEqual } from "node:crypto";
import type { PromptEnvelope } from "./types";

type RecoveryInput = NonNullable<PromptEnvelope["recovery"]> & { inputId: string };

export interface PiContextMessage {
  role: string;
  content?: unknown;
  stopReason?: string;
  usage?: { output?: number };
  yaatRecovery?: RecoveryInput;
}

const marker = "[YAAT recovery v1 ";
const signature = (token: string, encoded: string, text: string) =>
  createHmac("sha256", token).update(`${marker}${encoded}]\n${text}`).digest();

export function signPiRecoveryPrompt(envelope: PromptEnvelope, token: string): string {
  if (!envelope.recovery) return envelope.text;
  const meta = {
    ...envelope.recovery,
    inputId: envelope.inputId,
    textLength: envelope.text.length,
  };
  const encoded = Buffer.from(JSON.stringify(meta)).toString("base64url");
  const mac = signature(token, encoded, envelope.text).toString("hex");
  return `${marker}${encoded}.${mac}]\n${envelope.text}`;
}

// Pi applies the replacement to agent state before persisting the user message. Only
// authenticated RPC input becomes metadata; neither the marker nor the MAC is stored.
export function authenticatePiRecoveryMessage(
  message: PiContextMessage,
  token: string,
): PiContextMessage | undefined {
  if (message.role !== "user" || !Array.isArray(message.content)) return;
  const [first, ...rest] = message.content as [
    { type?: string; text?: unknown } | undefined,
    ...unknown[],
  ];
  if (first?.type !== "text" || typeof first.text !== "string" || !first.text.startsWith(marker))
    return;
  const header = /^\[YAAT recovery v1 ([\w-]+)\.([a-f0-9]{64})\]\n/.exec(first.text);
  if (!header) return;
  const [, encoded, mac] = header;
  const text = first.text.slice(header[0].length);
  let payload: RecoveryInput & { textLength: number };
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString()) as typeof payload;
  } catch {
    return;
  }
  if (!payload || !Number.isSafeInteger(payload.textLength) || payload.textLength < 0) return;
  const { textLength, ...yaatRecovery } = payload;
  // Pi may append image conversion or omission hints after the signed prompt.
  if (text.length !== textLength && !text.slice(textLength).startsWith("\n\n[Image")) return;
  if (
    !timingSafeEqual(signature(token, encoded, text.slice(0, textLength)), Buffer.from(mac, "hex"))
  )
    return;
  return { ...message, content: [{ ...first, text }, ...rest], yaatRecovery };
}

export function projectPiRecoveryContext(
  messages: PiContextMessage[],
): PiContextMessage[] | undefined {
  const prior = new Map<string, { outageId: string; start: number; end: number }>();
  const omitted = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "user" || !message.yaatRecovery) continue;
    const { outageId, inputId, supersedes } = message.yaatRecovery;
    // `context` receives copies; remove private metadata without replacing a message
    // or array on an otherwise unchanged request (Pi preserves its cached prefix).
    delete message.yaatRecovery;
    for (const id of supersedes) {
      const turn = prior.get(id);
      if (turn?.outageId !== outageId) continue;
      for (let j = turn.start; j < turn.end; j++) omitted.add(j);
    }
    if (i === 0) continue;
    let end = i + 1;
    while (messages[end] && messages[end].role !== "user") end++;
    if (end === i + 1) continue;
    const failedWithoutOutput = messages
      .slice(i + 1, end)
      .every(
        (reply) =>
          reply.role === "assistant" &&
          reply.stopReason === "error" &&
          reply.usage?.output === 0 &&
          Array.isArray(reply.content) &&
          reply.content.length === 0,
      );
    if (failedWithoutOutput) prior.set(inputId, { outageId, start: i, end });
  }
  if (omitted.size) return messages.filter((_, i) => !omitted.has(i));
}
