import { stripVTControlCharacters } from "node:util";
import type { UiChange } from "./types";

const key = (v: unknown): v is string => typeof v === "string" && v.length <= 128;
function plain(value: string, limit: number): string {
  // Bound work on terminal-formatted input as well as the retained plain text.
  return stripVTControlCharacters(value.slice(0, limit * 8))
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .slice(0, limit)
    .replace(/[\uD800-\uDBFF]$/, "");
}

export function decodeExtensionUi(
  event: Record<string, unknown>,
  onIgnoredLines: () => void,
): UiChange | undefined {
  if (!key(event.id) || !event.id) return;
  switch (event.method) {
    case "notify": {
      const level = event.notifyType === undefined ? "info" : event.notifyType;
      if (
        typeof event.message !== "string" ||
        (level !== "info" && level !== "warning" && level !== "error")
      )
        return;
      return { kind: "notify", id: event.id, message: plain(event.message, 1024), level };
    }
    case "setStatus": {
      const { statusKey, statusText } = event;
      if (!key(statusKey) || (statusText !== undefined && typeof statusText !== "string")) return;
      return {
        kind: "status",
        key: statusKey,
        text: statusText === undefined ? undefined : plain(statusText, 256),
      };
    }
    case "setWidget": {
      const { widgetKey, widgetLines } = event;
      const placement = event.widgetPlacement === undefined ? "aboveEditor" : event.widgetPlacement;
      if (
        !key(widgetKey) ||
        (placement !== "aboveEditor" && placement !== "belowEditor") ||
        (widgetLines !== undefined && !Array.isArray(widgetLines))
      )
        return;
      if (widgetLines === undefined) return { kind: "widget", key: widgetKey, placement };
      const lines: string[] = [];
      let malformed = false;
      for (const line of widgetLines) {
        if (typeof line !== "string") malformed = true;
        else if (lines.length < 12) lines.push(plain(line, 256));
      }
      // Keep useful mixed-array content, but don't let a malformed-only
      // payload erase a visible widget as if Pi had sent a valid empty array.
      if (malformed && !lines.length) return;
      if (malformed) onIgnoredLines();
      return { kind: "widget", key: widgetKey, placement, lines };
    }
  }
}
