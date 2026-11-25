import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { App } from "../../src/App";
import { FakeSocket } from "../fakeSocket";
import "../../src/styles.css";

function bounds(element: Element) {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}

afterEach(() => {
  cleanup();
  document.getElementById("root")?.remove();
  vi.unstubAllGlobals();
});

it("opens Usage from the mobile drawer without shifting chat and refreshes Journey through error and empty states", async () => {
  await page.viewport(390, 760);
  vi.stubGlobal("WebSocket", FakeSocket);
  const fetchUsage = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        observations: [
          {
            id: "inference-receipt",
            source: "pi",
            unit: "inference",
            sessionId: "pi-session",
            model: "example-model",
            timestamp: 1,
            input: 4,
            cacheRead: 96,
            cacheWrite: 0,
            output: 1,
            price: { kind: "unpriced", usd: null },
          },
        ],
        events: [],
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ observations: [], events: [] }));
  vi.stubGlobal("fetch", fetchUsage);
  const root = document.createElement("div");
  root.id = "root";
  root.style.cssText = "position:fixed; inset:0; height:100dvh";
  document.body.append(root);
  const { container } = render(<App />, { container: root });
  const main = container.querySelector(".main-panel")!;
  const initialMain = bounds(main);
  await page.getByRole("button", { name: /^Open workspace menu/ }).click();
  const opener = page.getByRole("button", { name: "Usage", exact: true });
  expect(fetchUsage).not.toHaveBeenCalled();
  await opener.click();

  const dialog = page.getByRole("dialog", { name: "Usage dashboard" });
  await expect
    .element(dialog.getByRole("heading", { name: "Weighted cache read share" }))
    .toBeVisible();
  const sidebarHeader = container.querySelector(".sidebar-header")!;
  const headerBounds = sidebarHeader.getBoundingClientRect();
  for (const button of sidebarHeader.querySelectorAll("button")) {
    const { left, right } = button.getBoundingClientRect();
    expect(left).toBeGreaterThanOrEqual(headerBounds.left);
    expect(right).toBeLessThanOrEqual(headerBounds.right);
  }
  expect(bounds(main)).toEqual(initialMain);
  const { left, top, right, bottom } = screen.getByRole("dialog").getBoundingClientRect();
  expect(left).toBeGreaterThanOrEqual(0);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(right).toBeLessThanOrEqual(window.innerWidth);
  expect(bottom).toBeLessThanOrEqual(window.innerHeight);

  await dialog.getByRole("button", { name: "Journey" }).click();
  await expect.element(dialog.getByText("inference-receipt")).toBeVisible();
  await dialog.getByRole("button", { name: "Refresh" }).click();
  await expect.element(dialog.getByRole("status")).toHaveTextContent("Could not load usage.");
  await dialog.getByRole("button", { name: "Refresh" }).click();
  await expect
    .element(dialog.getByRole("status"))
    .toHaveTextContent("No Journey records returned.");
  expect(fetchUsage.mock.calls.map(([url]) => url)).toEqual(Array(3).fill("api/usage"));
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(opener).toHaveFocus();
  expect(bounds(main)).toEqual(initialMain);
});
