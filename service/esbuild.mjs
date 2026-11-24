import * as fs from "fs";
import * as path from "path";
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const outdir = path.resolve(process.env.YAAT_BUILD_OUT_DIR ?? "../dist");

function copyPiBridge() {
  fs.mkdirSync(outdir, { recursive: true });
  fs.cpSync("src/session/quota", path.join(outdir, "quota"), { recursive: true });
  for (const file of ["acp-readiness.ts", "pi-panel-bridge.ts", "pi-quota.ts", "quota-schema.ts"]) {
    fs.copyFileSync(path.resolve("src/session", file), path.join(outdir, file));
  }
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
  outdir,
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
