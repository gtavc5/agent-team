import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { App } from "../../src/App";
import type { UiDialogRequest, Workspace } from "../../src/state/useServer";
import { UiDialogModal } from "../../src/workspace/UiDialogModal";
import { FakeSocket } from "../fakeSocket";
import "../../src/styles.css";

const get = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const rect = (el: Element) => el.getBoundingClientRect();
const request = (over: Partial<UiDialogRequest> = {}): UiDialogRequest => ({
  requestId: "request-1",
  workspaceId: "w1",
  agentId: "a1",
  processGeneration: 3,
  method: "select",
  title: "Permission needed",
  message: "Choose how to continue.",
  options: ["Allow", "Deny"],
  timeoutMs: 60_000,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  ...over,
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

it.each([
  [1100, "light"],
  [360, "dark"],
] as const)("separates modal message and controls at %ipx in %s mode", async (width, theme) => {
  await page.viewport(width, 760);
  document.documentElement.dataset.theme = theme;
  for (const method of ["select", "input", "editor"] as const) {
    const view = render(<UiDialogModal dialog={request({ method })} onRespond={() => true} />);
    const msg = get(".ui-dialog-message");
    const controlMark = get(
      method === "select" ? ".ui-dialog-option" : ".ui-dialog-response label > span",
    );
    await expect.poll(() => rect(controlMark).top - rect(msg).bottom).toBeCloseTo(12, 0);
    if (method === "select") {
      const style = getComputedStyle(controlMark);
      const messageStyle = getComputedStyle(msg);
      expect([style.fontSize, style.lineHeight]).toEqual([
        messageStyle.fontSize,
        messageStyle.lineHeight,
      ]);
      const first = page.getByRole("button", { name: "Allow" });
      const second = page.getByRole("button", { name: "Deny" });
      await expect.element(first).toHaveFocus();
      const resting = getComputedStyle(second.element()).borderTopColor;
      await second.hover();
      expect(getComputedStyle(second.element()).borderTopColor).not.toBe(resting);
      await page.getByText("Choose how to continue.").hover();
      await userEvent.tab();
      await expect.element(second).toHaveFocus();
      expect(getComputedStyle(second.element()).borderTopColor).not.toBe(resting);
    }
    view.unmount();
  }
});

it("anchors a background session alert above a growing composer and its safe-area inset", async () => {
  await page.viewport(360, 740);
  document.documentElement.dataset.theme = "dark";
  const session = cdp();
  await session.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 34 } });
  try {
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeSocket);
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    render(<App />, { container: root });
    const sock = FakeSocket.instances.at(-1)!;
    const workspace = (id: string): Workspace => ({
      id,
      name: id,
      project: "repo",
      cwd: "/repo",
      hostId: "local",
      createdAt: 1,
      messages: [],
      agents: [
        { id: "a1", name: "Alice", avatar: "A", color: "#888", model: "model", isDefault: true },
      ],
    });
    act(() => {
      sock.open();
      sock.receive({
        type: "init",
        workspaces: [workspace("w1"), workspace("w2")],
        config: { presets: [], models: [], commands: [], hosts: {} },
        hosts: [],
      });
      sock.receive({
        type: "workspace_messages",
        workspaceId: "w1",
        messages: Array.from({ length: 18 }, (_, index) => ({
          id: `m${index}`,
          kind: "agent",
          agentId: "a1",
          status: "done",
          timestamp: 1000 + index,
          content: "Enough history to scroll the transcript. ".repeat(7),
        })),
        hasMore: false,
      });
    });
    const composer = get(".input-area");
    const initialComposer = rect(composer);
    act(() => sock.receive({ type: "ui_dialog_request", dialog: request({ workspaceId: "w2" }) }));
    const alert = get(".ui-dialog-alert");
    expect(rect(composer).toJSON()).toEqual(initialComposer.toJSON());
    const textarea = get<HTMLTextAreaElement>(".chat-input");
    const action = page.getByRole("button", { name: "Open session" });
    const clearance = () => rect(composer).top - rect(alert).bottom;
    expect(getComputedStyle(composer).paddingBottom).toBe("38px");
    expect(clearance()).toBeCloseTo(8, 0);
    const initialTop = rect(alert).top;
    fireEvent.change(textarea, { target: { value: "Draft\n".repeat(12) } });
    await expect.poll(() => initialTop - rect(alert).top).toBeGreaterThan(40);
    expect(clearance()).toBeCloseTo(8, 0);
    const center = rect(textarea);
    expect(
      document.elementFromPoint(center.left + center.width / 2, center.top + center.height / 2),
    ).toBe(textarea);

    const transcript = get(".messages");
    transcript.scrollTop = 0;
    fireEvent.scroll(transcript);
    const jump = page.getByRole("button", { name: /Jump to latest/ });
    await expect.element(jump).toBeVisible();
    expect(rect(jump.element()).top - rect(alert).bottom).toBeCloseTo(8, 0);

    const button = action.element();
    expect(getComputedStyle(button).fontSize).toBe(getComputedStyle(alert).fontSize);
    const background = () => getComputedStyle(button).backgroundColor;
    const resting = background();
    await action.hover();
    expect(background()).not.toBe(resting);
    (button as HTMLButtonElement).disabled = true;
    expect(background()).toBe(resting);
    (button as HTMLButtonElement).disabled = false;
    (button as HTMLButtonElement).focus();
    await expect.element(action).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("dialog", { name: "Permission needed" })).toBeVisible();
  } finally {
    await session.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
  }
});
