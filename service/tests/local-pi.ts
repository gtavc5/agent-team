import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { executable, findExecutable } from "../src/config/diagnostics";

// Resolve before fixtures switch cwd/HOME. Do not mistake a missing `which`
// executable for a missing Pi binary.
const requested = process.env.PI_BINARY ?? "pi";
const lookup =
  isAbsolute(requested) || /[/\\]/.test(requested)
    ? executable(resolve(requested))
      ? resolve(requested)
      : undefined
    : findExecutable(requested, process.env);
export const localPiBinary = lookup ? realpathSync(lookup) : undefined;
