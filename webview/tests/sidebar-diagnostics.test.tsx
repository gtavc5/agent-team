import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Sidebar } from "../src/sidebar/Sidebar";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function sidebar(connected = true) {
  const noop = vi.fn();
  return render(
    <Sidebar
      connected={connected}
      activeWsId={null}
      workspaces={[]}
      groupOverrides={{}}
      finishedStatus={{}}
      searchQuery=""
      searchHits={null}
      systemStatus={null}
      onSelect={noop}
      onDelete={noop}
      onToggleGroup={noop}
      onSearchChange={noop}
      onJump={noop}
      onCreate={noop}
      onCreateIn={noop}
      onReplayDemo={noop}
      onDebugSnapshot={noop}
      onPurgeArchived={noop}
    />,
  );
}

it.each(["offline", "degraded"])("links to diagnostics when %s", async (state) => {
  const fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ issues: state === "degraded" ? [{}] : [] }),
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await act(() => {
    sidebar(state !== "offline");
    return Promise.resolve();
  });
  expect(fetch).toHaveBeenCalledTimes(state === "degraded" ? 1 : 0);
  expect(screen.getByRole("link", { name: "Service diagnostics" }).getAttribute("href")).toBe(
    "api/diagnostics?format=text",
  );
  expect(screen.getByRole("link", { name: "JSON" }).getAttribute("href")).toBe("api/diagnostics");
});

it("hides diagnostics when healthy", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ issues: [] }) })),
  );
  await act(() => {
    sidebar();
    return Promise.resolve();
  });
  expect(screen.queryByRole("link", { name: "Service diagnostics" })).toBeNull();
});

it("surfaces diagnostics when a connected service later becomes degraded", async () => {
  vi.useFakeTimers();
  let issues: object[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ issues }) })),
  );
  await act(() => {
    sidebar();
    return Promise.resolve();
  });
  expect(screen.queryByRole("link", { name: "Service diagnostics" })).toBeNull();
  issues = [{}];
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.getByRole("link", { name: "Service diagnostics" })).toBeTruthy();
});
