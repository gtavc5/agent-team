import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";
import { localPiBinary } from "../local-pi";
import { Server } from "../../src/server/server";
import { LocalHost } from "../../src/session/host";
import type { PiAvailableModel, UiDialogRequest, UiDialogResponse } from "../../src/session/types";
import { FakeSession } from "./fakes";

class Session extends FakeSession {
  models: PiAvailableModel[] = [];
  levels?: string[];
  setEffort(level: string) {
    this.getState().config.effort = level;
  }
  current?: UiDialogRequest;
  getAvailableModels() {
    return this.models;
  }
  getAvailableThinkingLevels() {
    return this.levels;
  }
  open(dialog: UiDialogRequest) {
    this.current = dialog;
    this.emit("ui_dialog_request", dialog);
  }
  reply = vi.fn<(value: UiDialogResponse) => void>();
  respondToUiDialog(id: string, value: UiDialogResponse) {
    if (this.current?.requestId !== id || typeof value.confirmed !== "boolean") return;
    const resolved = this.current;
    this.current = undefined;
    this.reply(value);
    this.emit("ui_dialog_resolved", resolved);
  }
}

async function connect(port: number, sockets: WebSocket[]) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(socket);
  const frames: Array<Record<string, unknown>> = [];
  socket.on("message", (body: RawData) => {
    const text = Buffer.isBuffer(body)
      ? body.toString()
      : (Array.isArray(body) ? Buffer.concat(body) : Buffer.from(body)).toString();
    frames.push(JSON.parse(text) as Record<string, unknown>);
  });
  await once(socket, "open");
  await vi.waitFor(() => expect(frames.some((f) => f.type === "init")).toBe(true));
  return { frames, send: (msg: object) => socket.send(JSON.stringify(msg)) };
}

describe("dynamic Pi capabilities over Server WebSocket", () => {
  it("isolates commands, merges runtime models, refreshes thinking levels and consumes one current dialog reply", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "yaat-dynamic-ws-"));
    fs.writeFileSync(path.join(base, "config.toml"), "[pi]\n");
    const catalog = vi.spyOn(LocalHost.prototype, "discoverPiModels").mockResolvedValue([
      {
        id: "provider/boot",
        provider: "provider",
        modelId: "boot",
        effortLevels: ["minimal", "xhigh"],
      },
    ]);
    const sessions = new Map<string, Session>();
    const create = vi
      .spyOn(LocalHost.prototype, "createSession")
      .mockImplementation((id, config) => {
        const s = new Session(config);
        sessions.set(id, s);
        return s;
      });
    const server = new Server(0, base, base);
    const sockets: WebSocket[] = [];
    try {
      const port = await server.listening;
      const one = await connect(port, sockets);
      expect(one.frames.find((f) => f.type === "init")?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "provider/boot", effortLevels: ["minimal", "xhigh"] }),
        ]),
      );
      one.send({ type: "create_project", root: null, cwd: base, name: "no git" });
      let workspaceId = "";
      await vi.waitFor(() => {
        const projects = one.frames.filter((f) => f.type === "project_updated");
        expect(projects).toHaveLength(1);
        const project = projects[0].project as {
          leadWorkspaceId: string;
          root: null;
          schemaVersion: number;
        };
        expect(project).toMatchObject({ root: null, schemaVersion: 2 });
        workspaceId = project.leadWorkspaceId;
      });
      one.send({
        type: "add_agent",
        workspaceId,
        name: "Invalid",
        model: "provider/boot",
        effort: "high",
        avatar: "",
        color: "",
      });
      await vi.waitFor(() =>
        expect(one.frames).toContainEqual({
          type: "error",
          message: "provider/boot has no effort high",
        }),
      );
      one.send({
        type: "add_agent",
        workspaceId,
        name: "Pi A",
        effort: "max",
        model: "provider/model-a",
        avatar: "",
        color: "",
      });
      one.send({
        type: "add_agent",
        workspaceId,
        name: "Pi B",
        model: "provider/model-b",
        avatar: "",
        color: "",
      });
      await vi.waitFor(() => expect(sessions.size).toBe(3));
      const [, [a, sa], [b, sb]] = [...sessions];
      const command = (content: string) =>
        one.send({ type: "send_message", workspaceId, target: a, content });
      command("/effort");
      await vi.waitFor(() =>
        expect(
          one.frames
            .filter((f) => f.type === "new_message")
            .map((f) => (f.message as { content: string }).content),
        ).toContain("Effort levels for provider/model-a are not yet known."),
      );
      expect(sa.getState().config.effort).toBe("max");
      command("/model provider/boot");
      command("/effort xhigh");
      await vi.waitFor(() =>
        expect(one.frames.filter((f) => f.type === "agent_updated").at(-1)?.agent).toMatchObject({
          id: a,
          effort: "xhigh",
          effortLevels: ["minimal", "xhigh"],
        }),
      );
      expect(sa.sent).toEqual([]);
      const model = (id: string) => ({
        id: `provider/${id}`,
        modelId: id,
        provider: "provider",
        name: id,
      });
      sa.models = [model("model-a")];
      sb.models = [model("model-b")];
      sa.emit("commands", [
        { source: "extension", name: "a-only" },
        { source: "skill", name: "model" },
        { source: "extension", name: "goal" },
      ]);
      sb.emit("commands", [{ source: "skill", name: "b-only" }]);
      await vi.waitFor(() =>
        expect(one.frames.filter((f) => f.type === "models_update").at(-1)?.models).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "provider/model-a", backend: "pi" }),
            expect.objectContaining({ id: "provider/model-b", backend: "pi" }),
          ]),
        ),
      );
      const commandFrames = one.frames.filter((f) => f.type === "agent_commands_update");
      expect(
        commandFrames.some(
          (frame) =>
            frame.workspaceId === workspaceId &&
            frame.agentId === a &&
            (frame.commands as Array<{ name: string }>).some((c) => c.name === "a-only"),
        ),
      ).toBe(true);
      sa.levels = ["low", "high"];
      sa.emit("thinking_levels");
      await vi.waitFor(() => {
        const update = one.frames
          .filter((f) => f.type === "agent_updated" && f.workspaceId === workspaceId)
          .at(-1);
        expect(update?.agent).toMatchObject({ id: a, effortLevels: ["low", "high"] });
      });
      one.send({ type: "send_message", workspaceId, target: a, content: "/goal status" });
      await vi.waitFor(() =>
        expect(
          one.frames.some(
            (f) =>
              f.type === "new_message" &&
              (f.message as { content: string }).content === "/goal is disabled.",
          ),
        ).toBe(true),
      );
      expect(sa.sent).toEqual([]);
      const dialog: UiDialogRequest = {
        workspaceId,
        agentId: a,
        processGeneration: 7,
        requestId: "same-request-id",
        method: "confirm",
        title: "Permission",
        timeoutMs: 1000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 1000,
      };
      const owner = { workspaceId, agentId: a, processGeneration: 7 };
      const status = { key: "progress", text: "Ready" };
      const uiSnapshot = [{ ...owner, statuses: [status], widgets: [] }];
      const notice = {
        ...owner,
        change: { kind: "notify", level: "info", id: "n", message: "hello" },
      };
      sa.emit("extension_ui", { ...owner, change: { kind: "status", ...status } });
      sa.emit("extension_ui", notice);
      sa.open(dialog);
      await vi.waitFor(() =>
        expect(one.frames).toContainEqual({ type: "ui_dialog_request", dialog }),
      );
      const two = await connect(port, sockets);
      const init = two.frames.find((f) => f.type === "init")!;
      expect(one.frames).toContainEqual({ type: "extension_ui", event: notice });
      expect(init.extensionUi).toEqual(uiSnapshot);
      expect(init.pendingDialogs).toEqual([dialog]);
      expect(init.models).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "provider/model-a" })]),
      );
      const commandMap = init.commandsByAgent as Record<
        string,
        Record<string, Array<{ name: string; source: string }>>
      >;
      expect(commandMap[workspaceId][a].map((c) => c.name)).toContain("a-only");
      expect(commandMap[workspaceId][a].map((c) => c.name)).not.toContain("b-only");
      expect(commandMap[workspaceId][b].map((c) => c.name)).toContain("b-only");
      expect(commandMap[workspaceId][a].map((c) => c.name)).not.toContain("goal");
      expect(
        commandMap[workspaceId][a].filter((c) => c.name === "model").map((c) => c.source),
      ).toEqual(["panel", "skill"]);
      two.send({ type: "open_workspace", workspaceId });
      await vi.waitFor(() =>
        expect(two.frames).toContainEqual(
          expect.objectContaining({
            type: "workspace_messages",
            pendingDialogs: [dialog],
            extensionUi: uiSnapshot,
          }),
        ),
      );
      const reply = {
        type: "ui_dialog_response",
        workspaceId,
        agentId: a,
        requestId: dialog.requestId,
      };
      one.send({ ...reply, processGeneration: 6, confirmed: false });
      one.send({ ...reply, processGeneration: 7, value: "invalid confirm" });
      one.send({ ...reply, processGeneration: 7, confirmed: true });
      two.send({ ...reply, processGeneration: 7, confirmed: true });
      for (const client of [one, two]) {
        await vi.waitFor(() =>
          expect(client.frames.filter((f) => f.type === "ui_dialog_resolved")).toEqual([
            {
              type: "ui_dialog_resolved",
              workspaceId,
              agentId: a,
              processGeneration: 7,
              requestId: dialog.requestId,
            },
          ]),
        );
      }
      expect(sa.reply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ confirmed: true }),
      );
      one.send({ type: "remove_agent", workspaceId, agentId: a });
      await vi.waitFor(() =>
        expect(one.frames).toContainEqual({
          type: "agent_commands_update",
          workspaceId,
          agentId: a,
          commands: [],
        }),
      );
      const three = await connect(port, sockets);
      const again = three.frames.find((f) => f.type === "init")!;
      expect((again.commandsByAgent as typeof commandMap)[workspaceId][a]).toBeUndefined();
      expect(again.extensionUi).toEqual([]);
      expect(again.pendingDialogs).toEqual([]);
    } finally {
      for (const socket of sockets) socket.terminate();
      await server.close();
      create.mockRestore();
      catalog.mockRestore();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it.skipIf(!localPiBinary)(
    "round trips an actual Pi extension_ui_request with two WebSocket clients",
    roundTripPiDialog,
    30_000,
  );

  async function roundTripPiDialog() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "yaat-real-dialog-"));
    fs.writeFileSync(path.join(base, "config.toml"), "");
    const home = path.join(base, "pi-home");
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "settings.json"), '{"packages":[]}');
    const extension = path.join(base, "confirm.mjs");
    const answers = path.join(base, "answers");
    fs.writeFileSync(
      extension,
      `import fs from "node:fs";
export default (pi) => {
  pi.on("input", async (_event, ctx) => {
    const accepted = await ctx.ui.confirm("Real Pi confirmation", "Confirm once", { timeout: 5000 });
    fs.appendFileSync(${JSON.stringify(answers)}, JSON.stringify(accepted));
    return { action: "handled" };
  });
};`,
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The wrapper supplies the actual LocalHost receiver.
    const createSession = LocalHost.prototype.createSession;
    const create = vi.spyOn(LocalHost.prototype, "createSession").mockImplementation(function (
      this: LocalHost,
      id,
      config,
    ) {
      return createSession.call(
        this,
        id,
        config.backend === "pi"
          ? {
              ...config,
              model: undefined,
              piAgentDir: home,
              piArgs: ["-e", extension],
              piBinary: localPiBinary,
            }
          : config,
      );
    });
    const server = new Server(0, base, base);
    const sockets: WebSocket[] = [];
    try {
      const port = await server.listening;
      const one = await connect(port, sockets);
      one.send({ type: "create_project", root: null, name: "dialog project" });
      let workspaceId = "";
      await vi.waitFor(() => {
        const project = one.frames.find((f) => f.type === "project_updated")?.project as
          { leadWorkspaceId: string } | undefined;
        expect(project).toBeDefined();
        workspaceId = project!.leadWorkspaceId;
      });
      one.send({
        type: "add_agent",
        workspaceId,
        name: "Pi Dialog",
        model: "demo/model",
        avatar: "",
        color: "",
      });
      let agentId = "";
      await vi.waitFor(() => {
        const entry = one.frames.find(
          (f) => f.type === "agent_added" && (f.agent as { name: string }).name === "Pi Dialog",
        );
        expect(entry).toBeDefined();
        agentId = (entry!.agent as { id: string }).id;
      });
      one.send({ type: "send_message", workspaceId, target: agentId, content: "prompt" });
      await vi.waitFor(
        () => expect(one.frames.some((f) => f.type === "ui_dialog_request")).toBe(true),
        { timeout: 10_000 },
      );
      const dialog = one.frames.find((f) => f.type === "ui_dialog_request")!
        .dialog as UiDialogRequest;
      expect(dialog).toMatchObject({
        workspaceId,
        agentId,
        title: "Real Pi confirmation",
        method: "confirm",
      });
      const two = await connect(port, sockets);
      expect(two.frames.find((f) => f.type === "init")?.pendingDialogs).toEqual([dialog]);
      const reply = {
        type: "ui_dialog_response",
        workspaceId,
        agentId,
        requestId: dialog.requestId,
        processGeneration: dialog.processGeneration,
        confirmed: true,
      };
      one.send(reply);
      two.send(reply);
      await vi.waitFor(() => expect(fs.readFileSync(answers, "utf8")).toBe("true"));
      await vi.waitFor(() =>
        expect(one.frames.filter((f) => f.type === "ui_dialog_resolved")).toHaveLength(1),
      );
    } finally {
      for (const socket of sockets) socket.terminate();
      await server.close();
      create.mockRestore();
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
});
