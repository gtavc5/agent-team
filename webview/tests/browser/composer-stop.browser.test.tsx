import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { App } from "../../src/App";
import { recordTelemetry } from "../../src/telemetry";
import { FakeSocket } from "../fakeSocket";
import "../../src/styles.css";

vi.mock("../../src/telemetry", { spy: true });

const WORKSPACE = {
  id: "w",
  name: "Composer test",
  project: "repo",
  cwd: "/repo",
  hostId: "local",
  agents: ["Alpha", "Beta"].map((name, i) => ({
    id: name,
    name,
    state: "working",
    model: "claude-opus-5-5",
    avatar: name[0],
    color: "#888",
    isDefault: i === 0,
  })),
  messages: [],
  createdAt: 1,
};

let touch = false;
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
  if (touch) await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  touch = false;
});

function boot() {
  localStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  const root = document.createElement("div");
  root.id = "root";
  root.style.cssText = "position:fixed; inset:0; height:100dvh";
  document.body.append(root);
  render(<App />, { container: root });
  const sock = FakeSocket.instances.at(-1)!;
  act(() => {
    sock.open();
    sock.receive({
      type: "init",
      workspaces: [WORKSPACE],
      config: { presets: [], models: [], commands: [], hosts: {} },
      hosts: [],
    });
  });
  const row = root.querySelector<HTMLElement>(".input-row")!;
  const composer = within(row);
  const trigger = composer.getByRole("button", { name: "Stop running agents (2)" });
  expect(row.querySelectorAll(".btn-abort")).toHaveLength(1);
  expect(composer.queryByRole("button", { name: "Queue" })).toBeNull();
  expect(trigger.querySelector(".stop-count")?.textContent).toBe("2");
  const mobile = matchMedia("(hover: none)").matches;
  for (const icon of row.querySelectorAll("button svg")) {
    expect(icon.getBoundingClientRect().width).toBe(16);
    expect(icon.getBoundingClientRect().height).toBe(16);
  }
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  const popup = page.getByRole("group", { name: "Stop running turns" });
  const checkBounds = () => {
    const panel = composer.getByRole("group");
    const bounds = panel.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(innerWidth);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(trigger.getBoundingClientRect().top);
    expect(
      document
        .elementFromPoint(bounds.left + bounds.width / 2, bounds.top + 10)
        ?.closest(".stop-actions"),
    ).toBe(panel);
    if (mobile) expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  };
  return { row, composer, trigger, popup, checkBounds, sock };
}

it("opens on desktop hover, bridges the gap to actions, and supports click and Escape", async () => {
  await page.viewport(1280, 850);
  expect(matchMedia("(hover: hover)").matches).toBe(true);
  const { row, trigger, popup, checkBounds, sock } = boot();
  const button = page.elementLocator(trigger);
  await button.hover();
  await expect.element(popup).toBeVisible();
  checkBounds();
  const rect = trigger.getBoundingClientRect();
  expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top - 3)?.className).toBe(
    "stop-popover",
  );
  await popup.getByRole("button", { name: "Stop Beta" }).hover();
  await expect.element(popup).toBeVisible();
  await page.getByRole("textbox", { name: "" }).first().hover();
  await expect.element(popup).not.toBeInTheDocument();
  await button.click();
  await expect.element(popup).toBeVisible();
  const bridge = row.querySelector<HTMLElement>(".stop-popover")!;
  await page.elementLocator(bridge).click({
    position: { x: bridge.offsetWidth - 15, y: bridge.offsetHeight - 3 },
  });
  await expect.element(popup).toBeVisible();
  trigger.focus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(popup.getByRole("button", { name: "Stop Alpha" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(button).toHaveFocus();
  await expect.element(popup).not.toBeInTheDocument();
  expect(recordTelemetry).not.toHaveBeenCalledWith("chat.stop");
  await button.click();
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(popup.getByRole("button", { name: "Stop all (2)" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(popup).not.toBeInTheDocument();
  expect(sock.frames().filter((f) => f.type === "interrupt")).toEqual([
    { type: "interrupt", workspaceId: "w", agentId: "Alpha" },
    { type: "interrupt", workspaceId: "w", agentId: "Beta" },
  ]);
  expect(
    vi.mocked(recordTelemetry).mock.calls.filter(([action]) => action === "chat.stop"),
  ).toEqual([["chat.stop"]]);
});

async function tap(el: Element) {
  const { x, y, width, height } = el.getBoundingClientRect();
  // The runner scales the test iframe to fit; CDP uses the outer viewport.
  const frame = window.frameElement!.getBoundingClientRect();
  await cdp().send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      {
        x: frame.x + ((x + width / 2) * frame.width) / innerWidth,
        y: frame.y + ((y + height / 2) * frame.height) / innerHeight,
      },
    ],
  });
  await cdp().send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

it("fits at 390×844 and toggles, dismisses and stops a turn using real touch input", async () => {
  touch = true;
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await page.viewport(390, 844);
  expect(matchMedia("(hover: none)").matches).toBe(true);
  const { row, composer, trigger, popup, checkBounds, sock } = boot();
  const badge = trigger.querySelector(".stop-count")!;
  expect(
    trigger.getBoundingClientRect().right - badge.getBoundingClientRect().right,
  ).toBeGreaterThan(2);
  await tap(trigger);
  await expect.element(popup).toBeVisible();
  checkBounds();
  await tap(trigger);
  await expect.element(popup).not.toBeInTheDocument();
  await tap(trigger);
  await expect.element(popup).toBeVisible();
  const input = composer.getByRole("textbox");
  await tap(input);
  await expect.element(popup).not.toBeInTheDocument();

  fireEvent.change(input, { target: { value: "next turn" } });
  const queue = composer.getByRole("button", { name: "Queue" });
  expect(queue.querySelector("svg")!.getBoundingClientRect().width).toBe(16);
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  await tap(trigger);
  await expect.element(popup).toBeVisible();
  checkBounds();
  await tap(composer.getByRole("button", { name: "Stop Beta" }));
  expect(
    vi.mocked(recordTelemetry).mock.calls.filter(([action]) => action === "chat.stop"),
  ).toEqual([["chat.stop"]]);
  await expect.element(popup).not.toBeInTheDocument();
  expect(sock.frames().filter((f) => f.type === "interrupt")).toEqual([
    { type: "interrupt", workspaceId: "w", agentId: "Beta" },
  ]);
});
