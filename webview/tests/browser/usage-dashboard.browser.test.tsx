import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { App } from "../../src/App";
import { UsageDashboard } from "../../src/usage/UsageDashboard";
import { FakeSocket } from "../fakeSocket";
import { compaction, journeyResponse, observation, overviewResponse } from "../usageFixtures";
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

it("opens the mobile overview without shifting chat and renders two bounded token charts", async () => {
  await page.viewport(390, 760);
  vi.stubGlobal("WebSocket", FakeSocket);
  const ranking = Array.from({ length: 8 }, (_, index) => ({
    model: `model-${index + 1}`,
    tokens: 100 - index * 10,
  }));
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(overviewResponse({ ranking }));
  vi.stubGlobal("fetch", request);
  const root = document.createElement("div");
  root.id = "root";
  root.style.cssText = "position:fixed; inset:0; height:100dvh";
  document.body.append(root);
  const { container } = render(<App />, { container: root });
  const main = container.querySelector(".main-panel")!;
  const initialMain = bounds(main);
  await page.getByRole("button", { name: /^Open workspace menu/ }).click();
  const opener = page.getByRole("button", { name: "Usage", exact: true });
  expect(request).not.toHaveBeenCalled();
  await opener.click();

  const dialog = page.getByRole("dialog", { name: "Usage dashboard" });
  await expect
    .element(dialog.getByRole("img", { name: "Daily token composition chart" }))
    .toBeVisible();
  await expect
    .element(dialog.getByRole("img", { name: "Ranked model tokens chart" }))
    .toBeVisible();
  const panel = screen.getByRole("dialog");
  const { left, top, right, bottom } = panel.getBoundingClientRect();
  expect(left).toBeGreaterThanOrEqual(0);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(right).toBeLessThanOrEqual(window.innerWidth);
  expect(bottom).toBeLessThanOrEqual(window.innerHeight);
  const charts = panel.querySelectorAll("svg");
  expect(charts).toHaveLength(2);
  expect(charts[1].querySelectorAll("rect")).toHaveLength(6);
  for (const chart of charts) {
    const box = bounds(chart);
    expect(box.width).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThanOrEqual(right);
    expect(box.height).toBeLessThan(200);
  }
  expect(
    Number(charts[0].querySelector("g:last-child .usage-fill-cacheWrite")?.getAttribute("height")),
  ).toBeGreaterThan(0);
  await expect
    .element(
      dialog
        .getByRole("list", { name: "Daily token categories" })
        .getByText("Cache write", { exact: true }),
    )
    .toBeVisible();
  const label = panel.querySelector<HTMLSpanElement>(".usage-ranking span[title]")!;
  label.scrollIntoView({ block: "center" });
  const labelBox = label.getBoundingClientRect();
  expect(document.elementFromPoint(labelBox.left + 2, labelBox.top + labelBox.height / 2)).toBe(
    label,
  );
  const benchmark = dialog.getByText(/The 98% benchmark/);
  const inferenceMeasure = dialog.getByText(/Inferences with ≥96% cache reads/);
  await expect.element(inferenceMeasure).not.toBeVisible();
  await expect.element(dialog.getByRole("heading", { name: "Data coverage" })).toBeVisible();
  await expect.element(benchmark).not.toBeVisible();
  await dialog.getByText("Measurement details and benchmarks").click();
  await expect.element(benchmark).toBeVisible();
  await expect.element(inferenceMeasure).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(opener).toHaveFocus();
  expect(bounds(main)).toEqual(initialMain);
});

it("shares all filters with Records and traverses server cursors at the same UTC window", async () => {
  await page.viewport(1280, 800);
  const request = vi.fn<typeof fetch>().mockImplementation((url) => {
    if (typeof url !== "string") throw new Error("Expected a usage URL");
    const { pathname, searchParams } = new URL(url, window.location.href);
    if (pathname.endsWith("/overview")) return Promise.resolve(overviewResponse());
    if (searchParams.has("cursor"))
      return Promise.resolve(
        journeyResponse([{ ...observation, unit: "turn", id: "page-two", model: "second-model" }]),
      );
    if (!searchParams.has("model")) return Promise.resolve(journeyResponse([compaction]));
    return Promise.resolve(journeyResponse([{ ...observation, unit: "turn" }], "opaque+=/cursor"));
  });
  vi.stubGlobal("fetch", request);
  render(
    <UsageDashboard onClose={vi.fn()} workspaces={[{ id: "ws-1", name: "Design workspace" }]} />,
  );
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Window (UTC)" }).selectOptions("7d");
  await dialog.getByRole("combobox", { name: "Reporting unit" }).selectOptions("turn");
  await dialog.getByText("Filters", { exact: true }).click();
  const inputs = Array.from(
    screen.getByRole("dialog").querySelectorAll<HTMLInputElement>(".usage-filter-grid input"),
  );
  expect(inputs.map((input) => input.maxLength)).toEqual(Array(5).fill(256));
  await dialog.getByRole("textbox", { name: "Model" }).fill("example-model");
  await dialog.getByRole("textbox", { name: "Channel" }).fill("a&b");
  await dialog.getByRole("combobox", { name: "Source" }).selectOptions("pi");
  const workspace = dialog.getByRole("combobox", { name: "Workspace" });
  expect(screen.getByRole("combobox", { name: "Workspace" }).getAttribute("list")).toBeTruthy();
  expect(document.querySelector('datalist option[value="ws-1"]')?.getAttribute("label")).toBe(
    "Design workspace",
  );
  await workspace.fill("ws-1");
  await dialog.getByRole("textbox", { name: "Session ID" }).fill("pi-session");
  await dialog.getByRole("textbox", { name: "Turn ID" }).fill("turn-1");
  await dialog.getByRole("button", { name: "Apply filters" }).click();
  const params = () => {
    const url = request.mock.calls.at(-1)?.[0];
    if (typeof url !== "string") throw new Error("Expected a usage URL");
    return new URL(url, window.location.href).searchParams;
  };
  const filters = {
    range: "7d",
    unit: "turn",
    model: "example-model",
    channel: "a&b",
    source: "pi",
    workspace: "ws-1",
    session: "pi-session",
    turn: "turn-1",
  };
  expect(Object.fromEntries(params())).toEqual(filters);
  await dialog.getByRole("button", { name: "Records" }).click();
  await expect.element(dialog.getByText("example-model", { exact: true })).toBeVisible();
  expect(Object.fromEntries(params())).toEqual(filters);
  const receipt = dialog.getByText("inference-receipt", { exact: true });
  await expect.element(receipt).not.toBeVisible();
  await dialog.getByText("example-model", { exact: true }).click();
  await expect.element(receipt).toBeVisible();
  await expect.element(dialog.getByText(/API-equivalent · \$0.125 USD/)).toBeVisible();
  const next = dialog.getByRole("button", { name: "Next" });
  const previous = dialog.getByRole("button", { name: "Previous" });
  await expect.element(previous).toBeDisabled();
  await next.click();
  await expect.element(dialog.getByText("second-model")).toBeVisible();
  expect(Object.fromEntries(params())).toEqual({
    ...filters,
    cursor: "opaque+=/cursor",
    until: String(Date.UTC(2026, 5, 4)),
  });
  await expect.element(next).toBeDisabled();
  await previous.click();
  await expect.element(dialog.getByText("example-model", { exact: true })).toBeVisible();
  expect(Object.fromEntries(params())).toEqual({ ...filters, until: String(Date.UTC(2026, 5, 4)) });
  await next.click();
  await expect.element(dialog.getByText("Page 2")).toBeVisible();
  await dialog.getByRole("button", { name: "Clear filters" }).click();
  await expect.element(dialog.getByText("Context compacted")).toBeVisible();
  await expect.element(previous).toBeDisabled();
  expect(Object.fromEntries(params())).toEqual({ range: "7d", unit: "turn" });
});
