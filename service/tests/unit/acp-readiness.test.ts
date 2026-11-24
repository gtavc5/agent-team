import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { inspectAcpRuntime } from "../../src/session/acp-readiness";

let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-readiness-"));
  env = { HOME: root, USERPROFILE: root, PATH: path.join(root, "path-bin") };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function runtime(relative: string) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "not run", { mode: 0o700 });
  return file;
}

it("uses the provider's exact names and precedence and rereads a changing installation", () => {
  runtime("path-bin/agy_acp_server.exe"); // Not a PATH candidate.
  runtime(".local/bin/agy_acp_server.exe"); // Not a user-bin candidate.
  expect(inspectAcpRuntime(env)).toEqual({ ready: false, value: "", source: "missing" });
  const fromPath = runtime("path-bin/agy_acp_server.par");
  expect(inspectAcpRuntime(env)).toEqual({ ready: true, value: fromPath, source: "path" });
  const userBin = runtime(".local/bin/agy_acp_server.par");
  expect(inspectAcpRuntime(env)).toEqual({ ready: true, value: userBin, source: "user-bin" });
  const exe = runtime(".local/opt/agy-acp/current/agy_acp_server.exe");
  expect(inspectAcpRuntime(env)).toEqual({ ready: true, value: exe, source: "managed" });
  const par = runtime(".local/opt/agy-acp/current/agy_acp_server.par");
  expect(inspectAcpRuntime(env)).toEqual({ ready: true, value: par, source: "managed" });
});

it("expands an explicit home path and never falls back when the override is not a file", () => {
  runtime("path-bin/agy_acp_server.par");
  const value = path.join(root, "tools/agy");
  fs.mkdirSync(value, { recursive: true });
  const override = { ...env, AGY_ACP_BIN: " ~/tools/agy " };
  expect(inspectAcpRuntime(override)).toEqual({ ready: false, value, source: "env" });
  fs.rmdirSync(value);
  runtime("tools/agy");
  expect(inspectAcpRuntime(override)).toEqual({ ready: true, value, source: "env" });
});

it.skipIf(process.platform === "win32")("rejects a non-executable override", () => {
  const value = runtime("agy");
  fs.chmodSync(value, 0o600);
  expect(inspectAcpRuntime({ ...env, AGY_ACP_BIN: value })).toEqual({
    ready: false,
    value,
    source: "env",
  });
});
