// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  findLatestMessageElement,
  isLatestMessageVisible,
  isMessageRectVisible,
  shouldShowJumpToLatest,
} from "../src/chat/jumpLatest";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isMessageRectVisible", () => {
  const scroller = { top: 100, bottom: 600, width: 800, height: 500 };

  it("returns true when a tall message spans across the viewport", () => {
    expect(
      isMessageRectVisible(scroller, { top: -1000, bottom: 900, width: 700, height: 1900 }),
    ).toBe(true);
  });

  it("returns true when the top of the latest message enters the bottom of the viewport", () => {
    expect(
      isMessageRectVisible(scroller, { top: 580, bottom: 1200, width: 700, height: 620 }),
    ).toBe(true);
  });

  it("returns false when the latest message sits completely below the viewport", () => {
    expect(isMessageRectVisible(scroller, { top: 600, bottom: 900, width: 700, height: 300 })).toBe(
      false,
    );
    expect(isMessageRectVisible(scroller, { top: 650, bottom: 900, width: 700, height: 250 })).toBe(
      false,
    );
  });

  it("returns false when the latest message sits completely above the viewport", () => {
    expect(isMessageRectVisible(scroller, { top: 0, bottom: 100, width: 700, height: 100 })).toBe(
      false,
    );
  });

  it("returns false for zero-sized layout rects (jsdom)", () => {
    expect(
      isMessageRectVisible(
        { top: 0, bottom: 0, width: 0, height: 0 },
        { top: 0, bottom: 0, width: 0, height: 0 },
      ),
    ).toBe(false);
  });
});

describe("findLatestMessageElement & isLatestMessageVisible", () => {
  it("finds msg-<id> inside the scroller and falls back to system-message or render-error", () => {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    content.className = "messages-content";
    const first = document.createElement("div");
    first.id = "msg-m1";
    first.className = "message";
    const sys = document.createElement("div");
    sys.className = "system-message";
    content.append(first, sys);
    scroller.append(content);
    document.body.append(scroller);

    expect(findLatestMessageElement(scroller, "m1")).toBe(first);
    expect(findLatestMessageElement(scroller, "m2")).toBe(sys);

    scroller.getBoundingClientRect = () => new DOMRect(0, 100, 800, 500);
    first.getBoundingClientRect = () => new DOMRect(0, 120, 760, 80);
    sys.getBoundingClientRect = () => new DOMRect(0, 700, 760, 40);

    expect(isLatestMessageVisible(scroller, "m1")).toBe(true);
    expect(isLatestMessageVisible(scroller, "m2")).toBe(false);
  });

  it("ignores HistoryHint and empty-state when looking up the latest message element", () => {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    content.className = "messages-content";
    const hint = document.createElement("div");
    hint.className = "history-hint";
    content.append(hint);
    scroller.append(content);
    document.body.append(scroller);

    expect(findLatestMessageElement(scroller, "missing")).toBeNull();
    expect(isLatestMessageVisible(scroller, "missing")).toBe(false);
  });
});

describe("shouldShowJumpToLatest", () => {
  it("shows only when not following, messages are loaded and non-empty, and latest is off-screen", () => {
    expect(
      shouldShowJumpToLatest({
        following: false,
        messagesLoaded: true,
        messageCount: 3,
        latestVisible: false,
      }),
    ).toBe(true);

    expect(
      shouldShowJumpToLatest({
        following: false,
        messagesLoaded: true,
        messageCount: 3,
        latestVisible: true,
      }),
    ).toBe(false);

    expect(
      shouldShowJumpToLatest({
        following: true,
        messagesLoaded: true,
        messageCount: 3,
        latestVisible: false,
      }),
    ).toBe(false);

    expect(
      shouldShowJumpToLatest({
        following: false,
        messagesLoaded: false,
        messageCount: 3,
        latestVisible: false,
      }),
    ).toBe(false);

    expect(
      shouldShowJumpToLatest({
        following: false,
        messagesLoaded: true,
        messageCount: 0,
        latestVisible: false,
      }),
    ).toBe(false);
  });
});
