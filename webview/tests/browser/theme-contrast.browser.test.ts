import { afterEach, expect, it } from "vitest";
import { agentNameColor } from "../../src/workspace/agents";
import "../../src/styles.css";

// WCAG 2.x relative luminance (sRGB). Canvas resolves color-mix and composites
// translucent fills over their host, so chips are measured as actually painted.
function luminance(channels: Uint8ClampedArray) {
  const [r, g, b] = Array.from(channels.slice(0, 3), (byte) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("--test-agent-name");
});

it.each(["light", "dark"])("keeps normal-sized %s text above 4.5:1", (theme) => {
  document.documentElement.dataset.theme = theme;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const styles = getComputedStyle(document.documentElement);
  const painted = (stack: string[]) => {
    ctx.clearRect(0, 0, 1, 1);
    for (const token of stack) {
      const value = styles.getPropertyValue(`--${token}`).trim();
      expect(CSS.supports("color", value), `--${token}: ${value}`).toBe(true);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
    }
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    expect(pixel[3], stack.join(" + ")).toBe(255);
    return luminance(pixel);
  };
  const passes = (foreground: string, ...background: string[]) => {
    const a = painted(background);
    const b = painted([...background, foreground]);
    const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const minimum =
      background.length === 1 && background[0].startsWith("bg-")
        ? foreground === "text-strong"
          ? 9
          : foreground === "text-primary"
            ? 6
            : 4.5
        : 4.5;
    expect(contrast, `${foreground} on ${background.join(" + ")}`).toBeGreaterThanOrEqual(minimum);
  };

  const text = [
    "text-strong",
    "text-primary",
    "text-body",
    "text-secondary",
    "text-muted",
    "accent-text",
  ];
  for (const surface of ["bg-primary", "bg-secondary", "bg-tertiary", "bg-elevated"]) {
    for (const fg of text) {
      passes(fg, surface);
      passes(fg, surface, "bg-active");
      passes(fg, surface, "bg-hover");
    }
    passes("accent-text", surface, "accent-soft");
    for (const status of ["success", "warning", "error", "purple"]) {
      passes(status, surface);
      passes(status, surface, `${status}-soft`);
    }
  }
  for (const fg of [
    "text-body",
    "text-muted",
    "syntax-keyword",
    "syntax-string",
    "syntax-literal",
    "syntax-symbol",
    "syntax-name",
  ]) {
    passes(fg, "bg-tertiary");
    passes(fg, "bg-tertiary", "success-soft");
    passes(fg, "bg-tertiary", "error-soft");
  }
  passes("text-muted", "bg-tertiary", "accent-soft"); // Diff hunk header and sticky gutter.
  for (const fill of ["accent-solid", "accent-hover", "error"]) passes("on-solid", fill);
  for (const profileColor of ["#ffffff", "#000000"]) {
    document.documentElement.style.setProperty("--test-agent-name", agentNameColor(profileColor));
    passes("test-agent-name", "bg-primary");
    passes("test-agent-name", "bg-secondary");
  }
});
