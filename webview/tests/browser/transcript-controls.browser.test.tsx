import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import { CodeBlock } from "../../src/chat/markdown";
import { EventItem, MessageItem, SubAgentItem } from "../../src/chat/messages";
import { SidePanel } from "../../src/panels/SidePanel";
import type { Message } from "../../src/state/useServer";
import "../../src/styles.css";

const msg: Message = {
  id: "delegated",
  kind: "user",
  status: "done",
  timestamp: 1,
  agentId: null,
  from: { workspaceId: "lead", role: "lead", name: "Lead" },
  content: "Check the result.",
};
const result = { kind: "tool_result" as const, content: "", contentLength: 4200 };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

it.each(["light", "dark"])(
  "reveals and operates transcript actions by keyboard (%s)",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(1000, 720);
    const load = vi.fn();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const view = render(
      <>
        <EventItem ev={result} onLoadDetails={load} />
        <CodeBlock>
          <code>example</code>
        </CodeBlock>
        <MessageItem msg={msg} agents={[]} />
      </>,
    );
    const show = view.getByRole("button", { name: /Show/ });
    const placeholder = view.getByRole("button", { name: "Load details · 4.2k chars" });
    const copyButton = view.getByRole("button", { name: "Copy" });
    expect(view.getByText("Lead").closest("button")).toBeNull();
    await page.elementLocator(show).hover();
    expect(getComputedStyle(copyButton).opacity).toBe("0");
    show.focus();
    for (const [button, spy] of [
      [placeholder, load],
      [copyButton, copy],
    ] as const) {
      await userEvent.tab();
      expect(document.activeElement).toBe(button);
      expect(button.matches(":focus-visible")).toBe(true);
      await expect.poll(() => getComputedStyle(button).opacity).toBe("1");
      expect(getComputedStyle(button).outlineStyle).toBe("solid");
      await userEvent.keyboard("{Enter} ");
      expect(spy).toHaveBeenCalledTimes(2);
    }
    expect(copy).toHaveBeenCalledWith("example");

    // The touch guards must leave desktop pointer feedback intact.
    view.rerender(
      <>
        <MessageItem msg={msg} agents={[]} onOpenWorkspace={vi.fn()} />
        <MessageItem
          msg={{ ...msg, id: "reply", from: undefined, kind: "agent" }}
          agents={[]}
          onQuote={vi.fn()}
        />
      </>,
    );
    const author = view.getByRole("button", { name: "Lead" });
    const quote = view.getByRole("button", { name: "Quote this message" });
    await page.elementLocator(author).hover();
    expect(getComputedStyle(author).textDecorationLine).toBe("underline");
    const rest = getComputedStyle(quote).borderTopColor;
    await page.elementLocator(quote).hover();
    expect(getComputedStyle(quote).borderTopColor).not.toBe(rest);
  },
);

async function tap(el: Element) {
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  expect(el.contains(document.elementFromPoint(x, y))).toBe(true);
  const frame = window.frameElement!.getBoundingClientRect();
  await cdp().send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      {
        x: frame.x + (x * frame.width) / innerWidth,
        y: frame.y + (y * frame.height) / innerHeight,
      },
    ],
  });
  await cdp().send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

it.each([390, 960])("leaves transcript actions at rest after a touch (%ipx)", async (width) => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true });
  try {
    await page.viewport(width, 760);
    expect(matchMedia("(hover: none)").matches).toBe(true);
    const load = vi.fn(),
      open = vi.fn(),
      quote = vi.fn(),
      cancel = vi.fn();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const view = render(
      <>
        <EventItem ev={result} onLoadDetails={load} />
        <CodeBlock>
          <code>example</code>
        </CodeBlock>
        <MessageItem msg={msg} agents={[]} onOpenWorkspace={open} />
        <MessageItem
          msg={{ ...msg, id: "reply", from: undefined, kind: "agent" }}
          agents={[]}
          onQuote={quote}
        />
        <SubAgentItem
          ev={{
            kind: "subagent_start",
            content: "",
            subagent: { taskId: "child", description: "Review", status: "running" },
          }}
          onCancel={cancel}
        />
      </>,
    );
    const placeholder = view.container.querySelector<HTMLElement>(".event-placeholder")!;
    const show = view.getByRole("button", { name: /Show/ });
    const copyButton = view.getByRole("button", { name: "Copy" });
    const author = view.getByRole("button", { name: "Lead" });
    expect(placeholder.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      show.getBoundingClientRect().bottom,
    );
    for (const [el, property, spy] of [
      [placeholder, "color", load],
      [copyButton, "color", copy],
      [author, "textDecorationLine", open],
      [view.getByRole("button", { name: "Quote this message" }), "borderTopColor", quote],
    ] as const) {
      const rest = getComputedStyle(el)[property];
      await tap(el);
      await expect.poll(() => spy.mock.calls.length).toBe(1);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      expect.soft(getComputedStyle(el)[property]).toBe(rest);
    }
    expect(open).toHaveBeenCalledWith("lead");
    const showRest = getComputedStyle(show).backgroundColor;
    await tap(show);
    await expect.poll(() => load.mock.calls.length).toBe(2);
    expect.soft(getComputedStyle(show).backgroundColor).toBe(showRest);
    const toggle = view.getByRole("button", { name: /Expand subagent: Review/ });
    const header = toggle.closest(".subagent-header")!;
    const stop = view.container.querySelector<HTMLElement>(".btn-cancel-subagent")!;
    expect(stop.getBoundingClientRect().left).toBeGreaterThan(toggle.getBoundingClientRect().right);
    await tap(toggle);
    await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
    expect(getComputedStyle(header).opacity).toBe("1");
    expect(cancel).not.toHaveBeenCalled();
    const rest = getComputedStyle(stop).backgroundColor;
    await tap(stop);
    await expect.poll(() => cancel.mock.calls.length).toBe(1);
    expect(getComputedStyle(stop).backgroundColor).toBe(rest);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    if (width > 768) {
      const maximize = vi.fn();
      const panel = (maximized: boolean) => (
        <SidePanel
          title="Files"
          inset={0}
          width={null}
          pinned={false}
          maximized={maximized}
          onPin={vi.fn()}
          onClose={vi.fn()}
          onWidth={vi.fn()}
          onMaximize={maximize}
        >
          Files
        </SidePanel>
      );
      view.rerender(panel(false));
      const max = view.getByTitle("Maximise over the chat");
      const rest = getComputedStyle(max).backgroundColor;
      await tap(max);
      view.rerender(panel(true));
      await tap(view.getByTitle("Back beside the chat"));
      view.rerender(panel(false));
      expect(maximize).toHaveBeenCalledTimes(2);
      expect(getComputedStyle(max).backgroundColor).toBe(rest);
    }
  } finally {
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
});
