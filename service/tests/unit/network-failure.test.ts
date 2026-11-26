import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyNetworkFailure,
  classifyProbeDelivery,
  isTransientTransportFailure,
  type ProbeDeliveryEvidence,
} from "../../src/project/network-failure";
import type { TurnError } from "../../src/session/codex-rpc";
import { piFrames } from "../snap/pi-wire";

describe("classifyNetworkFailure", () => {
  it("does not classify Pi's recorded HTTP 503 terminal error as confirmed transport", () => {
    const end = piFrames("messages/retry-failed").find(
      (frame) => frame.type === "auto_retry_end" && frame.success === false,
    );
    expect(end?.finalError).toBe("503 final failure");
    expect(classifyNetworkFailure({ backend: "pi", errorMessage: String(end?.finalError) })).toBe(
      "not-transient",
    );
  });

  it.each([
    "read ECONNRESET",
    "OAuth token refresh failed: request to https://auth.example.test/token failed, reason: getaddrinfo ENOTFOUND auth.example.test",
    "OAuth authentication failed: Post /token: net/http: TLS handshake timeout",
    "Request failed: cause: socket hang up",
    "Request failed: Client network socket disconnected before secure TLS connection was established",
    "upstream error: response stream disconnected before completion",
    'TypeError: fetch failed {"cause":{"code":"UND_ERR_SOCKET"}}',
    "[Codex error] failed to send /token (EAI_AGAIN)",
  ])("accepts explicit wrapped transport evidence: %s", (errorMessage) => {
    expect(isTransientTransportFailure(errorMessage)).toBe(true);
    expect(classifyNetworkFailure({ backend: "pi", errorMessage })).toBe("transient");
    expect(classifyNetworkFailure({ backend: "codex", errorMessage })).toBe("transient");
  });

  it.each([
    undefined,
    "fetch failed",
    "HTTP/2 502 Bad Gateway",
    "503 Service Unavailable",
    "HTTP 504 Gateway Timeout",
    "OAuth /token failed",
    "TLS handshake failed: certificate verification failed",
    "OAuth /token: 403: stream disconnected",
    "OAuth /token: invalid_credentials: socket hang up",
    "OAuth /token: invalid_grant: socket hang up",
    "5040 is not a status code",
    "The user's example included ECONNRESET",
    "429 Too Many Requests",
    "HTTP 401 Unauthorized",
    "503 provider error: invalid API key",
    "502 insufficient_quota",
    "read ECONNRESET: 402 Payment Required",
  ])("fails closed for unconfirmed Pi transport evidence: %s", (errorMessage) => {
    expect(classifyNetworkFailure({ backend: "pi", errorMessage })).toBe("not-transient");
  });

  it.each(["usage-limit", "interrupt", "bad-model"])(
    "does not retry Codex's recorded terminal error from %s",
    (fixture) => {
      type Frame = { method?: string; params?: { turn?: { status: string; error?: TurnError } } };
      const failed = readFileSync(join(__dirname, "../snap/codex", `${fixture}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { frame?: Frame }).frame)
        .find(
          (frame) => frame?.method === "turn/completed" && frame.params?.turn?.status === "failed",
        );
      const info = failed?.params?.turn?.error?.codexErrorInfo;
      expect(info).toBeTruthy();
      expect(classifyNetworkFailure({ backend: "codex", codexErrorInfo: info })).toBe(
        "not-transient",
      );
    },
  );

  it.each([
    { httpConnectionFailed: { httpStatusCode: null } },
    { responseStreamConnectionFailed: { httpStatusCode: 502 } },
    { responseStreamDisconnected: { httpStatusCode: null } },
    { responseStreamDisconnected: { httpStatusCode: 200 } },
  ])("accepts structured Codex transport evidence: %j", (codexErrorInfo) => {
    expect(classifyNetworkFailure({ backend: "codex", codexErrorInfo })).toBe("transient");
  });

  it.each([
    undefined,
    "unauthorized",
    "serverOverloaded",
    "httpConnectionFailed",
    { httpConnectionFailed: { httpStatusCode: 401 } },
    { responseStreamDisconnected: { httpStatusCode: 429 } },
    { responseStreamDisconnected: {} },
    { responseStreamDisconnected: { httpStatusCode: "503" } },
    { responseTooManyFailedAttempts: { httpStatusCode: null } },
    { responseTooManyFailedAttempts: { httpStatusCode: 504 } },
    { futureError: { httpStatusCode: 503 } },
    { httpConnectionFailed: { httpStatusCode: null }, unauthorized: {} },
  ])("fails closed for unconfirmed Codex transport evidence: %j", (codexErrorInfo) => {
    expect(classifyNetworkFailure({ backend: "codex", codexErrorInfo })).toBe("not-transient");
  });

  it("does not fall back to text when Codex supplied unknown or denial evidence", () => {
    for (const codexErrorInfo of ["other", "unauthorized", "rateLimitExceeded"]) {
      expect(
        classifyNetworkFailure({
          backend: "codex",
          codexErrorInfo,
          errorMessage: "socket hang up",
        }),
      ).toBe("not-transient");
    }
    expect(
      classifyNetworkFailure({
        backend: "codex",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        errorMessage: "403 Forbidden: stream disconnected",
      }),
    ).toBe("not-transient");
  });
});

describe("classifyProbeDelivery", () => {
  it("accepts positive report proof despite a claimed write with a lost reply", () => {
    expect(
      classifyProbeDelivery({ result: { found: true, anchorMissing: false }, writeClaimed: true }),
    ).toBe("delivered");
  });

  it.each<ProbeDeliveryEvidence>([
    { writeClaimed: false },
    { writeClaimed: true, receipt: { disposition: "rejected" } },
  ])("requires explicit proof that the input was not delivered: %j", (evidence) => {
    expect(classifyProbeDelivery(evidence)).toBe("definitively-undelivered");
  });

  it.each<ProbeDeliveryEvidence>([
    {},
    { writeClaimed: true },
    { result: { found: false, anchorMissing: false } },
    { result: { found: false, anchorMissing: true } },
    { result: { found: true, anchorMissing: true } },
    { receipt: { disposition: "started" } },
    { receipt: { disposition: "handled" }, writeClaimed: false },
  ])("does not infer safe replay from ambiguous probe evidence: %j", (evidence) => {
    expect(classifyProbeDelivery(evidence)).toBe("ambiguous");
  });
});
