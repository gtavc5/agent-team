import { expect, it, vi } from "vitest";
import { PiRpcClient } from "../../src/session/pi-rpc";
import {
  type Entry,
  type PiFrame,
  PiRpcPlayer,
  readRecording,
  recordingPath,
} from "../snap/harness";
import { expectEquivalent, transcriptState } from "./pilot-assertions";
import { pilotBrowser, pilotModel, refreshSession, sandboxAgent } from "./pilot-browser";

it("sends, cancels only the chosen queued turn, and receives the survivor across refresh", async () => {
  const tape = readRecording(recordingPath("pi", "single-queue-order"));
  const tapeOps = tape.entries.filter((entry) => "sent" in entry || "frame" in entry);
  const turnStarts = tapeOps.flatMap((entry, i) =>
    "sent" in entry && (entry.sent as PiFrame).type === "prompt" ? [i] : [],
  );
  expect(turnStarts).toHaveLength(3);
  const first = tapeOps.slice(turnStarts[0], turnStarts[1]);
  const second = tapeOps.slice(turnStarts[1], turnStarts[2]);
  const responseStarts = (entries: Entry[]) =>
    entries.findIndex(
      (entry) =>
        "frame" in entry &&
        (entry.frame as PiFrame).type === "message_start" &&
        ((entry.frame as PiFrame).message as { role?: string }).role === "assistant",
    );
  const firstResponse = responseStarts(first);
  expect(firstResponse).toBeGreaterThan(0);
  const sendText = (entry: Entry) =>
    "sent" in entry ? String((entry.sent as PiFrame).message) : "";
  const cancelledText = sendText(tapeOps[turnStarts[2]]);
  let player: PiRpcPlayer | undefined;
  async function play(entries: Entry[]) {
    for (const entry of entries) {
      if ("sent" in entry) await player!.expect(entry.sent as PiFrame);
      else if ("frame" in entry) player!.play(entry.frame as PiFrame);
    }
  }
  try {
    await pilotBrowser(
      (root) => {
        player = new PiRpcPlayer(root, pilotModel, 100_000);
        vi.spyOn(PiRpcClient, "spawn").mockImplementation((options) => player!.connect(options!));
        return [
          {
            id: "queue-pilot",
            name: "Queue pilot",
            project: "Queue pilot",
            hostId: "local",
            cwd: root,
            createdAt: 1,
            agents: [sandboxAgent(root, root)],
            messages: [
              {
                id: "queue-anchor",
                kind: "user",
                agentId: null,
                status: "done",
                timestamp: 2,
                content: "Queue pilot ready",
              },
            ],
          },
        ];
      },
      async (page) => {
        const messages = page.locator(".messages");
        await messages.getByText("Queue pilot ready", { exact: true }).waitFor();
        const composer = page.locator("textarea.chat-input");
        const send = async (text: string) => {
          expect(text).not.toBe("");
          await composer.fill(text);
          await composer.press("Enter");
          await messages.getByText(text, { exact: true }).waitFor();
        };
        const row = (text: string) => messages.locator(".message-user").filter({ hasText: text });
        const remove = (text: string) => row(text).getByTitle("Remove from queue", { exact: true });
        await send(sendText(first[0]));
        await play(first.slice(0, firstResponse));
        const survivor = sendText(second[0]);
        await send(survivor);
        await send(cancelledText);
        await remove(survivor).waitFor();
        await remove(cancelledText).waitFor();
        expect(await row(cancelledText).locator(".queued-badge").innerText()).toMatch(/^queued\b/);
        expect(await row(cancelledText).getAttribute("class")).toContain("message-queued");
        await remove(cancelledText).click();
        await row(cancelledText).waitFor({ state: "detached" });
        expect(player!.sent.filter(({ type }) => type === "prompt")).toHaveLength(1);
        const pending = await transcriptState(page);
        expect(pending.rows.filter(({ canRemove }) => canRemove)).toHaveLength(1);
        await refreshSession(page, () => remove(survivor).waitFor());
        await expectEquivalent(page, pending);
        await play(first.slice(firstResponse));
        await play(second);
        await remove(survivor).waitFor({ state: "detached" });
        const lastReply = [...second]
          .reverse()
          .find((entry) => "frame" in entry && (entry.frame as PiFrame).type === "message_end");
        if (!lastReply || !("frame" in lastReply)) throw new Error("Missing recorded reply");
        const recorded = (
          lastReply.frame as { message: { content: { type: string; text: string }[] } }
        ).message.content;
        const reply = recorded.find(({ type }) => type === "text")?.text;
        expect(reply).toBeTruthy();
        await messages.locator(".message-agent").getByText(reply!, { exact: true }).waitFor();
        expect(
          player!.sent.filter(({ type }) => type === "prompt").map(({ message }) => message),
        ).toEqual([sendText(first[0]), survivor]);
        await player!.finish();
        const settled = await transcriptState(page);
        expect(settled.rows.filter(({ canRemove }) => canRemove)).toHaveLength(0);
        await refreshSession(page, () => row(survivor).waitFor());
        await expectEquivalent(page, settled);
      },
    );
  } finally {
    player?.close();
  }
}, 45_000);
