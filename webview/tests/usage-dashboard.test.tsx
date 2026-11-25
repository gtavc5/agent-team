import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { formatRecordTime, UsageDashboard } from "../src/usage/UsageDashboard";
import { FakeSocket } from "./fakeSocket";
import {
  compaction,
  journeyResponse,
  observation,
  overviewResponse,
  recordsUntil,
  usageUrl,
} from "./usageFixtures";

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
  expect(dialog.getByText("2 of 2 records with prompt tokens")).toBeTruthy();
  expect(dialog.getByText(/Inferences with ≥96% cache reads: 50%/).textContent).toContain(
    "1 of 2 eligible",
  );
  expect(dialog.getByText("Reported").nextElementSibling?.textContent).toBe("$0");
  expect(dialog.getByText("API-equivalent").nextElementSibling?.textContent).toBe("$0.125");
  expect(dialog.getByText("Channel estimate").nextElementSibling?.textContent).toBe("—");
  expect(dialog.getByText("2 sources unavailable or partially read")).toBeTruthy();
  expect(dialog.getByRole("status").textContent).toBe("Source scan pending");
  expect(request.mock.calls[0][0]).toBe(
    "api/usage/overview?range=30d&unit=inference&granularity=day",
  );
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
  expect(request.mock.calls.slice(1).map(([url]) => url)).toEqual([
    "api/usage/journey?range=30d&unit=inference&granularity=day&page=1",
    "api/usage/journey?range=30d&unit=inference&granularity=day&page=1&refresh=1",
  ]);
});

it("shows newest-first records, source status, and details on their own rows", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(overviewResponse())
    .mockResolvedValueOnce(
      journeyResponse(
        [
          {
            ...observation,
            model: "Other model",
            sessionId: "different-session",
            timestamp: Date.UTC(2026, 5, 3),
          },
          observation,
          compaction,
        ],
        { sourcesPending: true, incompleteSources: 1 },
      ),
    );
  vi.stubGlobal("fetch", request);
  render(<UsageDashboard onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Records" }));
  const rows = within(
    await screen.findByRole("list", { name: "Recorded observations and events" }),
  ).getAllByRole("listitem");
  expect(screen.getByText("Source scan pending")).toBeTruthy();
  expect(screen.getByText("1 source unavailable or partially read")).toBeTruthy();
  expect(rows.map((row) => row.querySelector("summary")?.firstElementChild?.textContent)).toEqual([
    "Other model",
    "example-model",
    "Context compacted",
  ]);
  expect(rows[2].querySelector("time")).toBeNull();
  expect(rows[2].querySelector("details")?.open).toBe(false);
  expect(within(rows[2]).queryByText("Price")).toBeNull();
  expect(rows[1].querySelector("time")?.dateTime).toBe("2026-06-01T00:00:00.000Z");
  expect(within(rows[1]).getByText("API-equivalent · $0.125 USD · as of 2026-06-01")).toBeTruthy();
  expect(within(rows[0]).getByText("different-session")).toBeTruthy();
});

function usageParams(url: Parameters<typeof fetch>[0]) {
  return usageUrl(url).searchParams;
}

it("uses hour and day only where supported, including after explicit refresh", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(overviewResponse()));
  vi.stubGlobal("fetch", request);
  render(<UsageDashboard onClose={vi.fn()} />);
  const window = screen.getByRole<HTMLSelectElement>("combobox", { name: "Window (UTC)" });
  const granularity = screen.getByRole<HTMLSelectElement>("combobox", { name: "Granularity" });
  const last = () => usageParams(request.mock.lastCall![0]);
  fireEvent.click(await screen.findByRole("button", { name: "Top models" }));
  expect(granularity.disabled).toBe(true);
  fireEvent.change(window, { target: { value: "24h" } });
  expect(granularity.value).toBe("hour");
  expect(last().get("range")).toBe("24h");
  expect(last().get("granularity")).toBe("hour");
  fireEvent.change(granularity, { target: { value: "day" } });
  expect(last().get("granularity")).toBe("day");
  fireEvent.change(window, { target: { value: "7d" } });
  fireEvent.change(granularity, { target: { value: "hour" } });
  expect(last().get("granularity")).toBe("hour");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(last().get("refresh")).toBe("1");
  fireEvent.change(window, { target: { value: "90d" } });
  expect(last().has("refresh")).toBe(false);
  expect(last().get("granularity")).toBe("day");
  expect(granularity.disabled).toBe(true);
  expect(within(granularity).queryByRole("option", { name: "Hour" })).toBeNull();
  await screen.findByText("92.31%");
  expect(screen.getByRole("button", { name: "Top models" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

it.each([
  ["Design workspace", "workspace", "ws-123456789"],
  ["ws-123456789", "workspace", "ws-123456789"],
  ["pi-session", "session", "pi-session"],
  ["native-pi-session", "session", "native-pi-session"],
  ["turn-1", "turn", "turn-1"],
])("uses the record value when clicking %s and makes it removable", async (label, field, value) => {
  const request = vi.fn<typeof fetch>().mockImplementation((url) => {
    if (usageUrl(url).pathname.endsWith("/overview")) return Promise.resolve(overviewResponse());
    return Promise.resolve(journeyResponse([observation]));
  });
  vi.stubGlobal("fetch", request);
  render(<UsageDashboard onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Records" }));
  const name = await screen.findByText("example-model");
  const details = name.closest("details")!;
  details.open = true;
  fireEvent.click(within(details).getByRole("button", { name: label }));
  expect(usageParams(request.mock.lastCall![0]).get(field)).toBe(value);
  expect(usageParams(request.mock.lastCall![0]).get("page")).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: `Remove ${field} filter: ${value}` }));
  expect(usageParams(request.mock.lastCall![0]).has(field)).toBe(false);
  await screen.findByText("example-model");
});

it("pins all numbered navigation, then explicitly refreshes a new first page", async () => {
  const refreshedUntil = recordsUntil + 86_400_000;
  const request = vi.fn<typeof fetch>().mockImplementation((url) => {
    if (usageUrl(url).pathname.endsWith("/overview")) return Promise.resolve(overviewResponse());
    const query = usageParams(url);
    const page = Number(query.get("page"));
    const until = query.has("refresh")
      ? refreshedUntil
      : Number(query.get("until") ?? recordsUntil);
    return Promise.resolve(
      journeyResponse([{ ...observation, model: `result-${page}` }], { page, total: 91, until }),
    );
  });
  vi.stubGlobal("fetch", request);
  render(<UsageDashboard onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Records" }));
  await screen.findByText("Page 1 of 4 · 91 records");
  const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });
  const query = () => usageParams(request.mock.lastCall![0]);
  expect(button("First").disabled).toBe(true);
  expect(button("Previous").disabled).toBe(true);
  expect(query().has("until")).toBe(false);
  const go = async (action: string, page: number, until = recordsUntil) => {
    fireEvent.click(button(action));
    await screen.findByText(`result-${page}`);
    expect(query().get("page")).toBe(String(page));
    expect(query().get("until")).toBe(String(until));
    expect(query().has("cursor")).toBe(false);
    expect(query().has("refresh")).toBe(false);
  };
  await go("Last", 4);
  expect(button("Next").disabled).toBe(true);
  expect(button("Last").disabled).toBe(true);
  await go("Previous", 3);
  await go("First", 1);
  fireEvent.change(screen.getByRole("spinbutton", { name: "Page number" }), {
    target: { value: "3" },
  });
  await go("Jump", 3);
  fireEvent.click(button("Refresh"));
  await screen.findByText("result-1");
  expect(query().get("page")).toBe("1");
  expect(query().get("refresh")).toBe("1");
  expect(query().has("until")).toBe(false);
  await go("Next", 2, refreshedUntil);
});

it("formats UTC and fractional local offsets across both date boundaries", () => {
  expect(formatRecordTime(new Date("2026-06-01T20:45:00Z"), "Asia/Kolkata")).toEqual({
    utc: "01 Jun 2026, 20:45 UTC",
    local: "02 Jun, 02:15 UTC+5:30",
  });
  expect(formatRecordTime(new Date("2026-01-01T01:00:00Z"), "America/St_Johns")).toEqual({
    utc: "01 Jan 2026, 01:00 UTC",
    local: "31 Dec 2025, 21:30 UTC-3:30",
  });
  expect(formatRecordTime(new Date("2026-06-01T00:00:00Z"), "UTC").local).toBe("00:00 UTC+0");
});
