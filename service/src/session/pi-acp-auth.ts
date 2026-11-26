import * as fs from "node:fs";
import * as path from "node:path";

export const PI_ACP_PACKAGE = "pi-antigravity-acp-provider";
export const ACP_LOGIN_STEP =
  "Run /login antigravity-acp in standalone host Pi as the YAAT service user, then start a new YAAT Pi session.";
const resolveConflict =
  "Stop sessions using the managed copy, choose which login to keep, and move the managed gemini directory or link aside before starting a new YAAT Pi session.";

type GeminiMapping =
  | {
      host: string;
      managed: string;
      status: "local" | "linked" | "link" | "replace-empty";
    }
  | {
      host: string;
      managed: string;
      status: "conflict";
      reason: string;
    };

export function inspectPiAcpMapping(sourceAgentDir: string, piAgentDir: string): GeminiMapping {
  const host = path.resolve(sourceAgentDir, "antigravity-acp-provider", "gemini");
  const managed = path.resolve(piAgentDir, "antigravity-acp-provider", "gemini");
  const conflict = (reason: string) => ({ host, managed, status: "conflict" as const, reason });
  try {
    const hostInfo = fs.statSync(host, { throwIfNoEntry: false });
    const managedInfo = fs.lstatSync(managed, { throwIfNoEntry: false });
    if (hostInfo && !hostInfo.isDirectory())
      return conflict("the host gemini path is not a directory");
    if (host === managed) return { host, managed, status: "local" };
    if (managedInfo?.isSymbolicLink()) {
      const target = path.resolve(path.dirname(managed), fs.readlinkSync(managed));
      if (target === host) return { host, managed, status: "linked" };
      return conflict(
        "the managed gemini link points somewhere other than the host login directory",
      );
    }
    if (managedInfo && !managedInfo.isDirectory())
      return conflict("the managed gemini path is not a directory");
    if (!hostInfo) return { host, managed, status: "local" };
    if (!managedInfo) return { host, managed, status: "link" };
    if (fs.realpathSync.native(host) === fs.realpathSync.native(managed))
      return { host, managed, status: "local" };
    if (!fs.readdirSync(managed).length) return { host, managed, status: "replace-empty" };
    // There is no version-independent way to tell credentials from other local state.
    // Keep every nonempty tree, even one that looks identical or contains only runtime data.
    return conflict(
      "the host and managed gemini directories are separate and the managed directory is not empty",
    );
  } catch {
    return conflict("unable to inspect both gemini paths");
  }
}

export function preparePiAcpMapping(
  sourceAgentDir: string,
  piAgentDir: string,
): string | undefined {
  const mapping = inspectPiAcpMapping(sourceAgentDir, piAgentDir);
  if (mapping.status === "conflict") return piAcpMappingError(mapping);
  if (mapping.status === "local" || mapping.status === "linked") return;
  try {
    // Do not recursively delete even if the path was empty at inspection time.
    if (mapping.status === "replace-empty") fs.rmdirSync(mapping.managed);
    fs.symlinkSync(mapping.host, mapping.managed, "junction");
  } catch {
    const latest = inspectPiAcpMapping(sourceAgentDir, piAgentDir);
    if (latest.status === "linked") return; // Another Pi start finished the mapping.
    return piAcpMappingError({
      ...mapping,
      status: "conflict",
      reason: "unable to link the managed gemini path to the host",
    });
  }
}

function piAcpMappingError(mapping: Extract<GeminiMapping, { status: "conflict" }>): string {
  return `Antigravity ACP is disabled: ${mapping.reason}. Host: ${mapping.host}. Managed: ${mapping.managed}. ${resolveConflict}`;
}

function readRecord(file: string): Record<string, unknown> | undefined {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile()) throw new Error("not a regular file");
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!isRecord(value)) throw new Error("not a JSON object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export type PiAcpLocalAuth = {
  status: "missing" | "mismatch" | "conflict" | "present";
  source: string;
  reason: string;
  nextStep?: string;
};

export function inspectPiAcpLocalAuth(
  sourceAgentDir: string,
  piAgentDir: string,
  env: NodeJS.ProcessEnv,
): PiAcpLocalAuth {
  const mapping = inspectPiAcpMapping(sourceAgentDir, piAgentDir);
  if (mapping.status === "conflict")
    return {
      status: "conflict",
      source: mapping.managed,
      reason: `${mapping.reason}. Host: ${mapping.host}.`,
      nextStep: resolveConflict,
    };

  // Match the runtime's explicit auth.json mapping, including an existing legacy managed file.
  let authFile = path.join(sourceAgentDir, "auth.json");
  let credential: unknown;
  try {
    const hostAuth = readRecord(authFile);
    if (hostAuth) credential = hostAuth["antigravity-acp"];
    else {
      authFile = path.join(piAgentDir, "auth.json");
      credential = readRecord(authFile)?.["antigravity-acp"];
    }
  } catch {
    return {
      status: "mismatch",
      source: authFile,
      reason: "the Pi auth file is unreadable or invalid JSON",
      nextStep: ACP_LOGIN_STEP,
    };
  }
  if (
    isRecord(credential) &&
    credential.type === "api_key" &&
    typeof credential.key === "string" &&
    credential.key.trim()
  )
    return { status: "present", source: authFile, reason: "a local Pi API key is configured" };
  if (credential === undefined && env.GEMINI_API_KEY?.trim())
    return {
      status: "present",
      source: "GEMINI_API_KEY",
      reason: "an API key is configured in the environment",
    };

  // Compatibility inspection for the file-backed pi-antigravity-acp-provider
  // layout (provider auth.ts and acp/{antigravity,credential-storage}.ts).
  // Do not import third-party TS, launch agy, resolve credential commands or open Keychain here.
  const gemini = mapping.status === "local" ? mapping.managed : mapping.host;
  const store = path.join(gemini, "antigravity-acp");
  let saved = false;
  try {
    readRecord(path.join(store, "settings.json"));
    const token = readRecord(path.join(store, "acp_token.json"));
    if (token && !(typeof token.refresh_token === "string" && token.refresh_token.length))
      return {
        status: "mismatch",
        source: store,
        reason: "the local ACP token has no refresh token",
        nextStep: ACP_LOGIN_STEP,
      };
    saved = !!token;
  } catch {
    return {
      status: "mismatch",
      source: store,
      reason: "the local ACP token or settings are unreadable or invalid JSON",
      nextStep: ACP_LOGIN_STEP,
    };
  }
  const oauthMarker =
    isRecord(credential) &&
    credential.type === "oauth" &&
    typeof credential.access === "string" &&
    typeof credential.refresh === "string" &&
    !!credential.refresh &&
    Number.isFinite(credential.expires)
      ? credential.access
      : undefined;
  if (oauthMarker && saved) {
    // The marker is provider-owned. Recognize this layout without claiming
    // that a provider version with a different marker cannot authenticate.
    if (!oauthMarker.startsWith("pi-antigravity-acp:managed-by-antigravity:"))
      return {
        status: "mismatch",
        source: authFile,
        reason: "the Pi OAuth entry does not match the known file-backed ACP login marker",
        nextStep: ACP_LOGIN_STEP,
      };
    return {
      status: "present",
      source: store,
      reason: "a recognized Pi OAuth marker and file-backed ACP token are present",
    };
  }
  if (credential !== undefined || saved)
    return {
      status: "mismatch",
      source: oauthMarker ? store : authFile,
      reason: oauthMarker
        ? "the Pi OAuth entry exists but the file-backed ACP login is missing"
        : "the ACP login requires a matching Pi OAuth entry or API key",
      nextStep: ACP_LOGIN_STEP,
    };
  return {
    status: "missing",
    source: store,
    reason: "no Pi credential or file-backed ACP login was found",
    nextStep: ACP_LOGIN_STEP,
  };
}

export function piAcpAuthGuidance(error: string, acpModel: boolean): string | undefined {
  if (
    /no saved Google login|Antigravity authentication required/i.test(error) ||
    (acpModel && /\bauthentication required\b/i.test(error))
  )
    return `Antigravity ACP authentication failed. ${ACP_LOGIN_STEP}`;
}
