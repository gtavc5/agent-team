import * as http from "node:http";
import * as path from "node:path";

export class RuntimeConfigError extends Error {}

const proxyKeys = ["http_proxy", "https_proxy", "no_proxy"] as const;
export type ProxyConfig = Partial<Record<(typeof proxyKeys)[number], string>>;
export interface AcpProxyConfig {
  enabled?: boolean;
  upstream_url?: string;
  port?: number;
  ping_interval_ms?: number;
  ping_timeout_ms?: number;
  max_retries?: number;
  retry_budget_ms?: number;
}

export interface AcpConfig {
  binary?: string;
  permissions?: "default" | "auto_edit" | "yolo";
  runtime_updates?: "automatic" | "notify" | "manual";
  proxy?: AcpProxyConfig;
}

function table(input: unknown, name: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new RuntimeConfigError(`Expected [${name}] table`);
  return input as Record<string, unknown>;
}

export function readProxy(input: unknown): ProxyConfig | undefined {
  if (input === undefined) return undefined;
  const proxy: ProxyConfig = {};
  for (const [key, value] of Object.entries(table(input, "server.proxy"))) {
    if (!proxyKeys.some((k) => k === key))
      throw new RuntimeConfigError("Unsupported key in [server.proxy]");
    if (typeof value !== "string" || /[\r\n\0]/.test(value))
      throw new RuntimeConfigError(`Expected a string in server.proxy.${key}`);
    if (key !== "no_proxy" && value) {
      const url = URL.parse(value);
      if (!url || !["http:", "https:"].includes(url.protocol))
        throw new RuntimeConfigError(`Expected an HTTP(S) URL in server.proxy.${key}`);
    }
    proxy[key as keyof ProxyConfig] = value;
  }
  return proxy;
}

const maxTimerMs = 2_147_483_647;
const acpProxyIntegerBounds = {
  port: [0, 65_535],
  ping_interval_ms: [1, maxTimerMs],
  ping_timeout_ms: [1, maxTimerMs],
  max_retries: [0, 1],
  retry_budget_ms: [1, maxTimerMs],
} as const;

function readAcpProxy(input: unknown): AcpProxyConfig | undefined {
  if (input === undefined) return undefined;
  const config: AcpProxyConfig = {};
  const raw = table(input, "pi.acp.proxy");
  if (Object.getPrototypeOf(raw) !== Object.prototype)
    throw new RuntimeConfigError("Expected [pi.acp.proxy] table");
  for (const [key, value] of Object.entries(raw)) {
    if (key === "enabled") {
      if (typeof value !== "boolean")
        throw new RuntimeConfigError("pi.acp.proxy.enabled must be a boolean");
      config.enabled = value;
    } else if (key === "upstream_url") {
      if (
        typeof value !== "string" ||
        /[\r\n\0]/.test(value) ||
        !/^https?:\/\/[^\s/@?#\\]+\/?$/i.test(value) ||
        !URL.canParse(value)
      )
        throw new RuntimeConfigError("pi.acp.proxy.upstream_url must be an HTTP(S) origin");
      config.upstream_url = new URL(value).origin;
    } else if (Object.hasOwn(acpProxyIntegerBounds, key)) {
      const integerKey = key as keyof typeof acpProxyIntegerBounds;
      const [min, max] = acpProxyIntegerBounds[integerKey];
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
        throw new RuntimeConfigError(
          `pi.acp.proxy.${integerKey} must be an integer from ${min} to ${max}`,
        );
      config[integerKey] = value;
    } else {
      throw new RuntimeConfigError("Unsupported key in [pi.acp.proxy]");
    }
  }
  return config;
}

export function readAcp(input: unknown): AcpConfig | undefined {
  if (input === undefined) return undefined;
  const raw = table(input, "pi.acp");
  if (
    Object.keys(raw).some((k) => !["permissions", "runtime_updates", "binary", "proxy"].includes(k))
  )
    throw new RuntimeConfigError("Unsupported key in [pi.acp]");
  const { permissions, runtime_updates, binary } = raw;
  if (
    permissions !== undefined &&
    permissions !== "yolo" &&
    permissions !== "default" &&
    permissions !== "auto_edit"
  )
    throw new RuntimeConfigError("pi.acp.permissions must be default, auto_edit, or yolo");
  if (
    runtime_updates !== undefined &&
    runtime_updates !== "manual" &&
    runtime_updates !== "notify" &&
    runtime_updates !== "automatic"
  )
    throw new RuntimeConfigError("pi.acp.runtime_updates must be manual, notify, or automatic");
  if (
    binary !== undefined &&
    (typeof binary !== "string" || !path.isAbsolute(binary) || /[\r\n\0]/.test(binary))
  )
    throw new RuntimeConfigError("pi.acp.binary must be an absolute executable path");
  const proxy = readAcpProxy(raw.proxy);
  return { binary, permissions, runtime_updates, ...(proxy && { proxy }) };
}

export function applyRuntimeEnvironment(proxy?: ProxyConfig, binary?: string) {
  if (binary) process.env.AGY_ACP_BIN = binary;
  const explicit = proxy && Object.keys(proxy).length > 0;
  if (
    !explicit &&
    !["http_proxy", "https_proxy", "all_proxy"].some(
      (k) => process.env[k] || process.env[k.toUpperCase()],
    )
  )
    return;
  for (const key of proxyKeys) {
    if (proxy?.[key] !== undefined) process.env[key] = process.env[key.toUpperCase()] = proxy[key];
  }
  // The Pi bridge is on loopback, including when external traffic needs a proxy.
  const bypass = process.env.no_proxy ?? process.env.NO_PROXY;
  process.env.no_proxy = process.env.NO_PROXY = [
    ...new Set([...(bypass ?? "").split(","), "localhost", "127.0.0.1", "[::1]"].filter(Boolean)),
  ].join(",");
  if (explicit) process.env.NODE_USE_ENV_PROXY = "1";
  if (explicit || process.env.NODE_USE_ENV_PROXY === "1") http.setGlobalProxyFromEnv();
}
