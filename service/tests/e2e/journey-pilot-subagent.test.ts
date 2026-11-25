import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { assertRedactedCorpus, type AnonCorpus } from "../../../scripts/export-anon-corpus";
import { ProjectStore } from "../../src/project/store";
import { PiRpcClient } from "../../src/session/pi-rpc";
import type { Message, WorkspaceState } from "../../src/workspace/workspace";
import { loadFixture, readRecording, recordingPath, replay } from "../snap/harness";
import {
  expectBounded,
  expectEquivalent,
  stableGeometry,
  transcriptState,
  waitForState,
} from "./pilot-assertions";
import { pilotBrowser, refreshSession, sandboxAgent, selectSession } from "./pilot-browser";

it("keeps the reading anchor, width and child transcript stable across toggles, switches and reconnect", async () => {
  const corpus = JSON.parse(
    readFileSync(new URL("../corpus/anon-pilot.jsonl", import.meta.url), "utf8"),
  ) as AnonCorpus;
  assertRedactedCorpus(corpus);
  const name = "pi-subagents-foreground";
  const fixture = await loadFixture("pi", name);
  const projected = await replay("pi", readRecording(recordingPath("pi", name)), fixture);
  fixture.verify?.(projected);
  // The tape projects through PiSession and Workspace first; the browser loads
  // that result through real persisted history and the production detail fetch.
  const reply = projected.messages.find((m) => m.events?.some((e) => e.kind === "subagent_start"))!;
  const child = reply.events!.find((e) => e.kind === "subagent_start")!.subagent!;
  expect(child.events?.map(({ kind, content }) => [kind, content])).toEqual([
    ["text", "x".repeat(18)],
  ]);
  const cached = corpus.workspaces.at(-1)!.messages[0] as unknown as Message;
  expect(cached.events).toHaveLength(35);
  expect(
    cached.events?.some((e) => e.kind === "subagent_start" && !!e.subagent?.events?.length),
  ).toBe(true);
  const switches = corpus.telemetry.filter(({ action }) => action === "workspace.switch");
  expect(switches.length).toBeGreaterThan(corpus.telemetry.length / 2);

  await pilotBrowser(
    (root) => {
      vi.spyOn(PiRpcClient, "spawn").mockImplementation(() => {
        throw new Error("Unexpected Pi start in archival replay");
      });
      const project = new ProjectStore(root);
      project.save({
        schemaVersion: 2,
        status: "active",
        id: "trace-pilot",
        name: "Trace pilot",
        root,
        createdAt: 1,
        lead: { hostId: "local", workspaceId: "pilot-0" },
        leadWorkspaceId: "pilot-0",
      });
      const directories = new Map<unknown, string>();
      return corpus.workspaces.map(({ metadata, messages }, i) => {
        if (!directories.has(metadata.cwd)) {
          const cwd = join(root, `树 worktree ${directories.size}`);
          mkdirSync(cwd);
          directories.set(metadata.cwd, cwd);
        }
        const cwd = directories.get(metadata.cwd)!;
        const agent = sandboxAgent(root, cwd, `pilot-agent-${i}`);
        const history =
          i === 0
            ? projected.messages
            : i === 1
              ? [
                  {
                    id: "switch-anchor",
                    kind: "user",
                    agentId: null,
                    status: "done",
                    timestamp: 2,
                    content: "Other pilot session",
                  } satisfies Message,
                ]
              : (messages as unknown as Message[]);
        return {
          ...(metadata as unknown as WorkspaceState),
          id: `pilot-${i}`,
          name: i === 0 ? "Trace reader" : i === 1 ? "Switch target" : `Archived ${i}`,
          project: "Trace pilot",
          hostId: "local",
          cwd,
          normalizedCwd: cwd,
          projectLink: { projectId: "trace-pilot", role: i === 0 ? "lead" : "worker" },
          agents: [agent],
          messages: history.map((message) => ({
            ...message,
            agentId: message.agentId ? agent.id : null,
          })),
        };
      });
    },
    async (page, server) => {
      const messages = page.locator(".messages");
      const replyRow = messages.locator(`#msg-${reply.id}`);
      const cards = replyRow.locator(".subagent-item");
      const card = cards.first();
      const expand = card.getByRole("button", { name: /^Expand subagent:/ });
      const collapse = card.getByRole("button", { name: "Collapse subagent trace" });
      const details = card.locator(".subagent-details");
      await expand.waitFor();
      await page.evaluate("document.fonts.ready.then(() => undefined)");
      const collapsed = await transcriptState(page);
      expect(
        collapsed.rows.flatMap(({ subagents }) => subagents).map(({ status }) => status),
      ).toEqual(["subagent-item subagent-completed", "subagent-item subagent-completed"]);
      const geometry = () => stableGeometry(page, `#msg-${reply.id} .subagent-item`);
      const baseline = await geometry();
      let detailText: string | undefined;
      let expandedCeiling: number | undefined;
      const nodes = () => messages.locator("*").count();
      const collapsedCeiling = await nodes();
      const wasStored = () =>
        server["workspaces"]
          .get("pilot-0")!
          .getMessages()
          .find((m) => m.id === reply.id)!.events;
      const stored = structuredClone(wasStored());

      for (const _ of switches.slice(0, 4)) {
        expect(await geometry()).toEqual(baseline);
        await expand.click();
        const transcript = details.getByText("x".repeat(18), { exact: true });
        await transcript.waitFor();
        expect(await transcript.count()).toBe(1);
        expect(await geometry()).toEqual(baseline);
        expect(await details.locator(".subagent-events > *").count()).toBe(child.events!.length);
        detailText ??= await details.innerText();
        expect(await details.innerText()).toBe(detailText);
        expandedCeiling ??= await nodes();
        expectBounded(await nodes(), expandedCeiling, "expanded transcript DOM");
        await collapse.click();
        await details.waitFor({ state: "detached" });
        expect(await geometry()).toEqual(baseline);
        expectBounded(await nodes(), collapsedCeiling, "collapsed transcript DOM");
        if (
          !(await page.locator(".sidebar").getByText("Switch target", { exact: true }).isVisible())
        ) {
          await page.locator(".ws-idle-toggle[aria-expanded=false]").click();
        }
        await selectSession(page, "Switch target");
        await messages.getByText("Other pilot session", { exact: true }).waitFor();
        expect(await messages.locator(".subagent-item").count()).toBe(0);
        await page.locator(".ws-group-project").getByText("Trace pilot", { exact: true }).click();
        await expand.waitFor();
        await expectEquivalent(page, collapsed);
        expect(wasStored()).toEqual(stored);
      }

      const reconnect = page.waitForEvent("websocket");
      for (const socket of server["wss"].clients) socket.close(1000, "Pilot reconnect");
      const socket = await reconnect;
      await socket.waitForEvent("framereceived", {
        predicate: ({ payload }) => {
          const frame = JSON.parse(payload.toString()) as { type: string; workspaceId?: string };
          return frame.type === "workspace_messages" && frame.workspaceId === "pilot-0";
        },
        timeout: 6_000,
      });
      await expectEquivalent(page, collapsed);
      await refreshSession(page, () => expand.waitFor());
      await expectEquivalent(page, collapsed);
      await page.evaluate("document.fonts.ready.then(() => undefined)");
      expect(await geometry()).toEqual(baseline);
      await expand.click();
      await waitForState(
        "child detail after refresh",
        () => details.innerText(),
        (text) => text === detailText,
      );
      expectBounded(await nodes(), expandedCeiling!, "refreshed transcript DOM");
      expect(wasStored()).toEqual(stored);

      await page.locator(".ws-archive-toggle").click();
      const archives = page.locator(".task-item-archived");
      expect(await archives.count()).toBe(3);
      expect(
        new Set(await archives.evaluateAll((rows) => rows.map((row) => row.getAttribute("title"))))
          .size,
      ).toBe(3);
      await selectSession(page, "Archived 4");
      const archived = page.locator(".messages .message-agent");
      await archived.filter({ has: page.locator(".subagent-item") }).waitFor();
      const persisted = server["workspaces"].get("pilot-4")!.getMessages();
      expect(persisted).toHaveLength(1);
      expect(persisted[0].events?.map(({ kind }) => kind)).toEqual(
        cached.events?.map(({ kind }) => kind),
      );
    },
  );
}, 45_000);
