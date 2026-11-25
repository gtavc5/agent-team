import { expect, it } from "vitest";
import {
  authenticatePiRecoveryMessage,
  projectPiRecoveryContext,
  signPiRecoveryPrompt,
  type PiContextMessage,
} from "../../src/session/pi-recovery-context";

it("leaves ordinary context untouched and preserves tool-bearing and successful recovery turns", () => {
  const first = { role: "user", content: "ordinary prompt" };
  const failure = { role: "assistant", stopReason: "error", content: [], usage: { output: 0 } };
  const ordinary = [first, failure];
  expect(projectPiRecoveryContext(ordinary)).toBeUndefined();
  expect(ordinary).toStrictEqual([first, failure]);

  const recovery = (inputId: string, supersedes: string[] = []): PiContextMessage => ({
    role: "user",
    content: inputId,
    yaatRecovery: { inputId, outageId: "outage", supersedes },
  });
  const withTools = { role: "toolResult", content: "tool output" };
  const success = { role: "assistant", stopReason: "stop", content: [], usage: { output: 0 } };
  const toolPrompt = recovery("tool");
  const successfulPrompt = recovery("success");
  const newest = recovery("new", ["tool", "success"]);
  const context = [first, toolPrompt, withTools, failure, successfulPrompt, success, newest];
  expect(projectPiRecoveryContext(context)).toBeUndefined();
  expect(context).toStrictEqual([
    first,
    { role: "user", content: "tool" },
    withTools,
    failure,
    { role: "user", content: "success" },
    success,
    { role: "user", content: "new" },
  ]);
});

it("authenticates prompt content without swallowing Pi's image normalization hints", () => {
  const envelope = {
    inputId: "retry",
    text: "human input",
    recovery: { outageId: "outage", supersedes: ["previous"] },
  };
  const token = "test token";
  const signed = signPiRecoveryPrompt(envelope, token);
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
  const hint = "\n\n[Image omitted: could not be converted to a supported inline image format.]";
  expect(authenticatePiRecoveryMessage(user(signed + hint), token)).toEqual({
    ...user(envelope.text + hint),
    yaatRecovery: { ...envelope.recovery, inputId: envelope.inputId },
  });
  expect(authenticatePiRecoveryMessage(user(signed), "wrong token")).toBeUndefined();
  expect(
    authenticatePiRecoveryMessage(user(signed.replace("human", "other")), token),
  ).toBeUndefined();
});
