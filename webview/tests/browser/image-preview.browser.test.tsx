import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { FilesPanel } from "../../src/panels/FilesPanel";
import { FilePreview } from "../../src/project/NotesView";
import "../../src/styles.css";

const path = "/workspace/preview.svg";
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3" fill="red"/></svg>';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

it.each(["light", "dark"])(
  "renders both image toolbars in %s and rasterizes SVG on copy",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(1280, 800);
    let respond!: (response: Response) => void;
    const raw = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.startsWith("api/file/raw?")
          ? raw.then((response) => response.clone())
          : Promise.resolve(Response.json({ kind: "image", path, size: svg.length })),
      ),
    );
    const write = vi.spyOn(navigator.clipboard, "write").mockResolvedValue();
    const { container } = render(
      <>
        <FilesPanel wsId="w" target={{ path }} roots={[]} />
        <FilePreview
          project="p"
          file={{ path }}
          editor={true}
          onRef={vi.fn()}
          onResolve={vi.fn()}
          onClose={vi.fn()}
        />
      </>,
    );
    const filesCopy = page.getByTitle("Copy image").first();
    const notesCopy = page.getByTitle("Copy image").last();
    for (const button of [filesCopy, notesCopy]) {
      await expect.element(button).toBeDisabled();
      const paint = () => {
        const { color, borderTopColor, opacity, cursor } = getComputedStyle(button.element());
        return { color, borderTopColor, opacity, cursor };
      };
      const rest = paint();
      expect(rest).toMatchObject({ opacity: "0.45", cursor: "not-allowed" });
      await button.hover();
      expect(paint()).toEqual(rest);
    }
    respond(new Response(svg, { headers: { "Content-Type": "image/svg+xml" } }));
    await expect.element(filesCopy).toBeEnabled();
    await expect.element(notesCopy).toBeEnabled();
    const paint = (el: Element) => getComputedStyle(el).borderTopColor;
    for (const width of [1280, 320, 390]) {
      await page.viewport(width, 800);
      for (const bar of container.querySelectorAll(".fp-bar, .bn-bar")) {
        const host = bar.getBoundingClientRect();
        for (const control of bar.querySelectorAll(".fp-btn, .bn-path, .fp-path")) {
          const box = control.getBoundingClientRect();
          expect(box.left).toBeGreaterThanOrEqual(host.left);
          expect(box.right).toBeLessThanOrEqual(host.right);
          if (control.matches(".fp-path, .bn-path")) expect(box.width).toBeGreaterThanOrEqual(64);
        }
      }
    }
    const pathCopy = page.getByRole("button", { name: "Copy path" });
    (pathCopy.element() as HTMLElement).focus();
    await userEvent.tab();
    await expect.element(filesCopy).toHaveFocus();
    await pathCopy.hover();
    const rest = paint(filesCopy.element());
    await filesCopy.hover();
    expect(paint(filesCopy.element())).not.toBe(rest);
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    const [item] = write.mock.calls[0][0];
    expect(item.types).toEqual(["image/png"]);
    const bitmap = await createImageBitmap(await item.getType("image/png"));
    expect([bitmap.width, bitmap.height]).toEqual([2, 3]);
    bitmap.close();
    write.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    await notesCopy.click();
    await expect.element(page.getByRole("button", { name: "Copy failed" })).toBeVisible();
  },
);
