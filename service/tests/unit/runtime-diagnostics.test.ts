import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/config";
import { doctor } from "../../src/config/doctor";
import { formatReport, serviceReport } from "../../src/config/diagnostics";
import { applyRuntimeEnvironment } from "../../src/config/runtime";
import * as http from "node:http";

const dirs: string[] = [];
function base(toml?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaat-runtime-test-"));
  dirs.push(dir);
  if (toml !== undefined) fs.writeFileSync(path.join(dir, "config.toml"), toml);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("[pi.acp.proxy] config", () => {
  it("reads every supported field, including zero and disabled", () => {
    const dir = base(`[pi.acp.proxy]
      enabled = false
      upstream_url = "http://[::1]:9876/"
      port = 0
      ping_interval_ms = 1
      ping_timeout_ms = 2147483647
      max_retries = 0
      retry_budget_ms = 500
    `);
    expect(loadConfig(dir).pi?.acp?.proxy).toEqual({
      enabled: false,
      upstream_url: "http://[::1]:9876",
      port: 0,
      ping_interval_ms: 1,
      ping_timeout_ms: 2147483647,
      max_retries: 0,
      retry_budget_ms: 500,
    });
  });

  it.each([
    ["[pi.acp]\nproxy = []", "[pi.acp.proxy] table"],
    ["[pi.acp]\nproxy = 2026-01-01", "[pi.acp.proxy] table"],
    ...[
      ['enabled = "false"', "enabled"],
      ["port = 65536", "port"],
      ["port = 0.5", "port"],
      ["port = -1", "port"],
      ["max_retries = 2", "max_retries"],
      ["ping_interval_ms = 0", "ping_interval_ms"],
      ["ping_timeout_ms = 2147483648", "ping_timeout_ms"],
      ["retry_budget_ms = -1", "retry_budget_ms"],
      ['upstream_url = "ftp://example.test"', "upstream_url"],
      ['upstream_url = "https://user:supersecret@example.test"', "upstream_url"],
      ['upstream_url = "https://example.test/?"', "upstream_url"],
      ['upstream_url = "https://example.test/#"', "upstream_url"],
      ['upstream_url = "https://example.test/.."', "upstream_url"],
      ["unexpected = 0", "Unsupported key"],
    ].map(([line, field]) => [`[pi.acp.proxy]\n${line}`, field]),
  ])("rejects malformed proxy config (%s)", (toml, field) => {
    const dir = base(toml);
    expect(() => loadConfig(dir)).toThrow(field);
    expect(() => loadConfig(dir)).not.toThrow("supersecret");
  });
});

describe("service diagnostics", () => {
  it("reports missing and invalid config without echoing TOML source", async () => {
    for (const [dir, code] of [
      [base(), "CONFIG_MISSING"],
      [base("password = !supersecret"), "CONFIG_INVALID"],
      [base('[server.proxy]\nhttps_proxy = "supersecret"'), "CONFIG_INVALID"],
    ]) {
      const { ok, report } = await doctor(dir);
      expect(ok).toBe(false);
      expect(report.issues[0]).toMatchObject({
        stage: "config",
        code,
        source: path.join(dir, "config.toml"),
      });
      expect(JSON.stringify(report)).not.toContain("supersecret");
      expect(formatReport(report)).toContain(report.issues[0].nextStep);
    }
  });
  it("reports actual binary and policy provenance, never proxy credentials", () => {
    const dir = base(
      '[server.proxy]\nhttps_proxy="http://user:supersecret@proxy"\n[pi.acp]\npermissions="auto_edit"\nruntime_updates="notify"\nbinary="/unavailable/acp"',
    );
    const cfg = loadConfig(dir);
    const report = serviceReport(
      dir,
      cfg,
      { models: [], defaultModel: null, issues: [] },
      {
        PATH: dir,
        HOME: dir,
        AGY_ACP_BIN: cfg.pi!.acp!.binary,
        https_proxy: cfg.server.proxy!.https_proxy,
      },
    );
    expect(report.facts).toMatchObject({
      acpPermissions: { value: "auto_edit" },
      acpRuntimeUpdates: { value: "notify" },
      HTTPS_PROXY: { source: "config.toml: server.proxy.https_proxy" },
    });
    expect(report.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(["acp_runtime_missing", "acp_permissions_unverified"]),
    );
    expect(formatReport(report) + JSON.stringify(report)).not.toContain("supersecret");
  });
  it("diagnoses the existing instance profile without overwriting or quoting it", async () => {
    const dir = base("");
    const folder = path.join(dir, "pi-agent-home", "antigravity-acp-provider");
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, "config.json");
    fs.writeFileSync(file, "[malformed:supersecret");
    vi.stubEnv("CODEX_HOME", path.join(dir, "codex"));
    const { report } = await doctor(dir);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "acp_profile_invalid", source: file, value: "invalid JSON" }),
    );
    expect(fs.readFileSync(file, "utf8")).toBe("[malformed:supersecret");
    expect(formatReport(report)).not.toContain("supersecret");
  });
  it.each([
    "https://user:supersecret@proxy.invalid",
    "//user:supersecret@proxy.invalid",
    "/absolute/supersecret",
  ])("redacts an unusable ACP override in both formats", (override) => {
    const dir = base("[pi]");
    const report = serviceReport(
      dir,
      loadConfig(dir),
      { models: [], defaultModel: null, issues: [] },
      { HOME: dir, PATH: dir, AGY_ACP_BIN: override },
    );
    expect(report.facts.acpRuntime.value).toBe("invalid override (redacted)");
    expect(JSON.stringify(report) + formatReport(report)).not.toContain("supersecret");
  });
  it("keeps inherited proxies off the loopback bridge without opting new clients into proxy use", () => {
    vi.stubEnv("HTTP_PROXY", "http://proxy.invalid");
    vi.stubEnv("no_proxy", undefined);
    vi.stubEnv("NO_PROXY", "example.org");
    vi.stubEnv("NODE_USE_ENV_PROXY", undefined);
    applyRuntimeEnvironment();
    expect(process.env.no_proxy?.split(",")).toEqual(
      expect.arrayContaining(["127.0.0.1", "example.org"]),
    );
    expect(process.env.NODE_USE_ENV_PROXY).toBeUndefined();
  });
  it("supplies explicit proxy and ACP settings to new processes while preserving loopback", () => {
    const env = process.env;
    for (const k of [
      "HTTP_PROXY",
      "http_proxy",
      "NO_PROXY",
      "no_proxy",
      "NODE_USE_ENV_PROXY",
      "AGY_ACP_BIN",
    ])
      vi.stubEnv(k, undefined);
    const restore = http.setGlobalProxyFromEnv({});
    try {
      applyRuntimeEnvironment(
        { http_proxy: "http://localhost:1234", no_proxy: "example.org" },
        "/opt/acp",
      );
      expect(env.AGY_ACP_BIN).toBe("/opt/acp");
      expect(env.http_proxy).toBe(env.HTTP_PROXY);
      expect(env.no_proxy?.split(",")).toEqual(
        expect.arrayContaining(["example.org", "127.0.0.1"]),
      );
      expect(env.NODE_USE_ENV_PROXY).toBe("1");
    } finally {
      restore();
    }
  });
});
