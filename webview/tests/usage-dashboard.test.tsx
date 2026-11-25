import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { JourneyEvent, UsageObservation } from "../../shared/usage";
import { App } from "../src/App";
import { UsageDashboard } from "../src/usage/UsageDashboard";
import { FakeSocket } from "./fakeSocket";

const observation = (id: string, fields: Partial<UsageObservation> = {}): UsageObservation => ({
  id,
  source: "pi",
  unit: "inference",
  sessionId: "pi-session",
  timestamp: null,
  model: null,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  price: { kind: "unpriced", usd: null },
  ...fields,
});
const usageResponse = (
  observations: UsageObservation[],
  events: JourneyEvent[] = [],
  incompleteSources?: number,
) => Response.json({ observations, events, incompleteSources });

afterEach(() => vi.unstubAllGlobals());

it("opens Usage from the sidebar, fetches on open and refresh, and reports weighted and inference shares separately", async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  const fetchUsage = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      usageResponse([
        observation("exact", {
          cacheRead: 96,
          cacheWrite: 4,
          price: { kind: "api-equivalent", usd: 0.25 },
        }),
        observation("below", {
          cacheRead: 959,
          input: 41,
          price: { kind: "api-equivalent", usd: 0.125 },
        }),
        observation("output-only", { output: 10 }),
        observation("turn", {
          source: "codex",
          unit: "turn",
          input: 100,
          price: { kind: "channel-estimate", usd: 0.5 },
        }),
        observation("session", {
          source: "acp",
          unit: "session",
          input: 800,
          price: { kind: "reported", usd: 0 },
        }),
      ]),
    )
    .mockResolvedValueOnce(usageResponse([], [], 2))
    .mockResolvedValueOnce(usageResponse([observation("zero")]));
  vi.stubGlobal("fetch", fetchUsage);
  render(<App />);

  expect(fetchUsage).not.toHaveBeenCalled();
  const opener = screen.getByRole("button", { name: "Usage" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = within(screen.getByRole("dialog", { name: "Usage dashboard" }));
  expect(dialog.getByRole("status").textContent).toBe("Loading usage…");
  expect((await dialog.findByText("52.75%")).parentElement?.textContent).toContain(
    "1,055 cache-read / 2,000 prompt tokens",
  );
  expect(dialog.getByText("50%").parentElement?.textContent).toContain(
    "1 of 2 eligible inference observations",
  );
  expect(dialog.getByText(/Sample size: 2/).textContent).toContain(
    "40% (2 of 5). 3 returned observations are inference-level",
  );
  expect(
    dialog.getByText("Weighted cache read share reference: 98% (reference only)."),
  ).toBeTruthy();
  expect(
    dialog.getByText(
      "Share of eligible inferences with at least 96% cache reads: 99% reference only.",
    ),
  ).toBeTruthy();
  for (const [label, value] of Object.entries({
    "Uncached input": "941",
    "Cache read": "1,055",
    "Cache write": "4",
    Output: "10",
    "Total tokens": "2,010",
    "API-equivalent": "$0.375 USD",
    "Channel estimate": "$0.5 USD",
    Reported: "$0 USD",
    "Unpriced observations": "1",
  })) {
    expect(dialog.getByText(label, { exact: true }).nextElementSibling?.textContent).toBe(value);
  }

  fireEvent.click(dialog.getByRole("button", { name: "Refresh" }));
  expect(await dialog.findByText("No usage observations returned.")).toBeTruthy();
  expect(dialog.getByText("Unavailable or partially decoded usage sources: 2")).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Usage dashboard" })).toBeNull();
  expect(document.activeElement).toBe(opener);
  fireEvent.click(opener);
  expect(await screen.findAllByText("Not available")).toHaveLength(2);
  expect(screen.queryByText(/Unavailable or partially decoded usage sources/)).toBeNull();
  expect(fetchUsage.mock.calls.map(([url]) => url)).toEqual(Array(3).fill("api/usage"));
});

it("shows recorded Journey facts in timestamp order without filling unknown fields", async () => {
  const fetchUsage = vi.fn<typeof fetch>().mockResolvedValue(
    usageResponse(
      [
        observation("late", {
          source: "codex",
          unit: "turn",
          timestamp: Date.UTC(2026, 5, 2),
          turnId: "turn-42",
          sessionId: "codex-session",
          model: "codex-model",
          channel: "account-channel",
          input: 42,
          cacheRead: 958,
          cacheWrite: 10,
          output: 20,
          price: { kind: "api-equivalent", usd: 0.000123, asOf: "2026-06-01" },
          toolCalls: [{ id: "tool-1", name: "read" }],
        }),
        observation("untimed", { source: "acp", unit: "session", sessionId: "acp-session" }),
        observation("early", {
          timestamp: Date.UTC(2026, 5, 1),
          input: 1,
          cacheRead: 96,
          cacheWrite: 3,
          output: 7,
          price: { kind: "reported", usd: 0 },
        }),
      ],
      [
        {
          id: "event-compaction",
          kind: "compaction",
          source: "pi",
          sessionId: "pi-session",
          timestamp: Date.UTC(2026, 5, 1, 12),
          name: "Context compacted",
        },
        {
          id: "event-tool",
          kind: "tool",
          source: "codex",
          sessionId: "codex-session",
          turnId: "turn-unmatched",
          timestamp: Date.UTC(2026, 5, 2, 12),
          name: "shell",
        },
        {
          id: "event-only",
          kind: "tool",
          source: "acp",
          sessionId: "codex-session",
          timestamp: null,
          name: "search",
        },
      ],
    ),
  );
  vi.stubGlobal("fetch", fetchUsage);
  render(<UsageDashboard onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Journey" }));
  const journey = await screen.findByRole("list", { name: "Recorded observations and events" });
  const rows = [...journey.children].map((element) => element.textContent);
  expect(rows[0]).toContain("Pi · inference · 2026-06-01T00:00:00.000Z");
  expect(rows[0]).toContain("ChannelUnknown");
  expect(rows[0]).toContain("Cache read share96% · 96 cache-read / 100 prompt tokens");
  expect(rows[0]).toContain("Reported · $0 USD");
  expect(rows[1]).toContain("Pi · compaction · 2026-06-01T12:00:00.000Z");
  expect(rows[1]).toContain("Sessionpi-sessionNameContext compacted");
  expect(rows[1]).not.toContain("Turn");
  expect(rows[2]).toContain("Codex · turn · 2026-06-02T00:00:00.000Z");
  expect(rows[2]).toContain(
    "IDlateSessioncodex-sessionTurnturn-42Channelaccount-channelModelcodex-model",
  );
  expect(rows[2]).toContain("42 uncached input · 958 cache read · 10 cache write · 20 output");
  expect(rows[2]).toContain("API-equivalent · $0.000123 USD · as of 2026-06-01");
  expect(rows[2]).toContain("Linked toolsread (tool-1)");
  expect(rows[2]).not.toContain("Cache read share");
  expect(rows[3]).toContain("Codex · tool · 2026-06-02T12:00:00.000Z");
  expect(rows[3]).toContain("IDevent-toolSessioncodex-sessionTurnturn-unmatchedNameshell");
  expect(rows[3]).not.toContain("turn-42");
  expect(rows[4]).toContain("ACP · session · Timestamp unknown");
  expect(rows[4]).toContain("ModelUnknown");
  expect(rows[4]).toContain("PriceUnpriced");
  expect(rows[4]).not.toContain("Linked tools");
  expect(rows[5]).toContain("ACP · tool · Timestamp unknown");
  fireEvent.change(screen.getByRole("combobox", { name: "Journey session" }), {
    target: {
      value: screen.getByRole<HTMLOptionElement>("option", { name: "Codex · codex-session" }).value,
    },
  });
  expect([...journey.children].map((element) => element.textContent)).toEqual([rows[2], rows[3]]);
  expect(fetchUsage).toHaveBeenCalledTimes(1);
});

it("supersedes pending requests and exposes a refreshable error instead of stale data", async () => {
  let finishFirst!: (response: Response) => void;
  const fetchUsage = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(new Promise<Response>((resolve) => (finishFirst = resolve)))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(usageResponse([]));
  vi.stubGlobal("fetch", fetchUsage);
  render(<UsageDashboard onClose={vi.fn()} />);
  const refresh = screen.getByRole("button", { name: "Refresh" });
  fireEvent.click(refresh);
  expect(await screen.findByText("Could not load usage.")).toBeTruthy();
  expect(fetchUsage.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await act(async () => {
    finishFirst(usageResponse([observation("stale")]));
    await Promise.resolve();
  });
  expect(screen.getByRole("status").textContent).toBe("Could not load usage.");
  fireEvent.click(refresh);
  expect(await screen.findByText("No usage observations returned.")).toBeTruthy();
});

it("bounds Journey rows, distinguishes repeated ACP IDs across sessions, and resets paging on session change", async () => {
  const fetchUsage = vi.fn<typeof fetch>().mockResolvedValue(
    usageResponse(
      Array.from({ length: 52 }, (_, i) =>
        observation(i < 2 ? "acp-index-0" : `record-${i}`, {
          source: "acp",
          sessionId: i === 1 ? "second-session" : "first-session",
          timestamp: i,
        }),
      ),
    ),
  );
  vi.stubGlobal("fetch", fetchUsage);
  const consoleError = vi.spyOn(console, "error");
  try {
    render(<UsageDashboard onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Journey" }));
    const journey = await screen.findByRole("list", { name: "Recorded observations and events" });
    const next = screen.getByRole<HTMLButtonElement>("button", { name: "Next" });
    const previous = screen.getByRole<HTMLButtonElement>("button", { name: "Previous" });
    expect(journey.children).toHaveLength(50);
    expect(within(journey).getAllByText("acp-index-0")).toHaveLength(2);
    expect(
      within(journey).getAllByText("Not available · 0 cache-read / 0 prompt tokens"),
    ).toHaveLength(50);
    expect(previous.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("1–50 of 52");
    fireEvent.click(next);
    expect(journey.children).toHaveLength(2);
    expect(within(journey).getByText("record-51")).toBeTruthy();
    expect(next.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("51–52 of 52");
    fireEvent.click(previous);
    expect(journey.children).toHaveLength(50);
    fireEvent.click(next);
    const sessionOption = screen.getByRole<HTMLOptionElement>("option", {
      name: "ACP · second-session",
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Journey session" }), {
      target: { value: sessionOption.value },
    });
    expect(journey.children).toHaveLength(1);
    expect(within(journey).getByText("second-session")).toBeTruthy();
    expect(
      consoleError.mock.calls
        .flat()
        .some((value) => typeof value === "string" && value.includes("same key")),
    ).toBe(false);
  } finally {
    consoleError.mockRestore();
  }
});
