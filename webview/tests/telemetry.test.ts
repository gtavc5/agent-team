// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TelemetryBatch } from "../../shared/telemetry";
import { configureTelemetry, recordTelemetry } from "../src/telemetry";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  configureTelemetry(true);
});
afterEach(() => {
  configureTelemetry(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function slowFirstPost() {
  let complete!: (response: Response) => void;
  const first = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  const post = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(first)
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", post);
  recordTelemetry("panel.agents");
  vi.advanceTimersByTime(5000);
  return {
    post,
    complete: async () => {
      complete(new Response(null, { status: 204 }));
      await first;
    },
  };
}

it("flushes the queued threshold as soon as the preceding POST completes", async () => {
  const { post, complete } = slowFirstPost();
  for (let i = 0; i < 20; i++) recordTelemetry("panel.files");
  expect(post).toHaveBeenCalledTimes(1);
  await complete();
  expect(post).toHaveBeenCalledTimes(2);
  const [url, init] = post.mock.calls[1];
  expect(url).toBe("api/telemetry");
  expect(init?.referrerPolicy).toBe("no-referrer");
  const batch = JSON.parse(init?.body as string) as TelemetryBatch;
  expect(batch.events).toHaveLength(20);
  expect(batch.events[0]).toMatchObject({ layout: "narrow", action: "panel.files" });
  expect(batch.events[1].ts).toBeGreaterThan(batch.events[0].ts);
});

it("beacons pending events before BFCache suspension even while a POST is in flight", async () => {
  const { post, complete } = slowFirstPost();
  const beacon = vi.fn<Navigator["sendBeacon"]>().mockReturnValue(true);
  vi.stubGlobal("navigator", { sendBeacon: beacon });
  const first = JSON.parse(post.mock.calls[0][1]?.body as string) as TelemetryBatch;
  // The wall clock moves while the page sleeps, even if its monotonic clock does not.
  const wake = Date.now() + 25 * 3600_000;
  vi.setSystemTime(wake);
  recordTelemetry("confirm.remove_agent", "open");
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  expect(beacon).toHaveBeenCalledExactlyOnceWith("api/telemetry", expect.any(Blob));
  const blob = beacon.mock.calls[0][1] as Blob;
  const final = JSON.parse(await blob.text()) as TelemetryBatch;
  expect(final).toEqual({
    tab_run_id: first.tab_run_id,
    events: [{ ts: wake, layout: "narrow", action: "confirm.remove_agent", outcome: "open" }],
  });
  expect(final.events[0].ts - first.events[0].ts).toBeGreaterThan(60_000);
  await complete();
  expect(post).toHaveBeenCalledTimes(1);
});

it("falls back to keepalive when a hidden-page beacon throws", async () => {
  const { post, complete } = slowFirstPost();
  vi.stubGlobal("navigator", {
    sendBeacon: () => {
      throw new Error("Beacon unavailable");
    },
  });
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  try {
    recordTelemetry("panel.files");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1]).toMatchObject({ keepalive: true });
  } finally {
    hidden.mockRestore();
    await complete();
  }
});
