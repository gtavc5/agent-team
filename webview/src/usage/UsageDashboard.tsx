import { Fragment, useEffect, useState } from "react";
import type { JourneyEvent, UsageObservation } from "../../../shared/usage";
import { DialogFrame } from "../workspace/DialogFrame";

const sourceLabel: Record<UsageObservation["source"], string> = {
  acp: "ACP",
  pi: "Pi",
  codex: "Codex",
};
const priceLabel: Record<UsageObservation["price"]["kind"], string> = {
  "api-equivalent": "API-equivalent",
  "channel-estimate": "Channel estimate",
  reported: "Reported",
  unpriced: "Unpriced",
};
const percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 2 });
const count = new Intl.NumberFormat("en");
const usd = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 10,
});
const promptTokens = ({ input, cacheRead, cacheWrite }: UsageObservation) =>
  input + cacheRead + cacheWrite;

function share(numerator: number, denominator: number) {
  return denominator > 0 ? percent.format(numerator / denominator) : "Not available";
}

const pricedKinds = ["api-equivalent", "channel-estimate", "reported"] as const;

function Overview({ observations }: { observations: UsageObservation[] }) {
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  const priceTotals: Partial<Record<(typeof pricedKinds)[number], number>> = {};
  let unpriced = 0;
  let inferences = 0;
  let eligible = 0;
  let at96 = 0;
  for (const observation of observations) {
    input += observation.input;
    cacheRead += observation.cacheRead;
    cacheWrite += observation.cacheWrite;
    output += observation.output;
    const { kind, usd: amount } = observation.price;
    if (kind === "unpriced" || amount === null) unpriced++;
    else priceTotals[kind] = (priceTotals[kind] ?? 0) + amount;
    if (observation.unit !== "inference") continue;
    inferences++;
    const total = promptTokens(observation);
    if (total <= 0) continue;
    eligible++;
    if (observation.cacheRead * 100 >= 96 * total) at96++;
  }

  const prompt = input + cacheRead + cacheWrite;
  return (
    <section aria-label="Overview">
      <h3>Weighted cache read share</h3>
      <p>
        <strong>{share(cacheRead, prompt)}</strong> · {count.format(cacheRead)} cache-read /{" "}
        {count.format(prompt)} prompt tokens
      </p>
      <p>
        Prompt tokens include uncached input, cache reads and cache writes. This ratio uses the
        token totals in the returned observations, which can mix inference, turn and session units.
      </p>
      <p>Weighted cache read share reference: 98% (reference only).</p>
      <h3>Inferences with at least 96% cache reads</h3>
      <p>
        <strong>{share(at96, eligible)}</strong> · {count.format(at96)} of {count.format(eligible)}{" "}
        eligible inference observations
      </p>
      <p>
        Sample size: {count.format(eligible)}. Coverage among returned observations:{" "}
        {share(eligible, observations.length)} ({count.format(eligible)} of{" "}
        {count.format(observations.length)}). {count.format(inferences)} returned observations are
        inference-level; only those with prompt tokens are eligible. Unobserved inferences are not
        counted.
      </p>
      <p>Share of eligible inferences with at least 96% cache reads: 99% reference only.</p>
      <h3>Token totals</h3>
      <p>All returned observations, including unpriced observations.</p>
      <dl className="usage-details">
        <dt>Uncached input</dt>
        <dd>{count.format(input)}</dd>
        <dt>Cache read</dt>
        <dd>{count.format(cacheRead)}</dd>
        <dt>Cache write</dt>
        <dd>{count.format(cacheWrite)}</dd>
        <dt>Output</dt>
        <dd>{count.format(output)}</dd>
        <dt>Total tokens</dt>
        <dd>{count.format(prompt + output)}</dd>
      </dl>
      <h3>Price totals by kind</h3>
      <dl className="usage-details">
        {pricedKinds.map((kind) => {
          const amount = priceTotals[kind];
          return (
            <Fragment key={kind}>
              <dt>{priceLabel[kind]}</dt>
              <dd>
                {amount === undefined ? "No priced observations" : `${usd.format(amount)} USD`}
              </dd>
            </Fragment>
          );
        })}
        <dt>Unpriced observations</dt>
        <dd>{count.format(unpriced)}</dd>
      </dl>
    </section>
  );
}

type UsageResponse = {
  observations: UsageObservation[];
  events: JourneyEvent[];
  incompleteSources?: number;
};

type JourneyScope = Pick<JourneyEvent, "source" | "sessionId" | "turnId">;
const sessionKey = ({ source, sessionId }: JourneyScope) => JSON.stringify([source, sessionId]);

function JourneyIdentity({ id, sessionId, turnId }: JourneyScope & { id: string }) {
  return (
    <>
      <dt>ID</dt>
      <dd>{id}</dd>
      <dt>Session</dt>
      <dd>{sessionId}</dd>
      {turnId !== undefined && (
        <>
          <dt>Turn</dt>
          <dd>{turnId}</dd>
        </>
      )}
    </>
  );
}

function ObservationDetails({ observation }: { observation: UsageObservation }) {
  const { channel, price, toolCalls, cacheRead } = observation;
  const prompt = promptTokens(observation);
  return (
    <>
      <dt>Channel</dt>
      <dd>{channel || "Unknown"}</dd>
      <dt>Model</dt>
      <dd>{observation.model ?? "Unknown"}</dd>
      <dt>Tokens</dt>
      <dd>
        {count.format(observation.input)} uncached input · {count.format(observation.cacheRead)}{" "}
        cache read · {count.format(observation.cacheWrite)} cache write ·{" "}
        {count.format(observation.output)} output
      </dd>
      {observation.unit === "inference" && (
        <>
          <dt>Cache read share</dt>
          <dd>
            {share(cacheRead, prompt)} · {count.format(cacheRead)} cache-read /{" "}
            {count.format(prompt)} prompt tokens
          </dd>
        </>
      )}
      <dt>Price</dt>
      <dd>
        {priceLabel[price.kind]}
        {price.usd !== null && ` · ${usd.format(price.usd)} USD`}
        {price.asOf && ` · as of ${price.asOf}`}
      </dd>
      {!!toolCalls?.length && (
        <>
          <dt>Linked tools</dt>
          <dd>
            <ul>
              {toolCalls.map((tool) => (
                <li key={tool.id}>
                  {tool.name} ({tool.id})
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </>
  );
}

const JOURNEY_PAGE_SIZE = 50;

function Journey({
  observations,
  events,
  session,
  onSession,
}: UsageResponse & {
  session: string;
  onSession: (session: string) => void;
}) {
  const [page, setPage] = useState(0);
  const entries = [...observations, ...events];
  if (entries.length === 0) return <p role="status">No Journey records returned.</p>;
  const sessions = new Map(entries.map((entry) => [sessionKey(entry), entry]));
  const selected = sessions.has(session) ? session : "";
  const chronological = entries
    .filter((entry) => !selected || sessionKey(entry) === selected)
    .sort((a, b) => {
      if (a.timestamp === null) return b.timestamp === null ? 0 : 1;
      return b.timestamp === null ? -1 : a.timestamp - b.timestamp;
    });
  const start = page * JOURNEY_PAGE_SIZE;
  const end = Math.min(start + JOURNEY_PAGE_SIZE, chronological.length);

  return (
    <section aria-label="Journey">
      <p>
        Recorded observations and events, oldest first. Records without timestamps are listed last.
      </p>
      <label className="dialog-field">
        <span>Journey session</span>
        <select
          value={selected}
          onChange={(event) => {
            onSession(event.target.value);
            setPage(0);
          }}
        >
          <option value="">All sessions</option>
          {[...sessions].map(([key, { source, sessionId }]) => (
            <option key={key} value={key}>
              {sourceLabel[source]} · {sessionId}
            </option>
          ))}
        </select>
      </label>
      {chronological.length > JOURNEY_PAGE_SIZE && (
        <div className="usage-controls" role="group" aria-label="Journey pages">
          <button
            type="button"
            className="btn-secondary"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={end === chronological.length}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
          <span role="status">
            {count.format(start + 1)}–{count.format(end)} of {count.format(chronological.length)}
          </span>
        </div>
      )}
      <ol className="usage-journey" aria-label="Recorded observations and events" role="list">
        {chronological.slice(start, end).map((entry) => {
          const date = entry.timestamp === null ? null : new Date(entry.timestamp).toISOString();
          const isEvent = "kind" in entry;
          return (
            <li key={JSON.stringify([isEvent, entry.source, entry.sessionId, entry.id])}>
              <strong>
                {sourceLabel[entry.source]} · {isEvent ? entry.kind : entry.unit}
              </strong>
              {" · "}
              {date ? <time dateTime={date}>{date}</time> : "Timestamp unknown"}
              <dl className="usage-details">
                <JourneyIdentity {...entry} />
                {isEvent ? (
                  <>
                    <dt>Name</dt>
                    <dd>{entry.name}</dd>
                  </>
                ) : (
                  <ObservationDetails observation={entry} />
                )}
              </dl>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

type UsageLoad = { status: "loading" | "error" } | { status: "ready"; data: UsageResponse };

export function UsageDashboard({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<"Overview" | "Journey">("Overview");
  const [refresh, setRefresh] = useState(0);
  const [session, setSession] = useState("");
  const [load, setLoad] = useState<UsageLoad>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    async function fetchUsage() {
      try {
        const response = await fetch("api/usage", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Usage request failed");
        const data = (await response.json()) as UsageResponse;
        if (!Array.isArray(data.observations) || !Array.isArray(data.events)) {
          throw new Error("Usage records missing");
        }
        if (!controller.signal.aborted) setLoad({ status: "ready", data });
      } catch {
        if (!controller.signal.aborted) setLoad({ status: "error" });
      }
    }
    void fetchUsage();
    return () => controller.abort();
  }, [refresh]);

  const incompleteSources = load.status === "ready" ? (load.data.incompleteSources ?? 0) : 0;
  return (
    <DialogFrame title="Usage dashboard" className="usage-dialog" onClose={onClose}>
      <div className="usage-controls" role="group" aria-label="Usage views">
        {(["Overview", "Journey"] as const).map((name) => (
          <button
            key={name}
            type="button"
            className="btn-secondary"
            aria-pressed={view === name}
            onClick={() => setView(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="dialog-body">
        {load.status === "loading" && <p role="status">Loading usage…</p>}
        {load.status === "error" && <p role="status">Could not load usage.</p>}
        {load.status === "ready" && (
          <>
            {incompleteSources > 0 && (
              <p>
                Unavailable or partially decoded usage sources: {count.format(incompleteSources)}
              </p>
            )}
            {view === "Journey" ? (
              <Journey {...load.data} session={session} onSession={setSession} />
            ) : load.data.observations.length ? (
              <Overview observations={load.data.observations} />
            ) : (
              <p role="status">No usage observations returned.</p>
            )}
          </>
        )}
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setLoad({ status: "loading" });
            setRefresh((previous) => previous + 1);
          }}
        >
          Refresh
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </DialogFrame>
  );
}
