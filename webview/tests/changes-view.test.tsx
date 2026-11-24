import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { FilesPanel } from "../src/panels/FilesPanel";
import { ChangesList, changeTree, parseDiff, type Changes } from "../src/panels/ChangesView";
import { fileIconName } from "../src/panels/Icon";

const listing = {
  kind: "dir",
  path: "/w",
  truncated: false,
  entries: [
    { name: "src", dir: true, size: 0 },
    { name: "README.md", dir: false, size: 10 },
    { name: "main.cpp", dir: false, size: 10 },
    { name: "CMakeLists.txt", dir: false, size: 10 },
  ],
};
const changes: Changes = {
  top: "/w",
  branch: "feature",
  base: "origin/main",
  against: "a".repeat(40),
  truncated: false,
  files: [
    { path: "src/lexer.cpp", status: "modified", added: 3, removed: 1 },
    { path: "docs/new.md", status: "untracked", added: 2, removed: 0 },
    { path: "old.png", status: "deleted", added: null, removed: null },
  ],
};
const long = `${"x".repeat(400)} // a line far wider than the panel`;
const diff = {
  path: "src/lexer.cpp",
  binary: false,
  truncated: false,
  diff: [
    "@@ -10,3 +10,5 @@ int lex() {",
    " int a = 1;",
    "-int b = 2;",
    "+int b = 3;",
    `+${long}`,
    "+int c = 4;",
    " return a;",
    "\\ No newline at end of file",
    "",
  ].join("\n"),
};

describe("changed files", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const body = url.startsWith("api/diff/file")
          ? diff
          : url.startsWith("api/diff")
            ? changes
            : listing;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const panel = () =>
    render(<FilesPanel wsId="w1" target={{ path: "." }} roots={[{ label: "w", path: "/w" }]} />);

  it("maps file and folder names to their icons, including defaults", () => {
    // A file by name, by its longest extension, by language; a folder by
    // name; else the defaults.
    expect(
      ["package.json", ".gitignore", "src/a.test.ts", "a.tsx", "x.toml", "notes.unknown"].map((n) =>
        fileIconName(n),
      ),
    ).toEqual([
      "file_type_npm",
      "file_type_git",
      "file_type_testts",
      "file_type_reactts",
      "file_type_toml",
      "default_file",
    ]);
    expect(["node_modules", ".git/", "Tests", "random"].map((n) => fileIconName(n, true))).toEqual([
      "folder_type_node",
      "folder_type_git",
      "folder_type_test",
      "default_folder",
    ]);
  });

  it("labels a deleted binary without inventing line counts", () => {
    const { getByTitle } = render(
      <ChangesList changes={changes} open={() => {}} closed={new Set()} toggle={() => {}} />,
    );
    const row = getByTitle("old.png");
    expect(row.querySelector(".change-status")!.textContent).toBe("D");
    expect(row.querySelector(".change-count")!.textContent).toBe("binary");
  });

  it("lists the changes as folders, a folder of one folder as one row, each to fold", async () => {
    changes.files = [
      { path: "src/sched/batch.cpp", status: "modified", added: 1, removed: 1 },
      { path: "src/sched/queue.cpp", status: "added", added: 9, removed: 0 },
      { path: "src/a.cpp", status: "modified", added: 1, removed: 0 },
      { path: "docs/guide/intro.md", status: "modified", added: 2, removed: 0 },
      { path: "README.md", status: "modified", added: 1, removed: 0 },
    ];
    try {
      const { container, getByTitle } = panel();
      await waitFor(() => expect(container.querySelector(".dir-view")).not.toBeNull());
      fireEvent.click(getByTitle("Changes against the base branch"));
      await waitFor(() => expect(container.querySelector(".changes .dir-entry")).not.toBeNull());
      const rows = () =>
        [...container.querySelectorAll(".changes .dir-entry")].map(
          (r) =>
            `${(r as HTMLElement).style.getPropertyValue("--depth")}:${r.querySelector(".dir-entry-name")!.textContent}`,
        );
      expect(rows()).toEqual([
        "0:docs/guide",
        "1:intro.md",
        "0:src",
        "1:sched",
        "2:batch.cpp",
        "2:queue.cpp",
        "1:a.cpp",
        "0:README.md",
      ]);
      fireEvent.click(getByTitle("src/sched"));
      expect(getByTitle("src/sched").getAttribute("aria-expanded")).toBe("false");
      expect(rows()).toEqual([
        "0:docs/guide",
        "1:intro.md",
        "0:src",
        "1:sched",
        "1:a.cpp",
        "0:README.md",
      ]);
      fireEvent.click(getByTitle("src"));
      expect(rows()).toEqual(["0:docs/guide", "1:intro.md", "0:src", "0:README.md"]);
      fireEvent.click(getByTitle("src"));
      expect(rows()).toContain("1:sched");
      expect(rows()).not.toContain("2:batch.cpp");

      // Folds stay as they were after a diff, and after the files.
      fireEvent.click(getByTitle("README.md"));
      await waitFor(() => expect(container.querySelector(".diff-view")).not.toBeNull());
      fireEvent.click(getByTitle("All changes"));
      await waitFor(() => expect(container.querySelector(".changes .dir-entry")).not.toBeNull());
      expect(rows()).not.toContain("2:batch.cpp");
      fireEvent.click(getByTitle("Files"));
      fireEvent.click(getByTitle("Changes against the base branch"));
      await waitFor(() => expect(container.querySelector(".changes .dir-entry")).not.toBeNull());
      expect(rows()).not.toContain("2:batch.cpp");
    } finally {
      changes.files = [
        { path: "src/lexer.cpp", status: "modified", added: 3, removed: 1 },
        { path: "docs/new.md", status: "untracked", added: 2, removed: 0 },
        { path: "old.png", status: "deleted", added: null, removed: null },
      ];
    }
  });

  it("names a nested repository git lists with a slash", () => {
    const tree = changeTree([
      { path: "wt/feat/", status: "untracked", added: null, removed: null },
      { path: "wt/a.txt", status: "untracked", added: 1, removed: 0 },
    ]);
    expect(tree.dirs.map((d) => d.name)).toEqual(["wt"]);
    expect(tree.dirs[0].files.map((f) => f.path)).toEqual(["wt/a.txt", "wt/feat/"]);
    const { container } = render(
      <ChangesList
        changes={{ ...changes, files: tree.dirs[0].files }}
        open={() => {}}
        closed={new Set()}
        toggle={() => {}}
      />,
    );
    expect(
      [...container.querySelectorAll(".change-entry .dir-entry-name")].map((n) => n.textContent),
    ).toEqual(["a.txt", "feat/"]);
  });

  it("reads a diff's line numbers on both sides", () => {
    expect(parseDiff("@@ -1 +1,2 @@\n-a\n+b\n+c\n")).toEqual([
      { kind: "hunk", text: "@@ -1 +1,2 @@" },
      { kind: "del", old: 1, text: "a" },
      { kind: "add", new: 1, text: "b" },
      { kind: "add", new: 2, text: "c" },
    ]);
  });
});
