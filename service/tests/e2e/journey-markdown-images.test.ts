import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { ProjectStore } from "../../src/project/store";
import { pilotBrowser, sandboxAgent } from "./pilot-browser";

it("loads sandboxed PNG and SVG images through Files and Notes Markdown previews", async () => {
  await pilotBrowser(
    (root) => {
      const cwd = join(root, "workspace");
      const store = new ProjectStore(root);
      store.save({
        id: "image-project",
        name: "Image project",
        schemaVersion: 2,
        status: "active",
        root: cwd,
        createdAt: 1,
        lead: { hostId: "local", workspaceId: "image-pilot" },
        leadWorkspaceId: "image-pilot",
      });
      const docs = join(cwd, "docs");
      const notes = store.notesDir("image-project");
      for (const dir of [docs, notes]) {
        const figures = join(dir, "figures");
        mkdirSync(figures, { recursive: true });
        writeFileSync(
          join(dir, "guide.md"),
          `![Small chart](${dir === notes ? "notes/" : ""}figures/pixel.png?revision=1)\n\n![Wide chart](./figures/wide%20%E5%9B%BE.svg#chart)\n`,
        );
        writeFileSync(
          join(figures, "pixel.png"),
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9z8AAAAASUVORK5CYII=",
            "base64",
          ),
        );
        writeFileSync(
          join(figures, "wide 图.svg"),
          '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="400"><rect width="2000" height="400" fill="teal"/></svg>',
        );
      }
      return [
        {
          id: "image-pilot",
          name: "Image pilot",
          project: "Image project",
          projectLink: { projectId: "image-project", role: "lead" },
          hostId: "local",
          cwd,
          agents: [sandboxAgent(root, cwd)],
          messages: [],
          createdAt: 1,
        },
      ];
    },
    async (page) => {
      await page
        .locator("nav.side-rail")
        .getByRole("button", { name: "Files", exact: true })
        .click();
      const panel = page.locator(".files-panel");
      await panel.getByRole("button", { name: /^docs\// }).click();
      const checkPreview = async (entry: Locator, preview: Locator, project: boolean) => {
        const assets = [
          ["pixel.png", "image/png"],
          ["wide 图.svg", "image/svg+xml"],
        ] as const;
        const responses = assets.map(([file]) =>
          page.waitForResponse((res) => {
            const url = new URL(res.url());
            return (
              url.pathname === "/api/file/raw" &&
              url.searchParams.get(project ? "project" : "ws") ===
                (project ? "image-project" : "image-pilot") &&
              (url.searchParams.get("path") ?? "")
                .replace(/\\/g, "/")
                .endsWith(project ? `notes/figures/${file}` : `/docs/figures/${file}`)
            );
          }),
        );
        const [results] = await Promise.all([Promise.all(responses), entry.click()]);
        for (const [i, response] of results.entries()) {
          expect(response.status()).toBe(200);
          expect(response.headers()).toMatchObject({
            "content-type": assets[i][1],
            "content-security-policy": "sandbox",
            "x-content-type-options": "nosniff",
          });
        }
        const png = preview.getByRole("img", { name: "Small chart" });
        const svg = preview.getByRole("img", { name: "Wide chart" });
        await expect.poll(() => png.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
        await expect.poll(() => svg.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(2000);
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 800 });
          for (const theme of ["light", "dark"]) {
            await page.evaluate((value) => {
              document.documentElement.dataset.theme = value;
            }, theme);
            await svg.waitFor({ state: "visible" });
            const layout = await svg.evaluate((el) => {
              const host = el.closest<HTMLElement>(".file-markdown")!;
              const img = el.getBoundingClientRect();
              return {
                width: img.width,
                height: img.height,
                fits: host.scrollWidth <= host.clientWidth,
              };
            });
            expect(layout.width).toBeGreaterThan(0);
            expect(layout.width).toBeLessThan(2000);
            expect(layout.width / layout.height).toBeCloseTo(5, 1);
            expect(layout.fits).toBe(true);
          }
        }
        await page.setViewportSize({ width: 1280, height: 800 });
      };
      await checkPreview(
        panel.locator(".dir-entry-name").getByText("guide.md", { exact: true }),
        panel.locator(".file-markdown"),
        false,
      );
      await page.getByRole("button", { name: "Objectives of Image project" }).click();
      await page.getByRole("button", { name: "Notes", exact: true }).click();
      await checkPreview(
        page.getByRole("treeitem", { name: "guide.md", exact: true }),
        page.locator(".file-markdown.bn-md"),
        true,
      );
    },
  );
}, 30_000);
