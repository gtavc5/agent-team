import {
  TELEMETRY_BATCH_MAX,
  type TelemetryAction,
  type TelemetryBatch,
  type TelemetryEvent,
  type TelemetryOutcome,
} from "../../shared/telemetry";

import { PHONE } from "./viewport/facts";

const URL = "api/telemetry";
const FLUSH_SIZE = 20;
const CONTENT_TYPE = "application/json";
let enabled = false;
let tabRunId: string | undefined;
let lastTimestamp = 0;
let pending: TelemetryEvent[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let sending = false;

export function configureTelemetry(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  if (next) {
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pagehide", pageHidden);
  } else {
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("pagehide", pageHidden);
    clearTimer();
    pending = [];
  }
}

export function recordTelemetry(
  action: TelemetryAction,
  outcome: TelemetryOutcome = "trigger",
): void {
  if (!enabled || pending.length >= TELEMETRY_BATCH_MAX) return;
  try {
    tabRunId ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    // Distinct timestamps keep the visit ordered even if the final beacon
    // arrives before an outstanding POST, or the wall clock is adjusted.
    lastTimestamp = Math.max(lastTimestamp + 1, Date.now());
    pending.push({
      ts: lastTimestamp,
      layout: matchMedia(PHONE).matches ? "narrow" : "wide",
      action,
      outcome,
    });
    if (pending.length >= FLUSH_SIZE) void flush();
    else if (timer === undefined)
      timer = setTimeout(() => {
        clearTimer();
        void flush();
      }, 5000);
  } catch {
    // Telemetry must not interfere with UI actions.
  }
}

function clearTimer(): void {
  clearTimeout(timer);
  timer = undefined;
}

async function flush(final = false): Promise<void> {
  if (!enabled || !tabRunId || !pending.length || (sending && !final)) return;
  clearTimer();
  const batch: TelemetryBatch = { tab_run_id: tabRunId, events: pending };
  pending = [];
  if (!final) sending = true;
  try {
    const body = JSON.stringify(batch);
    // A hidden or frozen page cannot rely on the earlier POST completing
    // before it is suspended, so send this batch without waiting.
    if (final) {
      try {
        if (navigator.sendBeacon?.(URL, new Blob([body], { type: CONTENT_TYPE }))) return;
      } catch {
        // Fall back to a keepalive POST if the browser rejects the beacon.
      }
    }
    await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": CONTENT_TYPE },
      redirect: "error",
      referrerPolicy: "no-referrer",
      keepalive: true,
      body,
    });
  } catch {
    // Best effort: don't retry ambiguous writes or surface network failures.
  } finally {
    if (!final) {
      sending = false;
      if (
        pending.length &&
        (document.hidden || pending.length >= FLUSH_SIZE || timer === undefined)
      )
        void flush();
    }
  }
}

function visibilityChanged(): void {
  if (document.hidden) void flush(true);
}

function pageHidden(): void {
  void flush(true);
}
