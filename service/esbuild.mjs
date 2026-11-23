import * as fs from "fs";
import * as path from "path";
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

function copyPiBridge() {
  fs.mkdirSync("../dist", { recursive: true });
  fs.copyFileSync(
    path.resolve("src/session/pi-panel-bridge.ts"),
    path.resolve("../dist/pi-panel-bridge.ts"),
  );
}

/** @type {import('esbuild').BuildOptions} */
const build = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node26",
  sourcemap: true,
  minify: false,
  // The search index runs in a worker thread of its own (history-service.ts).
  entryPoints: {
    server: "src/index.ts",
    "history-worker": "src/workspace/history-worker.ts",
  },
  outdir: "../dist",
};

if (watch) {
  esbuild.context(build).then((ctx) => {
    copyPiBridge();
    ctx.watch();
    console.log("Watching for changes...");
  });
} else {
  esbuild.build(build).then(() => {
    copyPiBridge();
    console.log("Server built.");
  });
}
