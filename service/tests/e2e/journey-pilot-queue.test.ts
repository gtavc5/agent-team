import { expect, it, vi } from "vitest";
import { PiRpcClient } from "../../src/session/pi-rpc";
import { PiRpcPlayer } from "../snap/harness";
import { playPi, queueTape } from "../snap/queue-tape";
import { expectEquivalent, transcriptState } from "./pilot-assertions";
import { pilotBrowser, pilotModel, refreshSession, sandboxAgent } from "./pilot-browser";

it("sends, cancels only the chosen queued turn, and receives the survivor across refresh", async () => {
  const { first, second, firstResponse, prompt, reply } = queueTape();
  const cancelledText = prompt(2);
  let player: PiRpcPlayer | undefined;
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
        await send(prompt(0));
        await playPi(player!, first.slice(0, firstResponse));
        const survivor = prompt(1);
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
        await playPi(player!, first.slice(firstResponse));
        await playPi(player!, second);
        await remove(survivor).waitFor({ state: "detached" });
        await messages.locator(".message-agent").getByText(reply, { exact: true }).waitFor();
        expect(
          player!.sent.filter(({ type }) => type === "prompt").map(({ message }) => message),
        ).toEqual([prompt(0), survivor]);
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
