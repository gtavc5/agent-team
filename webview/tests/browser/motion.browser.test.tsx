import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { cdp, page } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import "../../src/styles.css";

afterEach(async () => {
  cleanup();
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

it("stops status loops and chrome motion without hiding status text in reduced motion", async () => {
  await page.viewport(1100, 800);
  const setMotion = (value: string) =>
    cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value }],
    });
  await setMotion("no-preference");
  const { container } = render(
    <>
      <span className="task-status running" />
      <span className="agent-status-dot agent-status-busy" />
      <span className="agent-status-dot agent-status-waiting" />
      <span className="pr-checks pr-checks-pending" />
      <span className="delivery-inline">
        <span className="streaming-dot" /> Streaming
      </span>
      <span className="banner banner-retry">
        <span className="banner-icon">!</span> Retrying
      </span>
      <span className="subagent-icon-running">◌</span>
      <span className="history-loading">
        <span className="spinner" /> Loading history
      </span>
      <button className="quota-refresh" disabled aria-label="Refreshing…">
        <svg className="icon" />
      </button>
      <span className="ap-dot ss-working" />
      <div className="sidebar-debug-strip">Debug tools</div>
      <div className="quota-details">Quota details</div>
      <div className="stop-actions">Stop actions</div>
      <div className="dialog">New session</div>
      <span className="message-highlight">Jump target</span>
      <div className="code-block">
        <button className="copy-btn">Copy code</button>
      </div>
      <div className="event-summary-line">
        <button className="copy-btn">Copy path</button>
      </div>
      <button className="btn-primary">Create</button>
    </>,
  );
  // Inspect the authored effects, even if the runner is descheduled past 120 ms.
  for (const animation of container.getAnimations({ subtree: true })) animation.pause();
  const get = (selector: string) => container.querySelector(selector)!;
  const loopMarkers = [
    ".agent-status-busy",
    ".agent-status-waiting",
    ".pr-checks-pending",
    ".streaming-dot",
    ".banner-icon",
    ".subagent-icon-running",
    ".spinner",
    ".ap-dot",
  ];
  const fades = [".sidebar-debug-strip", ".quota-details", ".stop-actions"];
  const statusTexts = [".delivery-inline", ".banner-retry", ".history-loading", ".quota-details"];
  const transitions = [".code-block .copy-btn", ".event-summary-line .copy-btn", ".btn-primary"];
  function properties(selector: string) {
    const [animation, ...rest] = get(selector).getAnimations();
    expect(rest).toEqual([]);
    const effect = animation.effect as KeyframeEffect;
    expect(effect.getTiming().duration).toBeLessThanOrEqual(150);
    const keys = new Set(effect.getKeyframes().flatMap(Object.keys));
    for (const key of ["offset", "computedOffset", "easing", "composite"]) keys.delete(key);
    return [...keys].sort();
  }
  for (const selector of loopMarkers) {
    expect(getComputedStyle(get(selector)).animationIterationCount, selector).toBe("infinite");
  }
  for (const selector of [".task-status", ".quota-refresh .icon"]) {
    expect(getComputedStyle(get(selector)).animationName).toBe("none");
  }
  for (const selector of fades) expect(properties(selector), selector).toEqual(["opacity"]);
  expect(properties(".dialog")).toEqual(["opacity", "transform"]);
  for (const selector of transitions) {
    expect(getComputedStyle(get(selector)).transitionDuration, selector).not.toBe("0s");
  }

  await setMotion("reduce");
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  for (const selector of [...loopMarkers, ...fades, ".dialog", ".message-highlight"]) {
    const element = get(selector);
    expect(getComputedStyle(element).animationName, selector).toBe("none");
    expect(getComputedStyle(element).opacity, selector).toBe("1");
    expect(getComputedStyle(element).visibility, selector).toBe("visible");
  }
  for (const selector of transitions) {
    expect(getComputedStyle(get(selector)).transitionDuration, selector).toBe("0s");
  }
  for (const selector of statusTexts) {
    expect(get(selector).textContent?.trim(), selector).toBeTruthy();
    expect(get(selector).getBoundingClientRect().height, selector).toBeGreaterThan(0);
  }
  expect(getComputedStyle(get(".message-highlight")).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
});
