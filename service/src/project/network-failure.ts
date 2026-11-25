import type { CodexErrorInfo } from "../session/codex-rpc";
import type { DispatchedReportProbeResult, SendReceipt } from "../session/types";

// Pass terminal backend evidence, not a retry banner or transcript text.
export type NetworkFailureEvidence =
  | { backend: "pi"; errorMessage?: string | null }
  | { backend: "codex"; codexErrorInfo?: CodexErrorInfo | null; errorMessage?: string | null };

export type NetworkFailure = "transient" | "not-transient";

const gatewayErrors = new Set([502, 503, 504]);
const codexTransport = new Set([
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
]);

function codexTransportFailure(info: CodexErrorInfo | null | undefined): boolean {
  if (!info || typeof info !== "object") return false;
  const entries = Object.entries(info);
  if (entries.length !== 1) return false;
  const [[kind, detail]] = entries;
  if (!detail || typeof detail !== "object" || !("httpStatusCode" in detail)) return false;
  const status = detail.httpStatusCode;
  return (
    codexTransport.has(kind) &&
    (status === null ||
      (typeof status === "number" &&
        ((Number.isInteger(status) && status >= 200 && status < 300) || gatewayErrors.has(status))))
  );
}

function hasAuthOrQuotaFailure(text: string): boolean {
  // OAuth and token endpoints can themselves have transport failures. Reject
  // denial evidence, not the name of the operation that failed.
  if (
    /\b(?:certificate|self[- ]signed|unknown ca|cert_has_expired|err_tls_cert_altname_invalid)\b/i.test(
      text,
    )
  )
    return true;
  return /\b(?:401|402|403|407|429|unauthori[sz]ed|unauthenticated|forbidden|invalid[ -](?:grant|client)|quota|billing)\b|(?:invalid|expired|missing|incorrect|revoked)\s+(?:[\w-]+\s+){0,2}(?:credentials?|api[ -]?key|tokens?)\b|(?:credentials?|api[ -]?key|tokens?)\s+(?:(?:is|are|has)\s+)?(?:invalid|expired|missing|revoked)\b|(?:authentication|authorization)\s+(?:required|denied)\b|(?:usage|rate)[ -]?limit|too[ -]many[ -]requests|insufficient[ -]credits/i.test(
    text.replaceAll("_", " "),
  );
}

export function isTransientTransportFailure(text: string): boolean {
  if (hasAuthOrQuotaFailure(text)) return false;
  return (
    /(?:^|[:(=\["']\s*|\b(?:connect|read|write|getaddrinfo)\s+)(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)|ERR_STREAM_PREMATURE_CLOSE)\b/.test(
      text.trimStart(),
    ) ||
    /\b(?:TLS handshake (?:failed|failure|timed out|timeout|error)|socket (?:hang up|disconnected|closed unexpectedly|timed out)|(?:response )?stream (?:disconnected|closed prematurely|ended unexpectedly|reset)|connection (?:reset|refused|timed out|closed unexpectedly))\b/i.test(
      text,
    )
  );
}

export function classifyNetworkFailure(evidence: NetworkFailureEvidence): NetworkFailure {
  const message = evidence.errorMessage ?? "";
  const transient =
    evidence.backend === "codex" && evidence.codexErrorInfo != null
      ? !hasAuthOrQuotaFailure(message) && codexTransportFailure(evidence.codexErrorInfo)
      : isTransientTransportFailure(message);
  return transient ? "transient" : "not-transient";
}

export interface ProbeDeliveryEvidence {
  result?: Pick<DispatchedReportProbeResult, "found" | "anchorMissing"> | null;
  receipt?: Pick<SendReceipt, "disposition"> | null;
  // Only set false if the sender observed that the write was never attempted.
  writeClaimed?: boolean;
}

export type ProbeDelivery = "delivered" | "definitively-undelivered" | "ambiguous";

export function classifyProbeDelivery({
  result,
  receipt,
  writeClaimed,
}: ProbeDeliveryEvidence): ProbeDelivery {
  // All evidence must refer to the same attempt. Report presence beats an
  // earlier transport outcome; history absence is never proof of rejection.
  if (result?.found === true) return result.anchorMissing === false ? "delivered" : "ambiguous";
  if (receipt?.disposition === "rejected" || (!receipt && writeClaimed === false))
    return "definitively-undelivered";
  return "ambiguous";
}
