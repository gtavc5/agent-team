import { cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { AddAgentDialog, CreateWorkspaceDialog } from "../../src/workspace/dialogs";
import "../../src/styles.css";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

it("lets Tab leave the directory in either direction and picks only an active suggestion", async () => {
  const onCreate = vi.fn();
  const onListDirs = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          New session
        </button>
        {open && (
          <CreateWorkspaceDialog
            hosts={[]}
            initialPath="/repo/"
            projectFolders={["/repo"]}
            dirSuggestions={{
              prefix: "/repo/",
              dirs: [
                "/repo/docs/",
                ...Array.from({ length: 16 }, (_, i) => `/repo/lib${i}/`),
                "/repo/src/",
              ],
            }}
            onListDirs={onListDirs}
            onCreate={onCreate}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    );
  }
  render(<Harness />);
  const opener = page.getByRole("button", { name: "New session" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "New Session" });
  const name = dialog.getByRole("textbox", { name: "Name" });
  const path = dialog.getByRole("combobox", { name: "Directory path" });
  await expect.element(name).toHaveFocus();
  await userEvent.tab();
  await expect.element(path).toHaveFocus();
  await expect.element(dialog.getByRole("listbox")).toBeVisible();
  await userEvent.tab({ shift: true });
  await expect.element(name).toHaveFocus();
  await userEvent.tab();
  await userEvent.tab();
  await expect.element(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.tab({ shift: true });
  await expect.element(path).toHaveValue("/repo/");
  await userEvent.keyboard("{ArrowUp}");
  const active = dialog.getByRole("option", { selected: true });
  await expect.element(active).toHaveTextContent("/repo/src/");
  const list = dialog.getByRole("listbox").element();
  await expect
    .poll(() => active.element().getBoundingClientRect().bottom)
    .toBeLessThanOrEqual(list.getBoundingClientRect().bottom);
  await userEvent.keyboard("{ArrowDown}");
  await expect
    .element(dialog.getByRole("option", { selected: true }))
    .toHaveTextContent("/repo/docs/");
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog.getByRole("listbox")).not.toBeInTheDocument();
  await expect.element(path).toHaveFocus();
  await userEvent.tab({ shift: true });
  await userEvent.tab();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect.element(path).toHaveValue("/repo/docs/");
  await expect.element(path).toHaveAttribute("aria-expanded", "false");
  expect(onCreate).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(onCreate).toHaveBeenCalledExactlyOnceWith("docs", "/repo/docs/", "local", undefined);
  await expect.element(opener).toHaveFocus();
  expect(onListDirs).not.toHaveBeenCalledWith("/repo/docs/");
});

it("submits the typed path rather than an unselected child", async () => {
  const onCreate = vi.fn();
  render(
    <CreateWorkspaceDialog
      hosts={[]}
      initialPath="/repo/"
      projectFolders={["/repo"]}
      dirSuggestions={{ prefix: "/repo/", dirs: ["/repo/docs/"] }}
      onListDirs={() => {}}
      onCreate={onCreate}
      onClose={() => {}}
    />,
  );
  await userEvent.tab();
  await expect.element(page.getByRole("listbox")).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{Tab}{Shift>}{Tab}{/Shift}{Enter}");
  expect(onCreate).toHaveBeenCalledExactlyOnceWith("repo", "/repo/", "local", undefined);
});

it.each([
  [320, "light"],
  [360, "dark"],
] as const)(
  "keeps preset labels readable and keyboard-selectable at %ipx in %s mode",
  async (width, theme) => {
    await page.viewport(width, 740);
    document.documentElement.dataset.theme = theme;
    const onAdd = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open add agent
          </button>
          {open && (
            <AddAgentDialog
              presets={["Laffey", "Allen", "Perseus", "Shorekeeper", "Ayanami"].map((name) => ({
                name,
                avatar: name[0],
                color: "#d8a0d8",
              }))}
              models={[{ id: "pi/model", label: "Model", backend: "pi" }]}
              onAdd={onAdd}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }
    render(<Harness />);
    const opener = page.getByRole("button", { name: "Open add agent" });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Add Agent" });
    const name = dialog.getByRole("textbox", { name: "Name (or use preset)" });
    await expect.element(name).toHaveFocus();

    // Measure the label's rendered text fragments, not just the preset hit box.
    const presets = dialog
      .getByRole("group", { name: "Agent presets" })
      .getByRole("button")
      .elements();
    expect(new Set(presets.map((el) => el.getBoundingClientRect().top)).size).toBeGreaterThan(1);
    for (const preset of presets) {
      const range = document.createRange();
      range.selectNodeContents(preset.lastElementChild!);
      const fragments = [...range.getClientRects()];
      expect(fragments).toHaveLength(1);
      const bounds = preset.getBoundingClientRect();
      expect(fragments[0].left).toBeGreaterThan(bounds.left);
      expect(fragments[0].right).toBeLessThan(bounds.right);
      expect(bounds.right).toBeLessThan(width);
    }

    const choice = dialog.getByRole("button", { name: "Ayanami" });
    await userEvent.tab({ shift: true });
    await expect.element(choice).toHaveFocus();
    expect(getComputedStyle(choice.element()).outlineStyle).toBe("solid");
    await userEvent.keyboard(" ");
    await expect.element(choice).toHaveAttribute("aria-pressed", "true");
    expect(onAdd).not.toHaveBeenCalled();
    await userEvent.tab();
    await expect.element(name).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onAdd).toHaveBeenCalledExactlyOnceWith("Ayanami", "pi/model", "A", "#d8a0d8", undefined);
    await expect.element(opener).toHaveFocus();
  },
);
