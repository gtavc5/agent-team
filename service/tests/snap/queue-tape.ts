import { expect } from "vitest";
import { type PiFrame, PiRpcPlayer, readRecording, recordingPath } from "./harness";

type PiOp = { sent: PiFrame } | { frame: PiFrame };

export function piOps(name: string): PiOp[] {
  return readRecording(recordingPath("pi", name)).entries.flatMap<PiOp>((entry) =>
    "sent" in entry
      ? [{ sent: entry.sent as PiFrame }]
      : "frame" in entry
        ? [{ frame: entry.frame as PiFrame }]
        : [],
  );
}

export function recordedPrompt(entry: PiOp) {
  if (!("sent" in entry) || entry.sent.type !== "prompt" || typeof entry.sent.message !== "string")
    throw new Error("Missing recorded prompt");
  return entry.sent.message;
}

export function queueTape() {
  const ops = piOps("single-queue-order");
  const turns = ops.flatMap((entry, i) =>
    "sent" in entry && entry.sent.type === "prompt" ? [i] : [],
  );
  expect(turns).toHaveLength(3);
  const first = ops.slice(turns[0], turns[1]);
  const second = ops.slice(turns[1], turns[2]);
  const assistant = (entry: PiOp, event: string) => {
    if (!("frame" in entry) || entry.frame.type !== event) return;
    const message = entry.frame.message as {
      role: string;
      content: { type: string; text?: string }[];
    };
    if (message.role === "assistant") return message;
  };
  const firstResponse = first.findIndex((entry) => assistant(entry, "message_start"));
  expect(firstResponse).toBeGreaterThan(0);
  const lastReply = [...second].reverse().find((entry) => assistant(entry, "message_end"));
  const reply =
    lastReply &&
    assistant(lastReply, "message_end")?.content.find(({ type }) => type === "text")?.text;
  if (!reply) throw new Error("Missing recorded reply");
  return {
    first,
    second,
    firstResponse,
    prompt: (i: number) => recordedPrompt(ops[turns[i]]),
    reply,
  };
}

export async function playPi(player: PiRpcPlayer, entries: PiOp[]) {
  for (const entry of entries) {
    if ("sent" in entry) await player.expect(entry.sent);
    else player.play(entry.frame);
  }
}
