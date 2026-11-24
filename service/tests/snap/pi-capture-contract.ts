// Reject incomplete or inconsistent live evidence before replacing a tape.
import { isDeepStrictEqual } from "node:util";
import type { PiFrame } from "./fixture.ts";

export function steerReceipt(frame: PiFrame): PiFrame {
  const expected = {
    type: "response",
    id: frame.id,
    command: "steer",
    success: true,
    data: { disposition: "queued" },
  };
  if (typeof frame.id !== "string" || !isDeepStrictEqual(frame, expected))
    throw new Error("Unreviewed steer response");
  return { ...frame, id: "request" };
}

export function validateTurn(name: string, frames: PiFrame[]) {
  const has = (type: string) => frames.some((f) => f.type === type);
  const settled = frames.filter((f) => f.type === "agent_settled");
  const update = (type: string) =>
    frames.some((f) => (f.assistantMessageEvent as PiFrame | undefined)?.type === type);
  const require = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`Incomplete ${name} capture: ${what}`);
  };
  require(settled.length === (name === "single-queue-order" ? 3 : 1), "settlement");
  require(settled.every((f) => f.aborted === (name === "interrupt-abort")), "abort outcome");
  if (name === "basic-turn" || name === "antigravity-acp-turn" || name === "extension-ui-dialog")
    require(update("thinking_start") && update("thinking_end"), "thinking block");
  if (name === "extension-ui-dialog") require(has("extension_ui_request"), "dialog");
  if (name === "image-prompt")
    require(frames.some((f) =>
      (f.message as { content?: PiFrame[] } | undefined)?.content?.some?.(
        (b) => b.type === "image",
      ),
    ), "image");
  const tools = frames.filter((f) => f.type === "tool_execution_start");
  if (name === "antigravity-acp-turn" || name === "tools-bash-edit") {
    require(isDeepStrictEqual(
      tools.map((f) => f.toolName),
      name === "tools-bash-edit" ? ["bash", "read", "edit", "grep"] : ["read"],
    ), "tool calls");
    for (const f of tools) {
      require(frames.some(
        (end) =>
          end.type === "tool_execution_end" &&
          end.toolCallId === f.toolCallId &&
          end.isError === false,
      ), "tool success");
      const done = frames
        .map((m) => (m.assistantMessageEvent as { toolCall?: PiFrame } | undefined)?.toolCall)
        .find((c) => c?.id === f.toolCallId);
      require(!!done && isDeepStrictEqual(f.args, done.arguments), "toolcall_end arguments");
      const messageCalls = frames
        .filter((e) => e.type === "message_end")
        .flatMap((e) => {
          const content = (e.message as { content?: PiFrame[] }).content;
          return Array.isArray(content)
            ? content.filter((c) => c.type === "toolCall" && c.id === f.toolCallId)
            : [];
        });
      require(messageCalls.some((c) =>
        isDeepStrictEqual(f.args, c.arguments),
      ), "finalized tool arguments");
      if (f.toolName === "edit")
        require((f.args as { edits: { oldText: string; newText: string }[] }).edits.some(
          (e) => e.oldText !== e.newText,
        ), "distinct edit operands");
    }
  }
}
