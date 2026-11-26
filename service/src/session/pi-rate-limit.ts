// Transport observations are not execution authority. Only the failed assistant
// message at agent_settled may promote one to a recoverable turn failure.
export interface PiTurnLimit {
  resetsAt: number; // Unix seconds, as on the existing rateLimit signal.
  refusalText?: string;
}

export function futureReset(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value * 1000 > Date.now() &&
    Number.isFinite(new Date(value * 1000).getTime())
    ? value
    : undefined;
}

export function headerReset(
  headers: Record<string, string | string[] | undefined>,
): number | undefined {
  const retry = headers["retry-after"];
  const delta = (s: unknown) =>
    typeof s === "string" && /^\d+(?:\.\d+)?$/.test(s)
      ? futureReset(Date.now() / 1000 + Number(s))
      : undefined;
  return (
    delta(retry) ??
    (typeof retry === "string" && /^[A-Z][a-z]{2}, /.test(retry)
      ? futureReset(Date.parse(retry) / 1000)
      : undefined) ??
    futureReset(Number(headers["anthropic-ratelimit-unified-reset"])) ??
    delta(headers["ratelimit-reset"])
  );
}

const object = (x: unknown): Record<string, unknown> =>
  x && typeof x === "object" ? (x as Record<string, unknown>) : {};
export const notRecoverable = (s: string) =>
  /\b(?:401|403|unauthenticated|unauthorized|forbidden|permission[ _-]denied|entitlement|billing|insufficient[ _-]quota|usage[ _-]not[ _-]included|invalid[ _-]api[ _-]key)\b/i.test(
    s,
  );

export class NativeLimitObservation {
  private reset?: number;
  private detail?: string;

  clear() {
    this.reset = this.detail = undefined;
  }

  response(status: number, headers: Record<string, string>) {
    this.clear();
    if (status === 429) this.reset = headerReset(headers);
  }

  stream(data: unknown) {
    const frame = object(data);
    if (frame.type !== "error" && frame.type !== "response.failed") {
      this.clear();
      return;
    }
    const err = object(
      frame.type === "response.failed" ? object(frame.response).error : (frame.error ?? frame),
    );
    if (
      !["usage_limit_reached", "rate_limit_exceeded", "rate_limit_error"].includes(
        String(err.code ?? err.type),
      )
    ) {
      this.clear();
      return;
    }
    this.reset = futureReset(err.resets_at) ?? this.reset;
    this.detail = typeof err.message === "string" ? err.message : String(err.code ?? err.type);
  }

  finish(error: unknown): number | undefined {
    if (typeof error !== "string" || notRecoverable(error)) return;
    if (
      !(this.detail && error.includes(this.detail)) &&
      !/\b(?:429|rate[ _-]limit(?:ed|_exceeded)?|usage limit|too many requests)\b/i.test(error)
    )
      return;
    return futureReset(this.reset);
  }
}

// agy can deliver its fixed notice as ordinary assistant text before the ACP
// provider converts the reply into an error. Do not discard a preamble, tool
// output, or arbitrary model text on account of the error that followed it.
export function refusalText(text: string, error: string, acp: boolean): string | undefined {
  return text &&
    (text === error ||
      (acp &&
        /^Usage Limit Reached\n\nYou have reached your current quota for this period\.(?: Your limit will reset (?:in (?:\d+ (?:day|hour|minute|second)s?(?:, )?)+|on [A-Z][a-z]{2} \d{1,2}, \d{4} \d{2}:\d{2} UTC)\.)?$/.test(
          text.trim(),
        )))
    ? text
    : undefined;
}
