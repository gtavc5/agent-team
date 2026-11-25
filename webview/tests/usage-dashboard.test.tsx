import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { UsageDashboard } from "../src/usage/UsageDashboard";
import { FakeSocket } from "./fakeSocket";
import { compaction, journeyResponse, observation, overviewResponse } from "./usageFixtures";

afterEach(() => vi.unstubAllGlobals());

it("opens Usage from the sidebar and displays server aggregates and distinct price bases", async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(overviewResponse({ incompleteSources: 2, sourcesPending: true }));
  vi.stubGlobal("fetch", request);
  render(<App />);
  expect(request).not.toHaveBeenCalled();
  const opener = screen.getByRole("button", { name: "Usage" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = within(screen.getByRole("dialog", { name: "Usage dashboard" }));
  expect(dialog.getByRole("status").textContent).toBe("Loading usage…");
  expect(await dialog.findByText("92.31%")).toBeTruthy();
  expect(dialog.getByText("2 of 2 observations with prompt tokens")).toBeTruthy();
  expect(dialog.getByText(/Inferences with ≥96% cache reads: 50%/).textContent).toContain(
    "1 of 2 eligible",
  );
  expect(dialog.getByText("Reported").nextElementSibling?.textContent).toBe("$0");
  expect(dialog.getByText("API-equivalent").nextElementSibling?.textContent).toBe("$0.125");
  expect(dialog.getByText("Channel estimate").nextElementSibling?.textContent).toBe("—");
  expect(dialog.getByText("Unavailable or partially decoded usage sources: 2")).toBeTruthy();
  expect(dialog.getByRole("status").textContent).toBe("Source scan pending");
  expect(request.mock.calls[0][0]).toBe("api/usage/overview?range=30d&unit=inference");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it("suppresses superseded view results and refreshes an error", async () => {
  let finishOverview!: (response: Response) => void;
  const request = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(new Promise<Response>((resolve) => (finishOverview = resolve)))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(journeyResponse([]));
  vi.stubGlobal("fetch", request);
  render(<UsageDashboard onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Records" }));
  expect(await screen.findByText(/Could not load usage/)).toBeTruthy();
  expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await act(() => {
    finishOverview(overviewResponse());
    return Promise.resolve();
  });
  expect(screen.queryByText("92.31%")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Could not load usage");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("No records match these filters.")).toBeTruthy();
  expect(request.mock.calls.slice(1).map(([url]) => url)).toEqual(
    Array(2).fill("api/usage/journey?range=30d&unit=inference"),
  );
});

it("shows audit records in server order and keeps details on their own rows", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(overviewResponse())
    .mockResolvedValueOnce(
      journeyResponse([
        compaction,
        observation,
        { ...observation, model: "Other model", sessionId: "different-session" },
      ]),
    );
  vi.stubGlobal("fetch", request);
  render(<UsageDashboard onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Records" }));
  const rows = within(
    await screen.findByRole("list", { name: "Recorded observations and events" }),
  ).getAllByRole("listitem");
  expect(rows.map((row) => row.querySelector("summary")?.firstElementChild?.textContent)).toEqual([
    "Context compacted",
    "example-model",
    "Other model",
  ]);
  expect(rows[0].querySelector("time")).toBeNull();
  expect(rows[0].querySelector("details")?.open).toBe(false);
  expect(within(rows[0]).queryByText("Price")).toBeNull();
  expect(rows[1].querySelector("time")?.dateTime).toBe("2026-06-01T00:00:00.000Z");
  expect(within(rows[1]).getByText("API-equivalent · $0.125 USD · as of 2026-06-01")).toBeTruthy();
  expect(within(rows[2]).getByText("different-session")).toBeTruthy();
});
