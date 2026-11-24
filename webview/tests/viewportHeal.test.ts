import { describe, it, expect, vi } from "vitest";
import { ViewportTracker, isTextInput, settleScroller } from "../src/viewport/viewportHeal";

describe("ViewportTracker", () => {
  it("remembers the tallest viewport seen and flags a lasting shrink", () => {
    const t = new ViewportTracker(852);
    t.observe(852);
    expect(t.needsHeal(852, false)).toBe(false);
    // Keyboard up: shrink is expected, do not heal.
    expect(t.needsHeal(500, true)).toBe(false);
    // Keyboard down but still 59px short: the iOS standalone bug.
    expect(t.needsHeal(793, false)).toBe(true);
    // Rounding noise is not a bug.
    expect(t.needsHeal(850, false)).toBe(false);
    t.observe(900);
    expect(t.maxHeight).toBe(900);
  });

  it("can be seeded above the current height so a reload into the bug still heals", () => {
    // Page loaded with the viewport already shrunk (812 of a 874px screen).
    const t = new ViewportTracker(Math.max(812, 874));
    expect(t.needsHeal(812, false)).toBe(true);
  });
});

describe("isTextInput", () => {
  it("recognises the fields that summon the software keyboard", () => {
    expect(isTextInput(document.createElement("textarea"))).toBe(true);
    expect(isTextInput(document.createElement("input"))).toBe(true);
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isTextInput(editable)).toBe(true);
    expect(isTextInput(document.createElement("button"))).toBe(false);
    expect(isTextInput(document.body)).toBe(false);
    expect(isTextInput(null)).toBe(false);
  });
});

// Emulate WebKit's stale compositor offset: Chromium clamps an offset past
// the new maximum immediately, so its layout cannot reproduce this state.
function fakeScroller(scrollTop: number, scrollHeight: number, clientHeight: number) {
  const el = document.createElement("div");
  let top = scrollTop;
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { value: clientHeight });
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    // Browsers clamp assignments into range; so does the fake.
    set: (v: number) => {
      top = Math.max(0, Math.min(v, scrollHeight - clientHeight));
    },
  });
  return el;
}

describe("settleScroller", () => {
  it("pulls an offset left past the maximum back into range, via a one-pixel nudge", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    // Keyboard closed: the box grew from 285 to 621, the offset stayed at the
    // old maximum (2000 - 285 = 1715), which is 336px past the new one.
    const el = fakeScroller(1715, 2000, 621);
    settleScroller(el, false);
    expect(el.scrollTop).toBe(1378);
    frames.forEach((f) => f(0));
    expect(el.scrollTop).toBe(1379);
    vi.unstubAllGlobals();
  });
});
