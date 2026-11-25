import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { resolveLocalPi } from "../local-pi";

it("keeps the PATH launcher but resolves SDK dependencies from the managed release", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yaat-pi-launcher-")));
  const fixture = (file: string, content: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { mode: 0o755 });
  };
  try {
    const launcher = join(root, "bin", "pi");
    const install = join(root, "install");
    const modules = join(install, "releases", "1.6.0", "node_modules");
    const entry = join(modules, ".bin", "pi");
    const typebox = join(modules, "typebox", "value.js");
    fixture(launcher, "#!/bin/sh\n");
    fixture(
      join(install, "managed-install.json"),
      JSON.stringify({
        kind: "pi-managed-install",
        layout: "releases-v1",
      }),
    );
    fixture(join(install, "current-version"), "1.6.0\n");
    fixture(entry, "#!/usr/bin/env node\n");
    fixture(typebox, "module.exports = {};\n");
    const pi = resolveLocalPi({ PATH: dirname(launcher) });
    expect(pi.binary).toBe(launcher);
    expect(createRequire(pi.sdkAnchor!).resolve("typebox/value")).toBe(typebox);

    const override = join(root, "custom-pi");
    fixture(override, "#!/bin/sh\n");
    expect(resolveLocalPi({ PATH: dirname(launcher), PI_BINARY: override })).toEqual({
      binary: override,
      sdkAnchor: override,
    });
    expect(resolveLocalPi({ PATH: dirname(launcher), PI_BINARY: join(root, "missing") })).toEqual(
      {},
    );
    expect(resolveLocalPi({ PATH: root })).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
