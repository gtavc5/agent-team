import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

// Resolve before fixtures switch cwd/HOME; use the same executable for detection and spawn.
const lookup = spawnSync("which", [process.env.PI_BINARY ?? "pi"], { encoding: "utf8" });
export const localPiBinary = lookup.status === 0 ? realpathSync(lookup.stdout.trim()) : undefined;
