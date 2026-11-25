import type { UsageOverview as OverviewData, UsagePrice } from "../../../shared/usage";

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

const shortDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const DAY = 86_400_000;
const modelLimit = 6;

function DailyTokens({ trend }: Pick<OverviewData, "trend">) {
  const days = trend.slice(-90);
  const peak = Math.max(0, ...days.map(totalTokens));
  const start = days.length ? Date.parse(days[0].day) : 0;
  const end = days.length ? Date.parse(days[days.length - 1].day) : 0;
  const span = Math.max(1, (end - start) / DAY + 1);
  const slot = 100 / span;
  const bar = Math.min(slot * 0.82, 12);
  return (
    <figure className="usage-card usage-chart">
      <figcaption>
        <h3>Daily token composition</h3>
        <span>Tokens by UTC day</span>
      </figcaption>
      <ul className="usage-legend" aria-label="Daily token categories">
        {tokenParts.map(([key, label]) => (
          <li key={key}>
            <i className={`usage-fill-${key}`} />
            {label}
          </li>
        ))}
      </ul>
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
            aria-label="Daily token composition chart"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {[0, 50, 100].map((y) => (
              <line key={y} x1="0" x2="100" y1={y} y2={y} vectorEffect="non-scaling-stroke" />
            ))}
            {days.map((day) => {
              let y = 100;
              const x = ((Date.parse(day.day) - start) / DAY) * slot + (slot - bar) / 2;
              return (
                <g key={day.day}>
                  <title>{`${day.day} UTC · ${tokenParts.map(([key, label]) => `${label}: ${count.format(day[key])}`).join(" · ")}`}</title>
                  {tokenParts.map(([key]) => {
                    const height = (day[key] / (peak || 1)) * 100;
                    y -= height;
                    return (
                      <rect
                        key={key}
                        className={`usage-fill-${key}`}
                        x={x}
                        y={y}
                        width={bar}
                        height={height}
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>
          {peak === 0 && <span className="usage-chart-empty">No dated tokens</span>}
        </div>
        {!!days.length && (
          <div className="usage-dates">
            <span>{shortDate.format(start)}</span>
            {span > 1 && <span>{shortDate.format(end)}</span>}
          </div>
        )}
      </div>
    </figure>
  );
}

function RankedModels({ ranking }: Pick<OverviewData, "ranking">) {
  const models = ranking.slice(0, modelLimit);
  const peak = Math.max(1, ...models.map(({ tokens }) => tokens));
  return (
    <figure className="usage-card usage-chart">
      <figcaption>
        <h3>Top models</h3>
        <span>Ranked by total tokens</span>
      </figcaption>
      <div className="usage-ranking">
        <ol aria-label="Ranked model totals">
          {models.map(({ model, tokens }) => (
            <li key={JSON.stringify(model)}>
              <span title={model ?? "Unknown model"}>{model ?? "Unknown model"}</span>
              <strong title={`${count.format(tokens)} tokens`}>{compact.format(tokens)}</strong>
            </li>
          ))}
        </ol>
        <svg
          role="img"
          aria-label="Ranked model tokens chart"
          viewBox={`0 0 100 ${modelLimit * 10}`}
          preserveAspectRatio="none"
        >
          {models.map(({ model, tokens }, index) => (
            <rect
              key={JSON.stringify(model)}
              className="usage-fill-input"
              x="0"
              y={index * 10 + 7}
              width={(tokens / peak) * 100}
              height="1.5"
            >
              <title>{`${model ?? "Unknown model"}: ${count.format(tokens)} tokens`}</title>
            </rect>
          ))}
        </svg>
        {!models.length && <span className="usage-chart-empty">No models to rank</span>}
      </div>
    </figure>
  );
}

export function UsageOverview({
  data,
  incompleteSources,
  sourcesPending,
}: {
  data: OverviewData;
  incompleteSources: number;
  sourcesPending?: boolean;
}) {
  const prompt = data.input + data.cacheRead + data.cacheWrite;
  return (
    <section className="usage-overview" aria-label="Overview">
      {!data.count && (
        <p className="usage-notice" role="status">
          No usage observations returned.
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
            {count.format(data.promptBearing)} of {count.format(data.count)} observations with
            prompt tokens
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
          <h3>Data coverage</h3>
          <strong>{count.format(data.count)}</strong>
          <p>Observations · {count.format(data.unpriced)} unpriced</p>
          {sourcesPending && (
            <p className="usage-warning" role="status">
              Source scan pending
            </p>
          )}
          {incompleteSources > 0 && (
            <p className="usage-warning">
              Unavailable or partially decoded usage sources: {count.format(incompleteSources)}
            </p>
          )}
          {!sourcesPending && incompleteSources === 0 && <p>No incomplete sources reported</p>}
        </div>
      </div>
      <div className="usage-charts">
        <DailyTokens trend={data.trend} />
        <RankedModels ranking={data.ranking} />
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
        <p>
          Inferences with ≥96% cache reads: {share(data.at96, data.eligible)} ·{" "}
          {count.format(data.at96)} of {count.format(data.eligible)} eligible. Only inferences with
          prompt tokens are eligible. The 99% benchmark is for reference only.
        </p>
        <p>
          Price bases are not added together. API-equivalent costs are not account charges. A dash
          means no priced observations for that basis.
        </p>
      </details>
    </section>
  );
}
