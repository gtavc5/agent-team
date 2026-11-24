import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const ACP_PREPARE_STEP =
  "Run /antigravity-acp setup in standalone Pi, or configure [pi.acp].binary and restart YAAT.";

// Keep lookup order and filenames in sync with the provider's resolveAntigravityAcpLaunch.
export function inspectAcpRuntime(
  env = process.env,
  cwd = process.cwd(),
): {
  ready: boolean;
  value: string;
  source: string;
} {
  const home = (process.platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
  const executable = (value: string) => {
    try {
      const file = path.resolve(cwd, value);
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  const override = env.AGY_ACP_BIN?.trim();
  if (override) {
    const value =
      override === "~" || override.startsWith("~/") ? path.join(home, override.slice(1)) : override;
    // Unlike the provider's fallback behavior, YAAT treats a configured override as authoritative.
    return { ready: executable(value), value, source: "env" };
  }

  const managed = path.join(home, ".local", "opt", "agy-acp", "current");
  for (const name of ["agy_acp_server.par", "agy_acp_server.exe"]) {
    const value = path.join(managed, name);
    if (executable(value)) return { ready: true, value, source: "managed" };
  }
  const userBin = path.join(home, ".local", "bin", "agy_acp_server.par");
  if (executable(userBin)) return { ready: true, value: userBin, source: "user-bin" };
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const value = path.join(directory, "agy_acp_server.par");
    if (executable(value)) return { ready: true, value, source: "path" };
  }
  return { ready: false, value: "", source: "missing" };
}
