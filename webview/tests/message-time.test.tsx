import { describe, it, expect, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { MessageItem } from "../src/chat/messages";
import { LocalDayProvider, localDayKey, msUntilNextLocalMidnight } from "../src/chat/localDay";
import { formatFullDateTime, formatMessageTime, formatShortDateTime } from "../src/format";
import type { AgentInfo, Message } from "../src/state/useServer";

const agent: AgentInfo = {
  id: "a1",
  name: "Alice",
  model: "claude-opus-5-5",
  avatar: "🤖",
  color: "#888",
  isDefault: true,
};

const makeMsg = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  kind: "agent",
  agentId: "a1",
  content: "Hello",
  timestamp: Date.now(),
  status: "done",
  ...over,
});

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

afterEach(() => {
  cleanup();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("MessageItem timestamps", () => {
  it("formats today, same-year non-today, and cross-year timestamps with full datetime titles on normal and compact headers", () => {
    vi.useFakeTimers();
    const now = new Date(2026, 5, 15, 14, 30, 0);
    vi.setSystemTime(now);

    const todayTs = new Date(2026, 5, 15, 9, 5, 0).getTime();
    const earlierSameYearTs = new Date(2026, 2, 4, 21, 15, 0).getTime();
    const prevYearTs = new Date(2025, 11, 31, 23, 50, 0).getTime();

    for (const compact of [false, true]) {
      const selector = compact ? ".compact-header .message-time" : ".message-header .message-time";
      for (const ts of [todayTs, earlierSameYearTs, prevYearTs]) {
        const { container, unmount } = render(
          <MessageItem msg={makeMsg({ timestamp: ts })} agents={[agent]} compact={compact} />,
        );
        const timeEl = container.querySelector(selector)!;
        expect(timeEl).not.toBeNull();
        expect(timeEl.textContent).toBe(formatMessageTime(ts, now));
        expect(timeEl.getAttribute("title")).toBe(formatFullDateTime(ts));
        unmount();
      }
    }

    // MessageItem itself never schedules per-message timers.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes rendered today messages at local midnight using a single shared timer and cleans up on unmount", () => {
    vi.useFakeTimers();
    const beforeMidnight = new Date(2026, 5, 15, 23, 59, 50);
    vi.setSystemTime(beforeMidnight);

    const msgTs = new Date(2026, 5, 15, 22, 10, 0).getTime();
    const prevYearTs = new Date(2025, 11, 31, 18, 0, 0).getTime();
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const { container, unmount } = render(
      <LocalDayProvider>
        <MessageItem msg={makeMsg({ id: "m1", timestamp: msgTs })} agents={[agent]} />
        <MessageItem msg={makeMsg({ id: "m2", timestamp: msgTs })} agents={[agent]} compact />
        <MessageItem msg={makeMsg({ id: "m3", timestamp: prevYearTs })} agents={[agent]} />
      </LocalDayProvider>,
    );

    // One timer for the entire list, regardless of message count.
    expect(vi.getTimerCount()).toBe(1);
    const timeOnly = new Date(msgTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const fullTitle = formatFullDateTime(msgTs);

    const m1Time = () => container.querySelector("#msg-m1 .message-header .message-time")!;
    const m2Time = () => container.querySelector("#msg-m2 .compact-header .message-time")!;
    expect(m1Time().textContent).toBe(timeOnly);
    expect(m2Time().textContent).toBe(timeOnly);
    expect(m1Time().getAttribute("title")).toBe(fullTitle);
    expect(m2Time().getAttribute("title")).toBe(fullTitle);

    // Roll past local midnight + buffer.
    act(() => {
      vi.advanceTimersByTime(msUntilNextLocalMidnight(beforeMidnight.getTime()));
    });

    const expectedWithDate = formatShortDateTime(msgTs);
    expect(m1Time().textContent).toBe(expectedWithDate);
    expect(m2Time().textContent).toBe(expectedWithDate);
    expect(m1Time().getAttribute("title")).toBe(fullTitle);
    expect(m2Time().getAttribute("title")).toBe(fullTitle);
    // Reschedules a single timer for the following midnight.
    expect(vi.getTimerCount()).toBe(1);

    const addedVisListeners = addSpy.mock.calls.filter(([type]) => type === "visibilitychange");
    expect(addedVisListeners).toHaveLength(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    const removedVisListeners = removeSpy.mock.calls.filter(
      ([type, fn]) => type === "visibilitychange" && fn === addedVisListeners[0][1],
    );
    expect(removedVisListeners).toHaveLength(1);
  });

  it("refreshes overnight timestamps immediately on visibilitychange when returning to a visible tab", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 31, 22, 0, 0));

    const eveTs = new Date(2026, 11, 31, 21, 30, 0).getTime();
    const { container, unmount } = render(
      <LocalDayProvider>
        <MessageItem msg={makeMsg({ id: "m1", timestamp: eveTs })} agents={[agent]} />
        <MessageItem msg={makeMsg({ id: "m2", timestamp: eveTs })} agents={[agent]} compact />
      </LocalDayProvider>,
    );

    const timeOnly = new Date(eveTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(container.querySelector("#msg-m1 .message-time")!.textContent).toBe(timeOnly);
    expect(container.querySelector("#msg-m2 .message-time")!.textContent).toBe(timeOnly);

    // Tab goes hidden and OS sleeps past New Year's midnight without firing timers.
    setVisibility("hidden");
    const nextYearMorning = new Date(2027, 0, 1, 9, 15, 0);
    vi.setSystemTime(nextYearMorning);
    expect(container.querySelector("#msg-m1 .message-time")!.textContent).toBe(timeOnly);

    // Returning to the visible tab refreshes timestamps immediately (now cross-year).
    setVisibility("visible");
    const expectedCrossYear = formatMessageTime(eveTs, nextYearMorning);
    expect(container.querySelector("#msg-m1 .message-time")!.textContent).toBe(expectedCrossYear);
    expect(container.querySelector("#msg-m2 .message-time")!.textContent).toBe(expectedCrossYear);
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("computes localDayKey and msUntilNextLocalMidnight accurately across day boundaries", () => {
    const t = new Date(2026, 5, 15, 23, 59, 45, 0);
    expect(localDayKey(t)).toBe("2026-06-15");
    // 15 seconds until midnight + 1 second buffer.
    expect(msUntilNextLocalMidnight(t.getTime())).toBe(16_000);
  });
});
