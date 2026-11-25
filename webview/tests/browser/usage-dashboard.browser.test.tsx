import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { App } from "../../src/App";
import { UsageDashboard } from "../../src/usage/UsageDashboard";
import { FakeSocket } from "../fakeSocket";
import {
  compaction,
  journeyResponse,
  observation,
  overviewResponse,
  recordsUntil,
  usageUrl,
} from "../usageFixtures";
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

it("opens the mobile overview without shifting chat and renders a bounded token chart and ranked models", async () => {
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
  await expect.element(dialog.getByRole("img", { name: "Token types by UTC day" })).toBeVisible();
  await expect.element(dialog.getByRole("list", { name: "Ranked model totals" })).toBeVisible();
  const panel = screen.getByRole("dialog");
  const { left, top, right, bottom } = panel.getBoundingClientRect();
  expect(left).toBeGreaterThanOrEqual(0);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(right).toBeLessThanOrEqual(window.innerWidth);
  expect(bottom).toBeLessThanOrEqual(window.innerHeight);
  const charts = panel.querySelectorAll("svg");
  expect(charts).toHaveLength(2);
  expect(charts[1].querySelectorAll("rect")).toHaveLength(6);
  expect(panel.querySelectorAll(".usage-overview-ranking li")).toHaveLength(6);
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
        .getByRole("list", { name: "Token types by UTC day legend" })
        .getByText("Cache write", { exact: true }),
    )
    .toBeVisible();
  const label = panel.querySelector<HTMLSpanElement>(".usage-overview-ranking span[title]")!;
  label.scrollIntoView({ block: "center" });
  const labelBox = label.getBoundingClientRect();
  expect(document.elementFromPoint(labelBox.left + 2, labelBox.top + labelBox.height / 2)).toBe(
    label,
  );
  const benchmark = dialog.getByText(/The 98% benchmark/);
  const inferenceMeasure = dialog.getByText(/Inferences with ≥96% cache reads/);
  await expect.element(inferenceMeasure).not.toBeVisible();
  await expect.element(dialog.getByRole("heading", { name: "Usage records" })).toBeVisible();
  await expect.element(benchmark).not.toBeVisible();
  await dialog.getByText("Measurement details and benchmarks").click();
  await expect.element(benchmark).toBeVisible();
  await expect.element(inferenceMeasure).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(opener).toHaveFocus();
  expect(bounds(main)).toEqual(initialMain);
});

it("shares instant picks and Enter-applied fuzzy filters with responsive numbered Records", async () => {
  await page.viewport(390, 760);
  const request = vi.fn<typeof fetch>().mockImplementation((url) => {
    const { pathname, searchParams } = usageUrl(url);
    if (pathname.endsWith("/overview")) return Promise.resolve(overviewResponse());
    const page = Number(searchParams.get("page"));
    const hasFilter = searchParams.has("model") || searchParams.has("workspace");
    const rows =
      page === 2
        ? [{ ...observation, model: "second-model" }]
        : hasFilter
          ? [{ ...observation, unit: "turn" as const }]
          : [compaction];
    return Promise.resolve(journeyResponse(rows, { page, total: hasFilter ? 31 : 1 }));
  });
  vi.stubGlobal("fetch", request);
  render(
    <UsageDashboard
      onClose={vi.fn()}
      workspaces={[
        { id: "ws-123456789", name: "Design workspace" },
        { id: "ws-987654321", name: "Design workspace" },
      ]}
    />,
  );
  const dialog = page.getByRole("dialog");
  const params = () => Object.fromEntries(usageUrl(request.mock.lastCall![0]).searchParams);
  await dialog.getByRole("combobox", { name: "Window (UTC)" }).selectOptions("7d");
  await dialog.getByRole("combobox", { name: "Reporting unit" }).selectOptions("turn");
  const rank = dialog.getByRole("button", { name: "example-model, 104 tokens" });
  await rank.click();
  await expect.element(rank).toHaveAttribute("aria-pressed", "true");
  expect(params().model).toBe("example-model");
  await rank.click();
  await expect.element(rank).toHaveAttribute("aria-pressed", "false");
  expect(params().model).toBeUndefined();
  await dialog.getByText("Filters", { exact: true }).click();
  await expect.element(dialog.getByRole("textbox", { name: /turn/i })).not.toBeInTheDocument();
  await dialog.getByRole("combobox", { name: "Source" }).selectOptions("pi");
  expect(params().source).toBe("pi");
  const workspace = dialog.getByRole("combobox", { name: "Workspace", exact: true });
  await expect
    .element(workspace.getByRole("option", { name: "Design workspace · ws-12345" }))
    .toBeInTheDocument();
  await expect
    .element(workspace.getByRole("option", { name: "Design workspace · ws-98765" }))
    .toBeInTheDocument();
  await workspace.selectOptions("ws-123456789");
  expect(params().workspace).toBe("ws-123456789");
  await dialog.getByRole("combobox", { name: "Model", exact: true }).selectOptions("example-model");
  expect(params().model).toBe("example-model");
  const channel = dialog.getByRole("textbox", { name: "Channel contains" });
  await channel.fill("  a&b  ");
  const workspaceText = dialog.getByRole("textbox", { name: "Workspace contains" });
  await workspaceText.fill("Archived title");
  expect(params().workspace).toBe("ws-123456789");
  expect(params().channel).toBeUndefined();
  await dialog
    .getByRole("textbox", { name: "Session ID (Pi / ACP / Codex) contains" })
    .fill("PI-sess");
  await userEvent.keyboard("{Enter}");
  const filters = {
    range: "7d",
    unit: "turn",
    granularity: "day",
    model: "example-model",
    channel: "a&b",
    source: "pi",
    workspace: "Archived title",
    session: "PI-sess",
  };
  expect(params()).toEqual(filters);
  await dialog.getByRole("button", { name: "Records" }).click();
  const rows = dialog.getByRole("list", { name: "Recorded observations and events" });
  await expect.element(rows.getByText("example-model", { exact: true })).toBeVisible();
  expect(params()).toEqual({ ...filters, page: "1" });
  await expect.element(rows.getByText("01 Jun 2026, 00:00 UTC", { exact: true })).toBeVisible();
  await expect.element(rows.getByText(/^\(.*UTC[+-].*\)$/)).toBeVisible();
  const receipt = rows.getByText("inference-receipt", { exact: true });
  await expect.element(receipt).not.toBeVisible();
  await rows.getByText("example-model", { exact: true }).click();
  await expect.element(receipt).toBeVisible();
  await expect.element(rows.getByText(/API-equivalent · \$0.125 USD/)).toBeVisible();
  const pages = dialog.getByRole("form", { name: "Record pages" });
  const next = pages.getByRole("button", { name: "Next" });
  const previous = pages.getByRole("button", { name: "Previous" });
  await expect.element(previous).toBeDisabled();
  await next.click();
  await expect.element(rows.getByText("second-model")).toBeVisible();
  expect(params()).toEqual({ ...filters, page: "2", until: String(recordsUntil) });
  await expect.element(next).toBeDisabled();
  const { left, right } = screen.getByRole("dialog").getBoundingClientRect();
  const footer = screen.getByRole("form", { name: "Record pages" });
  for (const control of footer.querySelectorAll("button, input")) {
    const box = control.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(left);
    expect(box.right).toBeLessThanOrEqual(right);
  }
  await workspaceText.fill("Unapplied draft");
  await dialog.getByRole("button", { name: "Clear filters" }).click();
  await expect.element(rows.getByText("Context compacted")).toBeVisible();
  await expect.element(workspaceText).toHaveValue("");
  await expect.element(channel).toHaveValue("");
  await expect.element(previous).toBeDisabled();
  await expect
    .element(dialog.getByRole("list", { name: "Active filters" }))
    .not.toBeInTheDocument();
  expect(params()).toEqual({ range: "7d", unit: "turn", granularity: "day", page: "1" });
});
