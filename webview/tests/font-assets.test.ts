// Packaging check: browsers can load representative glyphs, but do not expose
// whether every generated Unicode slice has its corresponding bundled file.
import { describe, it, expect } from "vitest";
import main from "../src/main.tsx?raw";

describe("the bundled font", () => {
  const sheets = import.meta.glob<string>("../src/fonts/sarasa-mono-sc/*/result.css", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const slices = new Set(Object.keys(import.meta.glob("../src/fonts/sarasa-mono-sc/*/*.woff2")));

  it("is loaded in all four faces, sliced by character, and first in the stack", () => {
    // Every face real: none faked by slanting or smearing another.
    for (const [dir, weight, style] of [
      ["regular", 400, "normal"],
      ["bold", 700, "normal"],
      ["italic", 400, "italic"],
      ["bold-italic", 700, "italic"],
    ] as const) {
      const sheet = `fonts/sarasa-mono-sc/${dir}/result.css`;
      expect(main).toContain(`import "./${sheet}";`);
      const faces = sheets[`../src/${sheet}`].match(/@font-face\{[^}]*\}/g)!;
      expect(faces.length).toBeGreaterThan(50);
      for (const f of faces) {
        expect(f).toContain('font-family:"Sarasa Mono SC"');
        expect(f).toContain(`font-weight:${weight}`);
        expect(f).toContain(`font-style:${style}`);
        const slice = /url\("\.\/([0-9a-f]+\.woff2)"\)/.exec(f)![1];
        expect(slices.has(`../src/fonts/sarasa-mono-sc/${dir}/${slice}`)).toBe(true);
      }
    }
    // Before the theme, whose rules would otherwise come first.
    expect(main.indexOf("result.css")).toBeLessThan(main.indexOf('"./styles.css"'));
  });
});
