import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ensureWebviewBuilt } from "../../../scripts/bench-demo";
import { seedDemo } from "../../../scripts/seed-demo";
import { Server } from "../../src/server/server";
import { closeHistory, loadAll, saveWorkspace } from "../../src/workspace/state";
import type { Message } from "../../src/workspace/workspace";

const webDir = join(__dirname, "../../../dist/webview");
const imageName = "journey preview.png";
const historySize = 125;
let dir: string | undefined;
let server: Server | undefined;
let browser: Browser;
let origin: string;
let page: Page | undefined;
let errors: string[];

beforeAll(async () => {
  ensureWebviewBuilt();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "yaat-chat-journey-")));
  const { workspaces } = seedDemo(dir, { quiet: true, writeConfig: true });
  const sessions = loadAll(dir);
  const mobile = sessions.find((session) => session.id === workspaces.mobile)!;
  const wake = sessions.find((session) => session.id === workspaces.wake)!;
  const history = wake.messages!;
  const start = history[0].timestamp - historySize;
  const older: Message[] = Array.from({ length: historySize }, (_, i) => ({
    id: `journey-older-${i}`,
    kind: "user",
    agentId: null,
    status: "done",
    timestamp: start + i,
    content: `History entry ${i}`,
  }));
  saveWorkspace(dir, { ...wake, messages: [...older, ...history] });

  writeFileSync(
    join(mobile.cwd, imageName),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  // Supplemental history is stored at the Message boundary, not as fabricated RPC frames.
  saveWorkspace(dir, {
    ...mobile,
    messages: [
      ...mobile.messages!,
      {
        id: "journey-image",
        kind: "agent",
        agentId: mobile.agents[0].id,
        content: "The preview is ready.",
        status: "done",
        timestamp: mobile.messages!.at(-1)!.timestamp + 1,
        events: [
          {
            kind: "tool_use",
            toolUseId: "journey-view-image",
            toolName: "ViewImage",
            content: `**ViewImage** \`${imageName}\``,
            toolResult: "",
            contentOffset: 0,
          },
          {
            kind: "thinking",
            content: "",
            durationMs: 1000,
            contentOffset: "The preview is ready.".length,
          },
        ],
      },
    ],
  });
  closeHistory(dir);
  vi.stubEnv("AGENT_TEAM_HOST", "127.0.0.1");
  server = new Server(0, dir, webDir);
  origin = `http://127.0.0.1:${await server.listening}`;
  browser = await chromium.launch();
}, 60_000);

async function open(query = "") {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const current = (page = await context.newPage());
  current.setDefaultTimeout(7_000);
  errors = [];
  current.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  current.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await current.goto(`${origin}/${query}`);
  await current
    .locator(".messages")
    .getByText(/分成两件事/)
    .waitFor();
  return current;
}

afterEach(async () => {
  if (!page) return;
  await page.context().close();
  page = undefined;
  expect(errors).toEqual([]);
});

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    try {
      await server?.close();
    } finally {
      vi.unstubAllEnvs();
      if (dir) {
        closeHistory(dir);
        // The demo clone and its worktrees contain thousands of files; synchronous
        // removal can block the test runner past the hook deadline on Windows.
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }
});

const worker = (page: Page, name: string) => page.locator(".task-item", { hasText: name });
const overflow = (page: Page) =>
  page.evaluate("document.documentElement.scrollWidth - window.innerWidth");

it("reads persisted markdown, expands tool results, copies code and opens an image file", async () => {
  const page = await open();
  await worker(page, "mobile panels").click();
  const messages = page.locator(".messages");
  await messages.getByRole("cell", { name: "目录行高", exact: true }).waitFor();
  const code = messages.locator("pre", { hasText: "npx vitest run" });
  await code.waitFor();
  await code.locator("..").getByRole("button", { name: "Copy", exact: true }).click();
  await expect
    .poll(() => page.evaluate("navigator.clipboard.readText()"))
    .toBe("npx vitest run tests/agents-panel.test.tsx tests/files-panel.test.tsx");

  const steps = messages.locator(".step-group", { has: page.getByText("Bash", { exact: true }) });
  await steps.getByRole("button", { name: "Expand steps" }).click();
  const bash = steps.locator(".event-tool_use", { hasText: "npx vitest run" });
  const result = bash.getByRole("button", { name: /^Result ·/ });
  await result.click();
  const output = bash.locator(".event-result", { hasText: "31 passed (31)" });
  await output.getByRole("button", { name: "Copy", exact: true }).click();
  // The Windows clipboard represents line breaks as CRLF.
  await expect
    .poll(async () =>
      (await page.evaluate<string>("navigator.clipboard.readText()")).replaceAll("\r\n", "\n"),
    )
    .toBe(" Test Files  2 passed (2)\n      Tests  31 passed (31)");
  await bash.getByRole("button", { name: /^Hide result ·/ }).click();
  await bash.locator(".event-result").waitFor({ state: "hidden" });
  await steps.getByRole("button", { name: "Collapse step trace" }).press("Enter");
  await steps.getByRole("button", { name: "Expand steps" }).and(page.locator(":focus")).waitFor();

  const image = messages.locator("#msg-journey-image");
  await image.getByTitle("Quote this message").click();
  await page.locator('.quote-bar-agent img[alt="Perseus"]').waitFor();
  const emptyThinking = image.locator(".step-group", { hasText: "1 thinking" });
  await emptyThinking.waitFor();
  expect(await emptyThinking.getByRole("button").count()).toBe(0);
  await image.getByRole("button", { name: "Expand steps" }).click();
  await image.getByRole("button", { name: imageName }).click();
  const preview = page.locator(".files-panel .file-image img");
  await preview.waitFor();
  await page.waitForFunction(
    "document.querySelector('.files-panel .file-image img')?.naturalWidth === 1",
  );
  expect(await preview.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  const bar = page.locator(".files-panel .fp-bar");
  const copy = bar.getByTitle("Copy image");
  expect(await bar.getByTitle("Copy path").textContent()).toBe("Copy path");
  await copy.click();
  await expect.poll(() => copy.textContent()).toBe("Copied");
  expect(
    await page.evaluate<string[]>(
      "navigator.clipboard.read().then(items => items.flatMap(item => item.types))",
    ),
  ).toEqual(["image/png"]);
  await page.setViewportSize({ width: 320, height: 740 });
  // Measure the actual control boxes against their host bar at phone width.
  await expect
    .poll(() =>
      bar.evaluate((bar) => {
        const host = bar.getBoundingClientRect();
        return Array.from(bar.querySelectorAll(".fp-btn")).every((button) => {
          const rect = button.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height >= 40 &&
            rect.left >= host.left &&
            rect.right <= host.right
          );
        });
      }),
    )
    .toBe(true);
  expect(await overflow(page)).toBe(0);
}, 40_000);

it("keeps per-workspace drafts through desktop and phone navigation and selects suggestions by key", async () => {
  const page = await open();
  const composer = page.locator("textarea.chat-input");
  const mobile = worker(page, "mobile panels");
  await composer.fill("lead draft");
  await mobile.click();
  const transcript = page.locator(".messages").getByText(/sheet 头部已经改好/);
  await transcript.waitFor();
  expect(await composer.inputValue()).toBe("");
  await composer.fill("@Per");
  const mention = page.locator(".mention-popup .mention-item.active", { hasText: "Perseus" });
  await mention.waitFor();
  const model = await page.locator(".message-model").first().textContent();
  expect(model).toBeTruthy();
  expect(await mention.locator(".mention-model").textContent()).toBe(model);
  await composer.press("Enter");
  expect(await composer.inputValue()).toBe("@Perseus ");
  await page.locator(".mention-popup").waitFor({ state: "hidden" });
  await composer.fill("/cont");
  await page.locator(".command-popup .command-item.active", { hasText: "/context" }).waitFor();
  await composer.press("Tab");
  expect(await composer.inputValue()).toBe("/context ");
  await page.locator(".command-popup").waitFor({ state: "hidden" });
  expect(await overflow(page)).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.locator("button.mobile-menu-btn");
  const drawer = page.locator(".sidebar.sidebar-open");
  await menu.click();
  await drawer.getByText("Workspaces", { exact: true }).waitFor();
  expect(await overflow(page)).toBe(0);
  await page.locator(".sidebar-overlay:not(.closing)").click({ position: { x: 380, y: 400 } });
  await page.locator(".sidebar-overlay").waitFor({ state: "hidden" });
  await menu.click();
  await drawer.locator(".ws-group-project").click();
  await page
    .locator(".messages")
    .getByText(/分成两件事/)
    .waitFor();
  await drawer.waitFor({ state: "hidden" });
  expect(await composer.inputValue()).toBe("lead draft");
  await composer.press("End");
  await composer.pressSequentially(" on phone");
  expect(await composer.inputValue()).toBe("lead draft on phone");
  await menu.click();
  await mobile.click();
  await transcript.waitFor();
  await drawer.waitFor({ state: "hidden" });
  expect(await composer.inputValue()).toBe("/context ");
  expect(await overflow(page)).toBe(0);
}, 40_000);

it("pages through older history without losing the scroll anchor, then hydrates a fresh newest page", async () => {
  const page = await open();
  await worker(page, "wake-up time").click();
  const messages = page.locator(".messages");
  const older = messages.getByText("Scroll up for older messages");
  await older.waitFor();
  const ids = () =>
    page.evaluate<string[]>(
      `Array.from(document.querySelectorAll(".messages [id^=msg-]"), row => row.id)`,
    );
  const newest = await ids();
  const first = page.locator(`#${newest[0]}`);
  const offset = async () => (await first.boundingBox())!.y - (await messages.boundingBox())!.y;
  // Jump in one scroll event so Chromium cannot start paging midway through a wheel animation.
  const top = () => page.evaluate("document.querySelector('.messages').scrollTop = 0");
  expect(newest.length).toBeLessThan(historySize);
  await page.evaluate("document.fonts.ready.then(() => undefined)");
  await page.waitForFunction("document.querySelector('.messages').scrollTop >= 80");
  const before = await page.evaluate<number>(`(() => {
    const scroller = document.querySelector('.messages');
    const row = document.getElementById(${JSON.stringify(newest[0])});
    return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  })()`);
  await top();
  await expect.poll(async () => (await ids()).length).toBeGreaterThan(newest.length);
  await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThanOrEqual(2);
  expect((await ids()).slice(-newest.length)).toEqual(newest);
  await top();
  await messages.getByText("Beginning of conversation").waitFor();
  const all = await ids();
  expect(all.slice(0, historySize)).toEqual(
    Array.from({ length: historySize }, (_, i) => `msg-journey-older-${i}`),
  );
  expect(new Set(all).size).toBe(all.length);

  const transcript = () => Promise.all(newest.map((id) => page.locator(`#${id}`).textContent()));
  const beforeReconnect = await transcript();
  // Close only the scratch server's browser connections, not the server or its history.
  const reconnect = page.waitForEvent("websocket");
  for (const socket of server!["wss"].clients) socket.close(1000, "Journey reconnect");
  const socket = await reconnect;
  await socket.waitForEvent("framereceived", {
    predicate: ({ payload }) =>
      (JSON.parse(payload.toString()) as { type: string }).type === "workspace_messages",
    timeout: 7_000,
  });
  // A wire receipt can precede the render that merges that page.
  await page.evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  expect(await ids()).toEqual(all);
  expect(await transcript()).toEqual(beforeReconnect);

  await page.reload();
  await older.waitFor();
  expect(await ids()).toEqual(newest);
  expect(await transcript()).toEqual(beforeReconnect);

  await page.locator(".search-bar input").fill("History entry 0");
  await page.locator(".search-result-item", { hasText: "History entry 0" }).click();
  await messages.locator("#msg-journey-older-0.message-highlight").waitFor();
}, 40_000);

// Replay Demo runs in the browser; only the seeded conversations above survive a reload.
it("streams Replay Demo thinking, drills into a subagent, jumps to a quote and cancels work", async () => {
  const page = await open("?debug=1&demoSpeed=3");
  await page.getByRole("button", { name: "Replay demo", exact: true }).click();
  await worker(page, "Replay Demo").click();
  const turn = page.locator("#msg-demo-layout-turn");
  // Use the first, longer streaming turn for liveness. Short thinking phases
  // and their exact timing are tested with a controlled clock in Browser Mode.
  await page.locator("#msg-demo-msg-1 .streaming-dot").waitFor({ state: "attached" });
  await page.waitForFunction("window.__yaatDemoReplay?.done === true", undefined, {
    timeout: 25_000,
  });
  const thinking = turn.locator(".step-group", { hasText: "1 thinking" });
  await thinking.getByRole("button", { name: "Expand steps" }).click();
  await thinking.getByText(/The geometry should stay the same/).waitFor();
  await thinking.getByRole("button", { name: "Collapse step trace" }).click();
  await thinking.getByText(/The geometry should stay the same/).waitFor({ state: "hidden" });

  const card = page.locator(".subagent-item", { hasText: "Search the syntax module" });
  await card.getByTitle("completed", { exact: true }).waitFor();
  expect(await card.getByTitle("Cancel this subagent").count()).toBe(0);
  await card.getByRole("button", { name: "Expand subagent: Search the syntax module" }).click();
  const details = card.locator(":scope > .subagent-details");
  await details.getByText("Found 2 mutation sites, verifying callers now.").waitFor();
  await card.locator(".subagent-time", { hasText: /^21s$/ }).waitFor();
  await details.getByRole("button", { name: "Collapse subagent trace" }).click();
  await details.waitFor({ state: "detached" });

  const running = page.locator(".subagent-item", { hasText: "Watch CI for regressions" });
  await running.getByRole("button", { name: "Cancel", exact: true }).click();
  await running.getByTitle("stopped", { exact: true }).waitFor();
  expect(await running.getAttribute("class")).toContain("subagent-stopped");
  await running.getByRole("button", { name: "Cancel", exact: true }).waitFor({ state: "hidden" });
  await turn.getByText(/The fixtures cover the waiting, thinking, and tool phases/).waitFor();
  await page.getByRole("button", { name: /^Jump to quoted message from Demo:/ }).click();
  await page.locator("#msg-demo-msg-1.message-highlight").waitFor();
}, 50_000);
