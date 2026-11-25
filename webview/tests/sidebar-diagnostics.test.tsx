import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Sidebar, type SidebarProps } from "../src/sidebar/Sidebar";

const TRIGGER = "Save snapshot and open debug tools";
const DEMO = "Replay rendering demo (synthetic events for visual review)";

function healthResponse(issues: object[] = []) {
  return { ok: true, json: () => Promise.resolve({ issues }) };
}

function stubHealth(issues: object[] = []) {
  const fetch = vi.fn(() => Promise.resolve(healthResponse(issues)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sidebar(connected = true, over: Partial<SidebarProps> = {}) {
  const noop = vi.fn();
  const props: SidebarProps = {
    connected,
    activeWsId: null,
    workspaces: [],
    groupOverrides: {},
    finishedStatus: {},
    searchQuery: "",
    searchHits: null,
    systemStatus: null,
    onSelect: noop,
    onDelete: noop,
    onToggleGroup: noop,
    onSearchChange: noop,
    onJump: noop,
    onCreate: noop,
    onCreateIn: noop,
    onReplayDemo: noop,
    onDebugSnapshot: noop,
    onPurgeArchived: noop,
    ...over,
  };
  const view = render(<Sidebar {...props} />);
  return { ...view, props };
}

function expectStripClosed() {
  expect(screen.queryByRole("group", { name: "Debug tools" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Diagnostics" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Demo" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Snapshot" })).toBeNull();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  history.replaceState(null, "", location.pathname);
});

it("always shows #, captures before unfolding, and deduplicates an in-flight upload", async () => {
  stubHealth();
  const upload = deferred();
  const onDebugSnapshot = vi
    .fn()
    .mockImplementationOnce(() => {
      // App's synchronous collectSnapshot() runs inside this callback.
      expect(screen.queryByRole("group", { name: "Debug tools" })).toBeNull();
      expect(screen.getByRole("button", { name: TRIGGER }).getAttribute("aria-expanded")).toBe(
        "false",
      );
      return upload.promise;
    })
    .mockImplementation(() => Promise.resolve());
  sidebar(true, { onDebugSnapshot });
  await act(async () => {});

  const trigger = screen.getByRole("button", { name: TRIGGER });
  expect(trigger.getAttribute("title")).toBe(TRIGGER);
  fireEvent.click(trigger);
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const snapshot = screen.getByRole("button", { name: "Snapshot" });
  expect(snapshot.hasAttribute("disabled")).toBe(true);

  // Neither repeated explicit saves nor close/reopen can overlap the upload.
  fireEvent.click(snapshot);
  fireEvent.click(trigger);
  expectStripClosed();
  fireEvent.click(trigger);
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);

  upload.resolve();
  await act(async () => {});
  expect(screen.getByRole("button", { name: "Snapshot" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Snapshot" }));
  expect(onDebugSnapshot).toHaveBeenCalledTimes(2);
  await act(async () => {});
});

it("keeps the strip open and re-enables Snapshot when an upload fails", async () => {
  stubHealth();
  const upload = deferred();
  const onDebugSnapshot = vi.fn(() => upload.promise);
  sidebar(true, { onDebugSnapshot });
  await act(async () => {});

  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  upload.reject(new Error("read-only filesystem"));
  await act(async () => {});

  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();
  expect(screen.getByRole("button", { name: TRIGGER }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "Snapshot" }).hasAttribute("disabled")).toBe(false);
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
});

it.each(["trigger", "outside", "demo"] as const)(
  "collapses via %s without capturing again or leaving controls focusable",
  async (method) => {
    stubHealth();
    const onDebugSnapshot = vi.fn(() => new Promise<void>(() => {}));
    const onReplayDemo = vi.fn();
    sidebar(true, { onDebugSnapshot, onReplayDemo });
    await act(async () => {});

    const trigger = screen.getByRole("button", { name: TRIGGER });
    fireEvent.click(trigger);
    expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();
    if (method === "trigger") fireEvent.click(trigger);
    if (method === "outside") fireEvent.click(document.body);
    if (method === "demo") fireEvent.click(screen.getByRole("button", { name: "Demo" }));

    expectStripClosed();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
    expect(onReplayDemo).toHaveBeenCalledTimes(method === "demo" ? 1 : 0);
  },
);

it("collapses on an outside workspace action even when it stops click propagation", async () => {
  stubHealth();
  const onDebugSnapshot = vi.fn(() => new Promise<void>(() => {}));
  const onCreateIn = vi.fn();
  sidebar(true, {
    onDebugSnapshot,
    onCreateIn,
    workspaces: [
      {
        id: "w",
        name: "w",
        hostId: "local",
        project: "repo",
        cwd: "/repo",
        agents: [],
        messages: [],
        createdAt: 1,
        git: null,
        pr: null,
      },
    ],
  });
  await act(async () => {});

  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  fireEvent.click(screen.getByTitle("New workspace in /repo"));
  expect(onCreateIn).toHaveBeenCalledWith("/repo");
  expectStripClosed();
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
});

it("restores focus to # on Escape without another snapshot", async () => {
  stubHealth();
  const onDebugSnapshot = vi.fn(() => new Promise<void>(() => {}));
  sidebar(true, { onDebugSnapshot });
  await act(async () => {});

  const trigger = screen.getByRole("button", { name: TRIGGER });
  fireEvent.click(trigger);
  const demo = screen.getByRole("button", { name: "Demo" });
  demo.focus();
  fireEvent.keyDown(demo, { key: "Escape" });

  expectStripClosed();
  expect(document.activeElement).toBe(trigger);
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
});

it("resets on a mobile drawer close and stays collapsed when reopened", async () => {
  stubHealth();
  const onDebugSnapshot = vi.fn(() => new Promise<void>(() => {}));
  const view = sidebar(true, { sidebarOpen: true, onDebugSnapshot });
  await act(async () => {});

  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();
  view.rerender(<Sidebar {...view.props} sidebarOpen={false} />);
  expectStripClosed();
  view.rerender(<Sidebar {...view.props} sidebarOpen={true} />);
  expectStripClosed();
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
});

it("starts open for ?debug=1 without auto-capturing and exposes only text debug controls", async () => {
  history.replaceState(null, "", "?debug=1");
  const fetch = stubHealth();
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  const onReplayDemo = vi.fn();
  sidebar(true, { onDebugSnapshot, onReplayDemo });

  expect(onDebugSnapshot).not.toHaveBeenCalled();
  const diagnostics = screen.getByRole("link", { name: "Diagnostics" });
  expect(diagnostics.getAttribute("href")).toBe("api/diagnostics?format=text");
  expect(diagnostics.getAttribute("target")).toBe("_blank");
  expect(diagnostics.getAttribute("rel")).toBe("noreferrer");
  expect(screen.getByTitle(DEMO)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Snapshot" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "JSON" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Service diagnostics" })).toBeNull();

  await act(async () => {});
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("link", { name: "Service diagnostics" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Snapshot" }));
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Demo" }));
  expect(onReplayDemo).toHaveBeenCalledTimes(1);
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
  expectStripClosed();
});

it("does not flash diagnostics while the initial health probe is unknown", async () => {
  const probe = deferred();
  const fetch = vi.fn(() => probe.promise.then(() => healthResponse()));
  vi.stubGlobal("fetch", fetch);
  sidebar();

  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("link", { name: "Service diagnostics" })).toBeNull();
  expect(screen.getByRole("button", { name: TRIGGER })).toBeTruthy();
  expectStripClosed();
  probe.resolve();
  await act(async () => {});
  expect(screen.queryByRole("link", { name: "Service diagnostics" })).toBeNull();
});

it.each(["offline", "unhealthy"] as const)(
  "shows one Service diagnostics link and no JSON when %s",
  async (state) => {
    const fetch = stubHealth(state === "unhealthy" ? [{}] : []);
    sidebar(state !== "offline");
    await act(async () => {});

    expect(fetch).toHaveBeenCalledTimes(state === "offline" ? 0 : 1);
    const links = screen.getAllByRole("link", { name: "Service diagnostics" });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("api/diagnostics?format=text");
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("link", { name: "JSON" })).toBeNull();
    expect(screen.getByRole("button", { name: TRIGGER })).toBeTruthy();
    expectStripClosed();
  },
);

it("surfaces diagnostics when a connected service later becomes degraded", async () => {
  vi.useFakeTimers();
  let issues: object[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(healthResponse(issues))),
  );
  await act(() => {
    sidebar();
    return Promise.resolve();
  });
  expect(screen.queryByRole("link", { name: "Service diagnostics" })).toBeNull();
  issues = [{}];
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.getByRole("link", { name: "Service diagnostics" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "JSON" })).toBeNull();
});
