import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { executable, findExecutable } from "../src/config/diagnostics";

// Resolve before fixtures switch cwd/HOME. Do not mistake a missing `which`
// executable for a missing Pi binary.
export function resolveLocalPi(env: NodeJS.ProcessEnv) {
  const requested = env.PI_BINARY ?? "pi";
  const lookup =
    isAbsolute(requested) || /[/\\]/.test(requested)
      ? executable(resolve(requested))
        ? resolve(requested)
        : undefined
      : findExecutable(requested, env);
  if (!lookup) return {};
  const binary = realpathSync(lookup);
  return { binary, sdkAnchor: managedPiEntry(binary) ?? binary };
}

function managedPiEntry(binary: string): string | undefined {
  const binDir = dirname(binary);
  if (basename(binary) !== "pi" || basename(binDir) !== "bin") return;
  const install = join(dirname(binDir), "install");
  try {
    const manifest = JSON.parse(readFileSync(join(install, "managed-install.json"), "utf8")) as {
      kind?: string;
      layout?: string;
    };
    if (manifest.kind !== "pi-managed-install" || manifest.layout !== "releases-v1") return;
    const version = readFileSync(join(install, "current-version"), "utf8").split("\n")[0];
    if (!/^[\w.+-]+$/.test(version) || version === "." || version === "..") return;
    const entry = join(install, "releases", version, "node_modules", ".bin", "pi");
    if (executable(entry)) return realpathSync(entry);
  } catch {
    // Ordinary PATH installs and broken managed installs keep their original launcher.
  }
}

export const { binary: localPiBinary, sdkAnchor: localPiSdkAnchor } = resolveLocalPi(process.env);
