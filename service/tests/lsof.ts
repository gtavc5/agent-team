import * as fs from "node:fs";
import * as path from "node:path";

// macOS places lsof in /usr/sbin, which non-login shells and CI runners often
// omit from PATH; check PATH first and fall back to standard system sbin dirs.
export function lsofBinary(): string {
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    "/usr/sbin",
    "/sbin",
    "/usr/bin",
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, "lsof");
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return "lsof";
}
