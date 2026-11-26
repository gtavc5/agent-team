import DOMPurify from "dompurify";
import type { DiagramLanguage, DiagramTheme } from "./DiagramPreview";

const BLOCKED_TAGS = [
  "script",
  "foreignobject",
  "image",
  "img",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "link",
  "a",
  "use",
  "feimage",
  "cursor",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "discard",
];

function safeGeneratedCss(css: string): boolean {
  // Inspect the original tokens: deleting comments can change a quoted URL.
  if (
    /(?:\\|\/\*|@(?!media\b|keyframes\b)|image-set\s*\(|(?:src|image|expression)\s*\(|javascript:|data:|https?:|\/\/|-moz-binding|behavior\s*:)/i.test(
      css,
    )
  )
    return false;
  // Every url() must contain exactly one local fragment and its closing ')'.
  // Use CSS whitespace, not JS \s (which includes valid URL characters).
  return !/url\s*\((?![\t\n\f\r ]*(['"]?)#[\w:.-]+\1[\t\n\f\r ]*\))/i.test(css);
}

function stripUnsafeStyles(raw: string): string {
  const document = new DOMParser().parseFromString(raw, "image/svg+xml");
  if (document.documentElement.localName !== "svg") return raw;
  for (const style of document.querySelectorAll("style")) {
    if (!safeGeneratedCss(style.textContent ?? "")) style.remove();
  }
  return new XMLSerializer().serializeToString(document.documentElement);
}

function assertSafeSvg(root: Element): void {
  for (const element of [root, ...root.querySelectorAll("*")]) {
    if (BLOCKED_TAGS.includes(element.localName.toLowerCase())) {
      throw new Error("Unsafe SVG element survived sanitization");
    }
    if (
      element.localName.toLowerCase() === "style" &&
      !safeGeneratedCss(element.textContent ?? "")
    ) {
      throw new Error("Unsafe SVG CSS survived sanitization");
    }
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || name === "style" || name === "srcdoc") {
        throw new Error("Unsafe SVG attribute survived sanitization");
      }
      if ((name === "href" || name === "xlink:href" || name === "src") && !value.startsWith("#")) {
        throw new Error("External SVG reference survived sanitization");
      }
      if (/url\(/i.test(value) && !/^url\(\s*#[\w:.-]+\s*\)$/i.test(value)) {
        throw new Error("External SVG paint reference survived sanitization");
      }
      if (/(?:javascript:|data:|@import|https?:|\/\/)/i.test(value) && !name.startsWith("xmlns")) {
        throw new Error("External SVG resource survived sanitization");
      }
    }
  }
}

export function sanitizeDiagramSvg(raw: string): string {
  if (!DOMPurify.isSupported) throw new Error("SVG sanitization is unavailable");
  const clean = DOMPurify.sanitize(stripUnsafeStyles(raw), {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: BLOCKED_TAGS,
    FORBID_ATTR: ["style", "srcdoc"],
  });
  const document = new DOMParser().parseFromString(clean, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName !== "svg" || document.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Renderer did not produce a valid SVG");
  }
  assertSafeSvg(root);

  // Preserve the drawing's intrinsic size. The preview, not the chat column,
  // scrolls when a graph is wider than the available space.
  const viewBox = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    root.setAttribute("width", String(Math.ceil(viewBox[2])));
    root.setAttribute("height", String(Math.ceil(viewBox[3])));
  }
  root.setAttribute("role", "img");
  if (!root.hasAttribute("aria-label") && !root.hasAttribute("aria-labelledby")) {
    root.setAttribute("aria-label", "Diagram preview");
  }
  return new XMLSerializer().serializeToString(root);
}

export async function renderDiagram(
  source: string,
  language: DiagramLanguage,
  theme: DiagramTheme,
): Promise<string> {
  const raw =
    language === "mermaid"
      ? await (await import("./mermaidRenderer")).renderMermaid(source, theme)
      : await (await import("./graphvizRenderer")).renderGraphviz(source);
  return sanitizeDiagramSvg(raw);
}
