import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ICONS } from "../src/panels/Icon";
import { Sidebar, type SidebarProps } from "../src/sidebar/Sidebar";

const TRIGGER = "Debug tools";
const SNAPSHOT = "Capture debug snapshot";
const DEMO = "Replay demo";

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
  expect(screen.queryByRole("link", { name: /Service diagnostics/ })).toBeNull();
  expect(screen.queryByRole("button", { name: DEMO })).toBeNull();
  expect(screen.queryByRole("button", { name: SNAPSHOT })).toBeNull();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  history.replaceState(null, "", location.pathname);
});

it("purely toggles # without auto-capturing and highlights active state", async () => {
  stubHealth();
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  const { container } = sidebar(true, { onDebugSnapshot });
  await act(async () => {});

  const trigger = screen.getByRole("button", { name: TRIGGER });
  expect(trigger.getAttribute("title")).toBe(TRIGGER);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.getAttribute("aria-pressed")).toBe("false");
  expectStripClosed();

  fireEvent.click(trigger);
  expect(onDebugSnapshot).not.toHaveBeenCalled();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(trigger.getAttribute("aria-pressed")).toBe("true");

  const diagnostics = screen.getByRole("link", { name: "Service diagnostics" });
  const demo = screen.getByRole("button", { name: DEMO });
  const snapshot = screen.getByRole("button", { name: SNAPSHOT });
  expect(diagnostics.getAttribute("href")).toBe("api/diagnostics?format=text");
  expect(diagnostics.getAttribute("target")).toBe("_blank");
  expect(diagnostics.getAttribute("rel")).toBe("noopener noreferrer");
  expect(diagnostics.textContent).toBe("");
  expect(demo.textContent).toBe("");
  expect(snapshot.textContent).toBe("");

  // Distinct linear SVG icons for #, Diagnostics, Demo, and Snapshot (camera != #).
  const triggerPath = trigger.querySelector("svg path")?.getAttribute("d");
  const diagnosticsPath = diagnostics.querySelector("svg path")?.getAttribute("d");
  const demoPath = demo.querySelector("svg path")?.getAttribute("d");
  const snapshotPath = snapshot.querySelector("svg path")?.getAttribute("d");
  expect(triggerPath).toBe(ICONS.debug);
  expect(diagnosticsPath).toBe(ICONS.diagnostics);
  expect(demoPath).toBe(ICONS.play);
  expect(snapshotPath).toBe(ICONS.camera);
  expect(new Set([triggerPath, diagnosticsPath, demoPath, snapshotPath]).size).toBe(4);
  expect(container.querySelectorAll(".sidebar-debug-dot")).toHaveLength(0);

  fireEvent.click(trigger);
  expectStripClosed();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.getAttribute("aria-pressed")).toBe("false");
  expect(onDebugSnapshot).not.toHaveBeenCalled();
});

it("handles consecutive Snapshot clicks with anti-reentry guard and uploading/saved/error feedback", async () => {
  stubHealth();
  const first = deferred();
  const second = deferred();
  const onDebugSnapshot = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
    .mockImplementationOnce(() => Promise.resolve());
  sidebar(true, { onDebugSnapshot });
  await act(async () => {});

  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  expect(onDebugSnapshot).not.toHaveBeenCalled();

  const snapshot = screen.getByRole("button", { name: SNAPSHOT });
  fireEvent.click(snapshot);
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
  expect(snapshot.hasAttribute("disabled")).toBe(true);
  expect(snapshot.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("status").textContent).toBe("Saving snapshot…");

  // Repeated clicks and toggling # cannot overlap an in-flight upload.
  fireEvent.click(snapshot);
  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  expectStripClosed();
  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  expect(screen.getByRole("button", { name: SNAPSHOT }).hasAttribute("disabled")).toBe(true);
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);

  first.resolve();
  await act(async () => {});
  expect(screen.getByRole("button", { name: SNAPSHOT }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("status").textContent).toBe("Snapshot saved");

  // Consecutive click starts immediately and surfaces failure without closing the strip.
  fireEvent.click(screen.getByRole("button", { name: SNAPSHOT }));
  expect(onDebugSnapshot).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status").textContent).toBe("Saving snapshot…");

  second.reject(new Error("read-only filesystem"));
  await act(async () => {});
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();
  expect(screen.getByRole("button", { name: SNAPSHOT }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("status").textContent).toBe("Snapshot failed");

  // Subsequent retry after failure succeeds.
  fireEvent.click(screen.getByRole("button", { name: SNAPSHOT }));
  await act(async () => {});
  expect(onDebugSnapshot).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("status").textContent).toBe("Snapshot saved");
});

it("keeps the strip open on outside clicks, workspace actions, and desktop Demo clicks", async () => {
  stubHealth();
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  const onReplayDemo = vi.fn();
  const onCreateIn = vi.fn();
  sidebar(true, {
    onDebugSnapshot,
    onReplayDemo,
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

  const trigger = screen.getByRole("button", { name: TRIGGER });
  fireEvent.click(trigger);
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();

  fireEvent.click(document.body);
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();

  fireEvent.click(screen.getByTitle("New workspace in /repo"));
  expect(onCreateIn).toHaveBeenCalledWith("/repo");
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: DEMO }));
  expect(onReplayDemo).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(onDebugSnapshot).not.toHaveBeenCalled();
});

it("restores focus to # on Escape without capturing", async () => {
  stubHealth();
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  sidebar(true, { onDebugSnapshot });
  await act(async () => {});

  const trigger = screen.getByRole("button", { name: TRIGGER });
  fireEvent.click(trigger);
  const demo = screen.getByRole("button", { name: DEMO });
  demo.focus();
  fireEvent.keyDown(demo, { key: "Escape" });

  expectStripClosed();
  expect(document.activeElement).toBe(trigger);
  expect(onDebugSnapshot).not.toHaveBeenCalled();
});

it("resets on a mobile drawer close and stays collapsed when reopened", async () => {
  stubHealth();
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  const view = sidebar(true, { sidebarOpen: true, onDebugSnapshot });
  await act(async () => {});

  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();
  view.rerender(<Sidebar {...view.props} sidebarOpen={false} />);
  expectStripClosed();
  view.rerender(<Sidebar {...view.props} sidebarOpen={true} />);
  expectStripClosed();
  expect(onDebugSnapshot).not.toHaveBeenCalled();
});

it("starts open for ?debug=1 without auto-capturing and exposes one Diagnostics entry", async () => {
  history.replaceState(null, "", "?debug=1");
  const fetch = stubHealth();
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  const onReplayDemo = vi.fn();
  sidebar(true, { onDebugSnapshot, onReplayDemo });

  expect(onDebugSnapshot).not.toHaveBeenCalled();
  const links = screen.getAllByRole("link", { name: "Service diagnostics" });
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute("href")).toBe("api/diagnostics?format=text");
  expect(links[0].getAttribute("target")).toBe("_blank");
  expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
  expect(screen.getByRole("button", { name: DEMO })).toBeTruthy();
  expect(screen.getByRole("button", { name: SNAPSHOT })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "JSON" })).toBeNull();

  await act(async () => {});
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: SNAPSHOT }));
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: DEMO }));
  expect(onReplayDemo).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();
});

it("does not flash an abnormal indicator while the initial health probe is unknown", async () => {
  const probe = deferred();
  const fetch = vi.fn(() => probe.promise.then(() => healthResponse()));
  vi.stubGlobal("fetch", fetch);
  const { container } = sidebar();

  expect(fetch).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll(".sidebar-debug-dot")).toHaveLength(0);
  expect(screen.queryByRole("link", { name: /Service diagnostics/ })).toBeNull();
  expect(screen.getByRole("button", { name: TRIGGER })).toBeTruthy();
  expectStripClosed();

  probe.resolve();
  await act(async () => {});
  expect(container.querySelectorAll(".sidebar-debug-dot")).toHaveLength(0);
  expect(screen.queryByRole("link", { name: /Service diagnostics/ })).toBeNull();
});

it.each(["offline", "unhealthy"] as const)(
  "places a single abnormal dot on # when collapsed and moves it to the single Diagnostics entry when expanded (%s)",
  async (state) => {
    const fetch = stubHealth(state === "unhealthy" ? [{}] : []);
    const { container } = sidebar(state !== "offline");
    await act(async () => {});

    expect(fetch).toHaveBeenCalledTimes(state === "offline" ? 0 : 1);
    expectStripClosed();
    expect(screen.queryByRole("link", { name: /Service diagnostics/ })).toBeNull();

    // Collapsed: dot appears only on #, with accessible unhealthy/offline text.
    const collapsedTrigger = screen.getByRole("button", {
      name: `Debug tools (service diagnostics ${state})`,
    });
    expect(collapsedTrigger.getAttribute("title")).toBe(
      `Debug tools (service diagnostics ${state})`,
    );
    const collapsedDots = container.querySelectorAll(".sidebar-debug-dot");
    expect(collapsedDots).toHaveLength(1);
    expect(collapsedTrigger.contains(collapsedDots[0])).toBe(true);
    expect(collapsedDots[0].getAttribute("aria-hidden")).toBe("true");

    // Expanded: dot moves from # to the single Diagnostics icon link.
    fireEvent.click(collapsedTrigger);
    const expandedTrigger = screen.getByRole("button", { name: TRIGGER });
    const links = screen.getAllByRole("link", { name: `Service diagnostics (${state})` });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("api/diagnostics?format=text");
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[0].getAttribute("title")).toBe(`Service diagnostics (${state})`);
    expect(screen.queryByRole("link", { name: "JSON" })).toBeNull();

    const expandedDots = container.querySelectorAll(".sidebar-debug-dot");
    expect(expandedDots).toHaveLength(1);
    expect(expandedTrigger.contains(expandedDots[0])).toBe(false);
    expect(links[0].contains(expandedDots[0])).toBe(true);
    expect(expandedDots[0].getAttribute("aria-hidden")).toBe("true");
  },
);

it("surfaces the abnormal indicator when a connected service later becomes degraded", async () => {
  vi.useFakeTimers();
  let issues: object[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(healthResponse(issues))),
  );
  let container!: HTMLElement;
  await act(() => {
    ({ container } = sidebar());
    return Promise.resolve();
  });
  expect(container.querySelectorAll(".sidebar-debug-dot")).toHaveLength(0);
  expect(screen.getByRole("button", { name: TRIGGER })).toBeTruthy();

  issues = [{}];
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  const trigger = screen.getByRole("button", {
    name: "Debug tools (service diagnostics unhealthy)",
  });
  expect(container.querySelectorAll(".sidebar-debug-dot")).toHaveLength(1);
  expect(trigger.contains(container.querySelector(".sidebar-debug-dot"))).toBe(true);
  expect(screen.queryByRole("link", { name: /Service diagnostics/ })).toBeNull();
});
