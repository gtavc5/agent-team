import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImagePathContext, MdBlock } from "../src/chat/markdown";
import { FilesPanel } from "../src/panels/FilesPanel";
import { FilePreview } from "../src/project/NotesView";

const passthrough = [
  "http://example.test/a.png",
  "https://example.test/a.png?q=1#hash",
  "//example.test/a.png",
  "data:image/png;base64,AAAA",
  "blob:https://example.test/id",
  "uploads/a.png",
  "/uploads/a.png",
  "avatars/a.png",
  "/avatars/a.png",
  "api/file/raw?ws=w&path=a.png",
  "/api/file/raw?project=p&path=a.png",
];
const blocked = [
  "JaVaScRiPt:alert(1)",
  "vbscript:test",
  "file://remote/a.png",
  "file:relative.png",
];
const local = [
  ["figures/a.png#gh-dark-mode-only", "figures/a.png"],
  ["./figures/a.png?v=1", "./figures/a.png"],
  ["../img/a.png", "../img/a.png"],
  ["figures/my%20%E5%9B%BE%E8%A1%A8.png", "figures/my 图表.png"],
  ["figures/a%23b%3Fc%25.png?x=1#y", "figures/a#b?c%.png"],
  ["figures/my%20chart%ZZ%FF.png", "figures/my chart%ZZ%FF.png"],
  ["figures/my%20%FF.png", "figures/my %FF.png"],
  ["figures/%E5%9B%BE%FF.png", "figures/图%FF.png"],
  ["/abs/chart.png", "/abs/chart.png"],
  ["C:/img/chart.png", "C:/img/chart.png"],
  ["file:///abs/chart.png", "/abs/chart.png"],
  ["file://localhost/C%3A/img/chart.png", "C:/img/chart.png"],
];
const images = (urls: string[]) => urls.map((url, i) => `![Image ${i}](<${url}>)`).join("\n\n");
const sources = (container: HTMLElement) =>
  [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));

afterEach(() => vi.unstubAllGlobals());

it("leaves chat images intact without routing to the filesystem", () => {
  const { container } = render(
    <MdBlock>{images([...passthrough, "figures/a.png", "file:///abs/a.png", ...blocked])}</MdBlock>,
  );
  expect(sources(container)).toEqual([
    ...passthrough,
    "figures/a.png",
    ...Array<null>(blocked.length + 1).fill(null),
  ]);
});

it("only sends decoded local image paths to the preview resolver", () => {
  const raw = (path: string) => `api/file/raw?ws=w&path=${encodeURIComponent(path)}`;
  const resolve = vi.fn(raw);
  const rejected = [
    ...blocked,
    "mailto:user@example.com",
    "irc://example.test/room",
    "ircs://example.test/room",
    "xmpp:user@example.test",
    "file:////remote/a.png",
    "%2f%2fremote/a.png",
    "a%00.png",
    "#hash",
  ];
  const { container } = render(
    <ImagePathContext.Provider value={resolve}>
      <MdBlock>{images([...passthrough, ...local.map(([url]) => url), ...rejected])}</MdBlock>
    </ImagePathContext.Provider>,
  );
  expect(resolve.mock.calls).toEqual(local.map(([, path]) => [path]));
  expect(sources(container)).toEqual([
    ...passthrough,
    ...local.map(([, path]) => raw(path)),
    ...Array<null>(rejected.length).fill(null),
  ]);
});

function loadMarkdown(path: string, urls: string[], ref?: string) {
  const content = images(urls);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json({ kind: "text", path, content, ref }))),
  );
}

it.each([
  {
    path: "/w/docs/guide.md",
    urls: [
      "figures/a.png#hash",
      "./figures/b.png?x",
      "../img/%E5%9B%BE%20a.png",
      "C:/a.png",
      "file:///abs/a.png",
      "../../../a.png",
    ],
    paths: [
      "/w/docs/figures/a.png",
      "/w/docs/figures/b.png",
      "/w/img/图 a.png",
      "C:/a.png",
      "/abs/a.png",
      "/a.png",
    ],
  },
  {
    path: "/p/notes/nested/guide.md",
    ref: "notes/nested/guide.md",
    urls: ["notes/figures/a.png", "./figures/b.png", "../img/c.png", "figures/d.png"],
    paths: [
      "/p/notes/figures/a.png",
      "/p/notes/nested/figures/b.png",
      "/p/notes/img/c.png",
      "figures/d.png",
    ],
  },
  {
    path: "/w/link/guide.md",
    literalPath: true,
    urls: ["../img/a.png"],
    paths: ["/w/link/../img/a.png"],
  },
])("routes Files Markdown images from $path", async ({ path, ref, literalPath, urls, paths }) => {
  loadMarkdown(path, urls, ref);
  const { container, findAllByRole } = render(
    <FilesPanel wsId="w 1" target={{ path, literalPath }} roots={[]} />,
  );
  await findAllByRole("img");
  expect(sources(container)).toEqual(
    paths.map(
      (p) =>
        `api/file/raw?ws=w%201&path=${encodeURIComponent(p)}${literalPath ? "&literal=1" : ""}`,
    ),
  );
});

it("routes Board and Notes Markdown images using the resolved note reference", async () => {
  loadMarkdown(
    "/p/notes/nested/guide.md",
    [
      "../img/my%20%E5%9B%BE.png?x=1#hash",
      "./figures/b.png",
      "notes/figures/c.png",
      "figures/d.png",
      "file:///C:/p/a.png",
      "/p/project/a.png",
      "uploads/a.png",
    ],
    "notes/nested/guide.md",
  );
  const { container, findAllByRole } = render(
    <FilePreview
      project="p 1"
      file={{ path: "guide.md" }}
      editor={false}
      onRef={vi.fn()}
      onResolve={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await findAllByRole("img");
  expect(sources(container)).toEqual([
    ...[
      "notes/img/my 图.png",
      "notes/nested/figures/b.png",
      "notes/figures/c.png",
      "figures/d.png",
      "C:/p/a.png",
      "/p/project/a.png",
    ].map((p) => `api/file/raw?project=p%201&path=${encodeURIComponent(p)}`),
    "uploads/a.png",
  ]);
});
