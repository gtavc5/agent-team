// Preloaded only for the local deterministic E2E. Forward bytes unchanged;
// take private temporary copies before the scenario removes child artifacts.
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { syncBuiltinESMExports } from "node:module";
const root = process.env.PI_CAPTURE_SCENARIO;
const original = childProcess.spawn;
childProcess.spawn = function (binary, args, options) {
  const child = original.call(this, binary, args, options);
  if (
    !root ||
    !args?.includes("rpc") ||
    !args.includes("--session-dir") ||
    !child.stdout ||
    !child.stdin
  )
    return child;
  const log = path.join(root, `${child.pid}.jsonl`);
  const save = (row) =>
    fs.appendFileSync(log, JSON.stringify({ at: Date.now(), ...row }) + "\n", { mode: 0o600 });
  const artifact = (file) => {
    if (!file || !fs.existsSync(file)) return;
    const real = fs.realpathSync(file);
    const relative = path.relative(fs.realpathSync(os.tmpdir()), real);
    if (!/^(?:agent-team-pi-|yaat-pi-e2e-)/.test(relative) || !fs.statSync(real).isFile()) return;
    const data = fs.readFileSync(real, "utf8");
    fs.appendFileSync(path.join(root, "files.ndjson"), JSON.stringify({ file, data }) + "\n", {
      mode: 0o600,
    });
    return data;
  };
  const write = child.stdin.write;
  child.stdin.write = function (buf, ...rest) {
    save({ sent: JSON.parse(buf.toString()) });
    return write.call(this, buf, ...rest);
  };
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line);
    save({ frame });
    if (frame.type === "tool_execution_end" && frame.toolName === "subagent")
      for (const r of frame.result.details?.results ?? []) artifact(r.sessionFile);
    if (frame.type === "message_start" && frame.message?.customType === "subagent-notify")
      for (const run of frame.message.details.runs ?? []) {
        const status = artifact(path.join(run.asyncDir, "status.json"));
        if (status) for (const step of JSON.parse(status).steps ?? []) artifact(step.sessionFile);
      }
  });
  return child;
};
syncBuiltinESMExports();
