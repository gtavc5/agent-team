import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { Sidebar, type SidebarProps } from "../../src/sidebar/Sidebar";
import "../../src/styles.css";

const TRIGGER = "Save snapshot and open debug tools";
const noop = () => {};
const rect = (el: Element) => el.getBoundingClientRect();
const style = (el: Element) => getComputedStyle(el);
const channels = (color: string) =>
  color
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map(Number);
const luminance = (rgb: number[]) => {
  const linear = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
const smallTextContrast = (strip: HTMLElement, sidebar: HTMLElement) => {
  const alpha = Number(style(strip).opacity);
  const foreground = channels(style(strip).color);
  const background = channels(style(sidebar).backgroundColor);
  const mixed = foreground.map((value, i) => value * alpha + background[i] * (1 - alpha));
  const text = luminance(mixed);
  const backdrop = luminance(background);
  return (Math.max(text, backdrop) + 0.05) / (Math.min(text, backdrop) + 0.05);
};
const get = <T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string) => {
  const element = root.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
};

const props: SidebarProps = {
  workspaces: [],
  activeWsId: null,
  connected: true,
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
  onCreateProject: noop,
  onCreateIn: noop,
  onReplayDemo: noop,
  onDebugSnapshot: () => Promise.resolve(),
  onPurgeArchived: noop,
};

function healthyProbe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ issues: [] }) })),
  );
}

function MobileDrawer({
  onDebugSnapshot,
  initialOpen = true,
}: {
  onDebugSnapshot: SidebarProps["onDebugSnapshot"];
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div className="app">
      <button
        type="button"
        className={open ? "" : "mobile-menu-btn"}
        style={{ position: "fixed", top: 8, right: 8, zIndex: 200 }}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Close drawer" : "Open drawer"}
      </button>
      <div className={`sidebar${open ? " sidebar-open" : ""}`}>
        <Sidebar
          {...props}
          connected={false}
          sidebarOpen={open}
          onDebugSnapshot={onDebugSnapshot}
        />
      </div>
    </div>
  );
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, "", location.pathname);
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

it("unfolds a visible desktop strip and honors reduced motion", async () => {
  await page.viewport(1280, 800);
  healthyProbe();
  const { container } = render(
    <div className="app" style={{ height: "100dvh" }}>
      <aside className="sidebar" style={{ width: 280 }}>
        <Sidebar {...props} />
      </aside>
    </div>,
  );
  const sidebar = get(container, ".sidebar");
  const header = get(container, ".sidebar-header");
  const trigger = screen.getByRole("button", { name: TRIGGER });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector(".sidebar-debug-strip")).toBeNull();

  fireEvent.click(trigger);
  const strip = get(container, ".sidebar-debug-strip");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(style(strip).animationName).toBe("sidebar-debug-unfold");
  expect(style(strip).visibility).toBe("visible");
  await expect.poll(() => rect(strip).height).toBeGreaterThan(20);
  await expect.poll(() => style(strip).opacity).toBe("0.9");
  expect(smallTextContrast(strip, sidebar)).toBeGreaterThanOrEqual(4.5);
  expect(rect(strip).top).toBeCloseTo(rect(header).bottom, 0);
  expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
  expect(sidebar.scrollWidth).toBeLessThanOrEqual(sidebar.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(style(get(container, ".sidebar-debug-strip")).animationName).toBe("none");
});

it("fits the offline 280px mobile drawer and resets after close and reopen", async () => {
  await page.viewport(390, 844);
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  const { container } = render(<MobileDrawer onDebugSnapshot={onDebugSnapshot} />);
  const sidebar = get(container, ".sidebar");
  const header = get(container, ".sidebar-header");
  expect(sidebar.textContent).toContain("offline");
  expect(screen.getByRole("link", { name: "Service diagnostics" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "JSON" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  const strip = get(container, ".sidebar-debug-strip");
  await expect.poll(() => style(strip).opacity).toBe("0.9");
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
  expect(rect(strip).top).toBeCloseTo(rect(header).bottom, 0);
  expect(rect(strip).left).toBeGreaterThanOrEqual(0);
  expect(rect(strip).right).toBeLessThanOrEqual(280);
  expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
  expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
  expect(sidebar.scrollWidth).toBeLessThanOrEqual(280);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  for (const control of strip.querySelectorAll("a, button")) {
    expect(rect(control).left).toBeGreaterThanOrEqual(0);
    expect(rect(control).right).toBeLessThanOrEqual(280);
  }

  fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
  expect(container.querySelector(".sidebar-debug-strip")).toBeNull();
  expect(screen.getByRole("button", { name: TRIGGER }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Open drawer" }));
  expect(container.querySelector(".sidebar-debug-strip")).toBeNull();
  expect(screen.getByRole("button", { name: TRIGGER }).getAttribute("aria-expanded")).toBe("false");
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
});

it("keeps ?debug=1 controls untabbable while the initial mobile drawer is closed", async () => {
  await page.viewport(390, 844);
  history.replaceState(null, "", "?debug=1");
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  const { container } = render(
    <MobileDrawer onDebugSnapshot={onDebugSnapshot} initialOpen={false} />,
  );
  const strip = get(container, ".sidebar-debug-strip");
  expect(style(strip).display).toBe("none");
  expect(onDebugSnapshot).not.toHaveBeenCalled();

  const focused: string[] = [];
  for (let i = 0; i < 10; i++) {
    await userEvent.tab();
    const active = document.activeElement;
    focused.push(active?.textContent ?? "", active?.getAttribute("aria-label") ?? "");
  }
  expect(focused).not.toContain("Diagnostics");
  expect(focused).not.toContain("Demo");
  expect(focused).not.toContain("Snapshot");

  fireEvent.click(screen.getByRole("button", { name: "Open drawer" }));
  expect(style(strip).display).toBe("flex");
  expect(screen.getByRole("button", { name: TRIGGER }).getAttribute("aria-expanded")).toBe("true");
  expect(onDebugSnapshot).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
  expect(container.querySelector(".sidebar-debug-strip")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open drawer" }));
  expect(container.querySelector(".sidebar-debug-strip")).toBeNull();
  expect(onDebugSnapshot).not.toHaveBeenCalled();
});
