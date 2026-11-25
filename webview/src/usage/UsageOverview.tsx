import { useId } from "react";
import type {
  UsageObservation,
  UsageOverview as OverviewData,
  UsagePrice,
} from "../../../shared/usage";
import "./UsageOverview.css";

export const count = new Intl.NumberFormat("en");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export const usd = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 10,
});
const percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 2 });
export const share = (numerator: number, denominator: number) =>
  denominator > 0 ? percent.format(numerator / denominator) : "Not available";

export const tokenParts = [
  ["input", "Uncached input"],
  ["cacheRead", "Cache read"],
  ["cacheWrite", "Cache write"],
  ["output", "Output"],
] as const;
const priceBases = ["reported", "channel-estimate", "api-equivalent"] as const;
export const priceLabel: Record<UsagePrice["kind"], string> = {
  reported: "Reported",
  "channel-estimate": "Channel estimate",
  "api-equivalent": "API-equivalent",
  unpriced: "Unpriced",
};
const totalTokens = (row: Pick<OverviewData, (typeof tokenParts)[number][0]>) =>
  row.input + row.cacheRead + row.cacheWrite + row.output;

const shortDate = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const shortHour = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_HOURLY_BUCKETS = 169;
const modelLimit = 6;
const modelName = (model: string | null) => model || "Unknown model";
const recordUnit = {
  inference: "Inference",
  turn: "Turn",
  session: "Session",
} satisfies Record<UsageObservation["unit"], string>;

type TrendRow = OverviewData["trend"][number];
type TrendWindow = { since: number; until: number; granularity: "day" | "hour" };
type Series = { label: string; fill: string; tokens: (row: TrendRow) => number };

const tokenSeries: Series[] = tokenParts.map(([key, label]) => ({
  label,
  fill: `usage-fill-${key}`,
  tokens: (row) => row[key],
}));

function modelSeries(rows: TrendRow[]): Series[] {
  const totals = new Map<string | null, number>();
  for (const row of rows) {
    for (const { model, tokens } of row.models) {
      if (tokens > 0) totals.set(model, (totals.get(model) ?? 0) + tokens);
    }
  }
  return [
    ...Array.from(totals)
      .sort((a, b) => b[1] - a[1] || modelName(a[0]).localeCompare(modelName(b[0])))
      .map<Series>(([model], index) => ({
        label: modelName(model),
        fill: `usage-overview-family-${index % modelLimit}`,
        tokens: (row) => row.models.find((entry) => entry.model === model)?.tokens ?? 0,
      })),
    ...(rows.some((row) => row.other > 0)
      ? [{ label: "Other", fill: "usage-overview-other", tokens: (row: TrendRow) => row.other }]
      : []),
  ];
}

export type TrendMode = "types" | "models";
type TrendControl = { mode: TrendMode; setMode: (mode: TrendMode) => void };
function TokenTrend({
  trend,
  since,
  until,
  granularity,
  mode,
  setMode,
}: TrendWindow & TrendControl & { trend: TrendRow[] }) {
  const description = useId();
  const step = granularity === "hour" ? HOUR : DAY;
  const first = Math.floor(since / step) * step;
  const bucketCount = Math.ceil((until - first) / step);
  const valid = until > since && (granularity !== "hour" || bucketCount <= MAX_HOURLY_BUCKETS);
  const rows = new Map(trend.map((row) => [Date.parse(row.day), row]));
  const buckets = Array.from({ length: valid ? bucketCount : 0 }, (_, index) => {
    const start = first + index * step;
    return { start, row: rows.get(start) };
  });
  const series =
    mode === "types" ? tokenSeries : modelSeries(buckets.flatMap(({ row }) => (row ? [row] : [])));
  const peak = Math.max(0, ...buckets.map(({ row }) => (row ? totalTokens(row) : 0)));
  const axisFormat = granularity === "hour" ? shortHour : shortDate;
  const chartLabel = `${mode === "types" ? "Token types" : "Top model families"} by UTC ${granularity}`;
  const position = (time: number) => ((time - since) / (until - since)) * 100;
  return (
    <figure className="usage-card usage-chart">
      <figcaption className="usage-overview-caption">
        <div>
          <h3>Token usage over time</h3>
          <span>Tokens by UTC {granularity}</span>
        </div>
        <div className="usage-overview-modes" role="group" aria-label="Chart breakdown">
          <button
            type="button"
            className="btn-secondary"
            aria-pressed={mode === "types"}
            onClick={() => setMode("types")}
          >
            Token types
          </button>
          <button
            type="button"
            className="btn-secondary"
            aria-pressed={mode === "models"}
            onClick={() => setMode("models")}
          >
            Top models
          </button>
        </div>
      </figcaption>
      {series.length > 0 && (
        <ul className="usage-legend" role="list" aria-label={`${chartLabel} legend`}>
          {series.map(({ label, fill }, index) => (
            <li key={index}>
              <i className={fill} aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>
      )}
      {valid ? (
        <div className="usage-trend">
          <div className="usage-axis" aria-hidden="true">
            {peak > 0 && (
              <>
                <span>{compact.format(peak)}</span>
                <span>0</span>
              </>
            )}
          </div>
          <div className="usage-plot">
            <svg
              role="img"
              aria-label={chartLabel}
              aria-describedby={description}
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
            >
              <desc id={description}>
                {`${new Date(since).toISOString()} to ${new Date(until).toISOString()} (end exclusive). ${bucketCount} UTC ${granularity} buckets. ${peak > 0 ? `Peak ${count.format(peak)} tokens.` : "No dated tokens returned."}`}
              </desc>
              {[0, 50, 100].map((y) => (
                <line key={y} x1="0" x2="100" y1={y} y2={y} vectorEffect="non-scaling-stroke" />
              ))}
              {buckets.map(({ start, row }) => {
                if (!row || !totalTokens(row)) return null;
                const left = position(Math.max(since, start));
                const width = position(Math.min(until, start + step)) - left;
                const bar = Math.min(width * 0.82, 12);
                const x = left + (width - bar) / 2;
                const parts = series.map((part) => ({ ...part, value: part.tokens(row) }));
                let stacked = 0;
                return (
                  <g key={start}>
                    <title>{`${row.day} UTC · ${parts.map(({ label, value }) => `${label}: ${count.format(value)}`).join(" · ")}`}</title>
                    <rect
                      className="usage-overview-bucket-hit"
                      x={left}
                      y="0"
                      width={width}
                      height="100"
                    />
                    {parts.map(({ fill, value }, index) => {
                      if (!value) return null;
                      stacked += value;
                      return (
                        <rect
                          key={index}
                          className={fill}
                          x={x}
                          y={(1 - stacked / peak) * 100}
                          width={bar}
                          height={(value / peak) * 100}
                        />
                      );
                    })}
                  </g>
                );
              })}
            </svg>
            {peak === 0 && <span className="usage-chart-empty">No dated tokens returned</span>}
          </div>
          <div className="usage-dates">
            <time dateTime={new Date(since).toISOString()}>{axisFormat.format(since)}</time>
            {axisFormat.format(since) !== axisFormat.format(until) && (
              <time dateTime={new Date(until).toISOString()}>{axisFormat.format(until)}</time>
            )}
          </div>
        </div>
      ) : (
        <p>Cannot chart this UTC window at the selected granularity.</p>
      )}
    </figure>
  );
}

function RankedModels({
  ranking,
  model,
  onModelChange,
}: Pick<OverviewData, "ranking"> & {
  model: string;
  onModelChange: (model: string) => void;
}) {
  const models = ranking.slice(0, modelLimit);
  const peak = Math.max(1, ...models.map(({ tokens }) => tokens));
  return (
    <figure className="usage-card usage-chart">
      <figcaption>
        <h3>Top models</h3>
        <span>Ranked by total tokens</span>
      </figcaption>
      {models.length > 0 ? (
        <div className="usage-overview-ranks">
          <svg
            role="img"
            aria-label="Ranked model tokens chart"
            viewBox={`0 0 100 ${models.length * 32}`}
            preserveAspectRatio="none"
          >
            {models.map(({ model: name, tokens }, i) => (
              <rect
                key={JSON.stringify(name)}
                x={0}
                y={i * 32 + 27}
                width={(100 * tokens) / peak}
                height={3}
              />
            ))}
          </svg>
          <ol className="usage-overview-ranking" role="list" aria-label="Ranked model totals">
            {models.map(({ model: name, tokens }) => {
              const contents = (
                <>
                  <span className="usage-overview-rank-label">
                    <span title={modelName(name)}>{modelName(name)}</span>
                    <strong title={`${count.format(tokens)} tokens`}>
                      {compact.format(tokens)}
                    </strong>
                  </span>
                </>
              );
              return (
                <li key={JSON.stringify(name)}>
                  {name !== null && name !== "" ? (
                    <button
                      type="button"
                      aria-label={`${name}, ${count.format(tokens)} tokens`}
                      aria-pressed={model === name}
                      onClick={() => onModelChange(model === name ? "" : name)}
                    >
                      {contents}
                    </button>
                  ) : (
                    <div className="usage-overview-rank-static">{contents}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <p>No model totals returned</p>
      )}
    </figure>
  );
}

export function UsageOverview({
  data,
  incompleteSources,
  sourcesPending,
  since,
  until,
  granularity,
  unit,
  model,
  onModelChange,
  mode,
  setMode,
}: TrendWindow &
  TrendControl & {
    data: OverviewData;
    incompleteSources: number;
    sourcesPending?: boolean;
    unit: UsageObservation["unit"];
    model: string;
    onModelChange: (model: string) => void;
  }) {
  const prompt = data.input + data.cacheRead + data.cacheWrite;
  return (
    <section className="usage-overview" aria-label="Overview">
      {!data.count && (
        <p className="usage-notice" role="status">
          No usage records returned.
        </p>
      )}
      <div className="usage-kpis">
        <div className="usage-card">
          <h3>Total tokens</h3>
          <strong title={count.format(totalTokens(data))}>
            {compact.format(totalTokens(data))}
          </strong>
          <p>
            {compact.format(prompt)} prompt · {compact.format(data.output)} output
          </p>
        </div>
        <div className="usage-card">
          <h3>Weighted cache read share</h3>
          <strong>{share(data.cacheRead, prompt)}</strong>
          <p>
            {count.format(data.promptBearing)} of {count.format(data.count)} records with prompt
            tokens
          </p>
        </div>
        <div className="usage-card usage-prices">
          <h3>
            Cost by basis <small>USD</small>
          </h3>
          <dl>
            {priceBases.map((kind) => (
              <div key={kind}>
                <dt>{priceLabel[kind]}</dt>
                <dd>{data.costs[kind] === null ? "—" : usd.format(data.costs[kind])}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="usage-card">
          <h3>Usage records</h3>
          <strong>{count.format(data.count)}</strong>
          <p>{recordUnit[unit]} records</p>
          <p>
            {count.format(data.count - data.unpriced)} priced · {count.format(data.unpriced)}{" "}
            unpriced
          </p>
          {sourcesPending && (
            <p className="usage-warning" role="status">
              Source scan pending
            </p>
          )}
          {incompleteSources > 0 && (
            <p className="usage-warning">
              {count.format(incompleteSources)} {incompleteSources === 1 ? "source" : "sources"}{" "}
              unavailable or partially read
            </p>
          )}
          {!sourcesPending && incompleteSources === 0 && <p>No source issues reported</p>}
        </div>
      </div>
      <div className="usage-charts">
        <TokenTrend
          mode={mode}
          setMode={setMode}
          trend={data.trend}
          since={since}
          until={until}
          granularity={granularity}
        />
        <RankedModels ranking={data.ranking} model={model} onModelChange={onModelChange} />
      </div>
      <details className="usage-method">
        <summary tabIndex={0}>Measurement details and benchmarks</summary>
        <dl>
          {tokenParts.map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{count.format(data[key])}</dd>
            </div>
          ))}
        </dl>
        <p>
          Weighted cache read share: {count.format(data.cacheRead)} cache-read /{" "}
          {count.format(prompt)} prompt tokens (uncached input, cache reads and cache writes). The
          98% benchmark is for reference only.
        </p>
        {unit === "inference" && (
          <p>
            Inferences with ≥96% cache reads: {share(data.at96, data.eligible)} ·{" "}
            {count.format(data.at96)} of {count.format(data.eligible)} eligible. Only inferences
            with prompt tokens are eligible. The 99% benchmark is for reference only.
          </p>
        )}
        <p>
          Price bases are not added together. API-equivalent costs are not account charges. A dash
          means no priced records for that basis.
        </p>
      </details>
    </section>
  );
}
