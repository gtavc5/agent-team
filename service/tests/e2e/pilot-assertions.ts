/// <reference lib="dom" />

import { type ChildProcess } from "node:child_process";
import { type Page } from "playwright";
import { expect } from "vitest";

export async function waitForState<T>(
  label: string,
  read: () => T | Promise<T>,
  ready: (state: T) => boolean,
) {
  let last: T | undefined;
  try {
    await expect
      .poll(
        async () => {
          last = await read();
          return ready(last);
        },
        { timeout: 6_000, interval: 40 },
      )
      .toBe(true);
  } catch (cause) {
    throw new Error(`${label}; last state: ${JSON.stringify(last)}`, { cause });
  }
  return last as T;
}

export function expectProcessExit(child: ChildProcess, expectedCode = 0): Promise<void> {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const off = () => {
      clearTimeout(timer);
      child.off("error", failed);
      child.off("close", closed);
    };
    const closed = (code: number | null, signal: NodeJS.Signals | null) => {
      off();
      resolve({ code, signal });
    };
    const failed = (error: Error) => {
      off();
      reject(error);
    };
    const timer = setTimeout(
      () =>
        failed(
          new Error(
            `Child ${child.pid ?? "(not started)"} did not close; exit=${child.exitCode} signal=${child.signalCode}`,
          ),
        ),
      6_000,
    );
    child.once("error", failed);
    child.once("close", closed);
  }).then((exit) => expect(exit).toEqual({ code: expectedCode, signal: null }));
}

export function observeBrowserErrors(page: Page) {
  const errors: { channel: string; message: string }[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push({ channel: "console", message: m.text() });
  });
  page.on("pageerror", (e) => errors.push({ channel: "page", message: e.message }));
  // Opt in to exact occurrences; a broad filter can hide new failures.
  return (expected: typeof errors = []) => expect(errors).toEqual(expected);
}

export function transcriptState(page: Page) {
  return page.locator(".messages").evaluate((messages) => ({
    rows: Array.from(messages.querySelectorAll("[id^=msg-]"), (row) => ({
      id: row.id,
      text: Array.from(row.querySelectorAll(".message-content"), (body) => body.textContent),
      queue: row.querySelector(".queued-badge")?.textContent ?? null,
      canRemove: !!row.querySelector(".queued-cancel"),
      subagents: Array.from(row.querySelectorAll(".subagent-item"), (card) => ({
        summary: card.querySelector("[aria-label^='Expand subagent:']")?.getAttribute("aria-label"),
        status: card.className,
      })),
    })),
  }));
}

export async function expectEquivalent(
  page: Page,
  expected: Awaited<ReturnType<typeof transcriptState>>,
) {
  await expect
    .poll(() => transcriptState(page), {
      timeout: 6_000,
      message: "live and newly hydrated transcript/queue/child cards agree",
    })
    .toEqual(expected);
}

export function stableGeometry(page: Page, anchor: string) {
  return page.locator(".messages").evaluate((messages, selector) => {
    const target = messages.querySelector(selector);
    if (!target) throw new Error("Reading anchor is not rendered");
    const bounds = messages.getBoundingClientRect();
    return { width: bounds.width, anchor: target.getBoundingClientRect().top - bounds.top };
  }, anchor);
}

export function expectBounded(count: number, ceiling: number, label: string) {
  expect(count, label).toBeLessThanOrEqual(ceiling);
}
