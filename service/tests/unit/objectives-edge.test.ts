// Objective files under adversarial text, hand edits and racing writes.
import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import fsModule from "fs";
import * as path from "path";
import { syncBuiltinESMExports } from "module";
import { parse, serialize, type Objective } from "../../src/project/objectives";
import { setupProjects as setup } from "./projectHarness";

const base = (over: Partial<Objective> = {}): Objective => ({
  id: "a/b",
  area: "a",
  title: "t",
  goal: "g",
  status: "active",
  priority: "normal",
  dependsOn: [],
  tasks: [],
  decisions: [],
  sessions: [],
  updatedAt: Date.parse("2026-01-01T00:00:00Z"),
  ...over,
});

const objDir = (b: string, projectId: string, area: string) =>
  path.join(b, ".agent-team", "projects", projectId, "objectives", area);

describe("serializer round-trip", () => {
  it('multi-line text ending in """ (a python docstring) reads back', () => {
    for (const s of ['def f():\n    """doc"""', 'x\n""""""']) {
      expect(parse("a/b", serialize(base({ notes: s }))).notes).toBe(s);
    }
  });

  it("single-line text with DEL or a lone surrogate reads back", () => {
    expect(() => parse("a/b", serialize(base({ title: "a\u007fb" })))).not.toThrow();
    expect(() => parse("a/b", serialize(base({ title: "a\ud800b" })))).not.toThrow();
  });

  it('through the tool: notes ending in """ leave the objective readable', async () => {
    const { create, call } = setup();
    const { lead } = create("p");
    await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
    await call(lead, "write_objective", { id: "a/x", notes: 'Example:\n"""' });
    await expect(call(lead, "read_objective", { id: "a/x" })).resolves.toContain("Example");
  });
});

describe("write_objective guards", () => {
  it('title "" on an existing objective does not make it unreadable', async () => {
    const { create, call } = setup();
    const { lead } = create("p");
    await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
    await call(lead, "write_objective", { id: "a/x", title: "" }).catch(() => "refused");
    await expect(call(lead, "read_objective", { id: "a/x" })).resolves.toContain("a/x");
  });

  it("a cycle made by hand elsewhere does not block an unrelated write", async () => {
    const { create, call, base: b } = setup();
    const { project, lead } = create("p");
    await call(lead, "write_objective", { id: "a/p", title: "p", goal: "g" });
    await call(lead, "write_objective", { id: "a/q", title: "q", goal: "g" });
    await call(lead, "write_objective", {
      id: "a/x",
      title: "x",
      goal: "g",
      depends_on: ["a/p"],
    });
    // The user makes p and q depend on each other by hand.
    const dir = objDir(b, project.id, "a");
    for (const [f, dep] of [
      ["p", "a/q"],
      ["q", "a/p"],
    ]) {
      const file = path.join(dir, `${f}.toml`);
      fs.writeFileSync(
        file,
        fs.readFileSync(file, "utf-8").replace("depends_on = []", `depends_on = ["${dep}"]`),
      );
    }
    // The lead only lowers x's priority.
    await expect(
      call(lead, "write_objective", { id: "a/x", priority: "low", reason: "not now" }),
    ).resolves.toContain("Updated a/x");
  });
});

describe("hand edits", () => {
  it("tasks added by hand without an id get ids that do not collide", async () => {
    const { create, call, base: b, objectives } = setup();
    const { project, lead } = create("p");
    await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
    await call(lead, "add_items", { objective_id: "a/x", tasks: ["one", "two"] });
    // The user deletes t1 and appends a task without an id.
    const file = path.join(objDir(b, project.id, "a"), "x.toml");
    const text = fs.readFileSync(file, "utf-8");
    fs.writeFileSync(
      file,
      text.replace(/\n\[\[tasks\]\]\nid = "t1"[^[]*/, "\n") + '\n[[tasks]]\ntext = "by hand"\n',
    );
    const ids = objectives()[0].tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("an Emacs lock file (dangling .#x.toml symlink) does not break the board or throw from the watcher", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const errors: unknown[] = [];
    const listeners = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    process.on("uncaughtException", (e) => errors.push(e));
    try {
      const { create, call, base: b, manager } = setup();
      const { project, lead } = create("p");
      await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
      await vi.advanceTimersByTimeAsync(250);
      fs.symlinkSync("editor@host.example:456", path.join(objDir(b, project.id, "a"), ".#x.toml"));
      await vi.advanceTimersByTimeAsync(250);
      expect(() => manager.list()).not.toThrow();
    } finally {
      vi.useRealTimers();
      process.removeAllListeners("uncaughtException");
      for (const l of listeners) process.on("uncaughtException", l);
    }
    expect(errors.map(String)).toEqual([]);
  });

  it("an unknown key added by hand is reported instead of vanishing on the next write", async () => {
    const { create, call, base: b } = setup();
    const { project, lead } = create("p");
    await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
    const file = path.join(objDir(b, project.id, "a"), "x.toml");
    fs.appendFileSync(file, 'depends = ["a/y"]\n');
    await expect(call(lead, "write_objective", { id: "a/x", priority: "high" })).rejects.toThrow(
      "unknown key depends",
    );
    expect(fs.readFileSync(file, "utf-8")).toContain("depends = ");
  });

  it("a hand edit reaches the board after the lead has written the file twice", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    try {
      const { create, call, base: b, frames } = setup();
      const { project, lead } = create("p");
      // Tool calls come one at a time, with the watcher interval running in between.
      await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
      await vi.advanceTimersByTimeAsync(250);
      await call(lead, "add_items", { objective_id: "a/x", tasks: ["one"] });
      await vi.advanceTimersByTimeAsync(250);
      frames.length = 0;
      const file = path.join(objDir(b, project.id, "a"), "x.toml");
      fs.writeFileSync(
        file,
        fs.readFileSync(file, "utf-8").replace('title = "x"', 'title = "HAND"'),
      );
      await vi.advanceTimersByTimeAsync(250);
      const seen = frames.some(
        (f) =>
          f.type === "project_updated" &&
          (f.project as { objectives: Array<{ title?: string }> }).objectives.some(
            (o) => o.title === "HAND",
          ),
      );
      expect(seen).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Two writes in the same timestamp tick (coarse-mtime filesystems: older
// kernels at HZ=250, 9p/drvfs, NFS) give the file the mtime list() cached
// after the first. Forced here: every rename lands on the same mtime.
describe("the list cache", () => {
  it("finish_task does not revert an update the lead made just before", async () => {
    const { create, call, workers, objectives } = setup();
    const { lead } = create("p");
    await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
    await call(lead, "add_items", { objective_id: "a/x", tasks: ["one", "two"] });
    const cjs = fsModule;
    const rename = cjs.renameSync;
    const tick0 = new Date("2026-01-01T00:00:00Z");
    cjs.renameSync = (from, to) => {
      rename(from, to);
      if (String(to).endsWith(".toml")) cjs.utimesSync(to, tick0, tick0);
    };
    syncBuiltinESMExports();
    try {
      await call(lead, "start_session", {
        title: "w",
        cwd: "wt",
        task: "t",
        objective_id: "a/x",
        task_id: "t1",
      });
      await call(lead, "update_item", { objective_id: "a/x", item_id: "t2", state: "done" });
      await call(workers()[0], "finish_task", { summary: "done" });
    } finally {
      cjs.renameSync = rename;
      syncBuiltinESMExports();
    }
    expect(objectives()[0].tasks.map((t) => t.state)).toEqual(["review", "done"]);
  });
});
