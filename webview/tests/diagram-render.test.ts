import { describe, expect, it } from "vitest";
import { sanitizeDiagramSvg } from "../src/chat/diagramRender";

function parsed(svg: string): Document {
  return new DOMParser().parseFromString(svg, "image/svg+xml");
}

describe("diagram SVG sanitization", () => {
  it("removes executable, interactive, CSS, and external-resource payloads", () => {
    const clean = sanitizeDiagramSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" onload="globalThis.pwned = true">
        <style>@import url(https://example.test/pwn.css);</style>
        <script>globalThis.pwned = true</script>
        <foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="globalThis.pwned = true" /></body></foreignObject>
        <image href="https://example.test/pwn.svg" />
        <use href="https://example.test/pwn.svg#shape" />
        <feImage href="data:image/svg+xml;base64,AAAA" />
        <a href="javascript:globalThis.pwned = true"><text x="4" y="20" onclick="globalThis.pwned = true">Safe</text></a>
        <defs><linearGradient id="safe"><stop offset="0" stop-color="#fff" /></linearGradient></defs>
        <path d="M0 0L10 10" fill="url(#safe)" style="background:url(https://example.test/pwn)" />
      </svg>
    `);
    const document = parsed(clean);
    const root = document.documentElement;
    expect(root.localName).toBe("svg");
    expect(root.getAttribute("width")).toBe("120");
    expect(root.getAttribute("height")).toBe("80");
    expect(root.getAttribute("role")).toBe("img");
    expect(document.querySelector("text")?.textContent).toBe("Safe");
    expect(document.querySelector("path")?.getAttribute("fill")).toBe("url(#safe)");
    expect(document.querySelector("linearGradient#safe")).not.toBeNull();
    for (const selector of [
      "script",
      "style",
      "foreignObject",
      "image",
      "use",
      "feImage",
      "a",
      "[style]",
    ]) {
      expect(document.querySelector(selector), selector).toBeNull();
    }
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.name.toLowerCase()).not.toMatch(/^on/);
        if (!attribute.name.toLowerCase().startsWith("xmlns")) {
          expect(attribute.value).not.toMatch(/javascript:|https?:|data:|@import/i);
        }
        expect(attribute.value).not.toMatch(/url\(\s*(?!#)/i);
      }
    }
  });

  it("keeps renderer-generated local CSS and internal paint references", () => {
    const clean = sanitizeDiagramSvg(
      '<svg viewBox="0 0 20 20"><style>.edge { stroke: #333; } @media (min-width: 10px) { .edge { stroke-width: 1; } }</style><path class="edge" d="M0 0L10 10" /></svg>',
    );
    expect(parsed(clean).querySelector("style")?.textContent).toContain(".edge");
    expect(parsed(clean).querySelector("path")?.getAttribute("class")).toBe("edge");
  });

  it.each(["", "'", '"'])("keeps a fragment-only CSS URL with %s quotes", (quote) => {
    const css = `.edge { stroke: url(${quote}#diagram-preview-1-gradient${quote}); }`;
    expect(
      parsed(sanitizeDiagramSvg(`<svg><style>${css}</style></svg>`)).querySelector("style")
        ?.textContent,
    ).toBe(css);
  });

  it.each([
    "url(https://example.test)",
    "url(//example.test)",
    "url(data:image/png,abc)",
    "url(#ok) url(https://example.test)",
    'url("#id" https://example.test)',
    String.raw`\75 rl(relative)`,
    '@import "relative"',
    'image-set("relative" 1x)',
    "url(\u00a0#id)",
    'url("/*comment*/#id")',
    'src("relative")',
  ])("strips unsafe CSS: %s", (value) => {
    const clean = sanitizeDiagramSvg(`<svg><style>.edge { stroke: ${value}; }</style></svg>`);
    expect(parsed(clean).querySelector("style")).toBeNull();
  });

  it("fails closed instead of inserting a non-SVG or an external reference", () => {
    expect(() => sanitizeDiagramSvg("<div>not a diagram</div>")).toThrow(/valid SVG/);
    expect(() =>
      sanitizeDiagramSvg('<svg><path fill="url(https://example.test/pwn)" /></svg>'),
    ).toThrow(/SVG|sanitization/);
  });
});
