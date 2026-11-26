import { useId } from "react";
import type { UsageObservation, UsageOverview as OverviewData } from "../../../shared/usage";
import { tUsage, useUsageT } from "../i18n/usage";
import { tokenParts, useUsageFormat } from "./format";
import "./UsageOverview.css";

const priceBases = ["reported", "channel-estimate", "api-equivalent"] as const;
const totalTokens = (row: Pick<OverviewData, (typeof tokenParts)[number]>) =>
  row.input + row.cacheRead + row.cacheWrite + row.output;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_HOURLY_BUCKETS = 169;
const modelLimit = 6;

type TrendRow = OverviewData["trend"][number];
type TrendWindow = { since: number; until: number; granularity: "day" | "hour" };
type Series = { label: string; fill: string; tokens: (row: TrendRow) => number };

function modelSeries(rows: TrendRow[], tr: ReturnType<typeof useUsageT>): Series[] {
  const totals = new Map<string | null, number>();
  for (const row of rows) {
    for (const { model, tokens } of row.models) {
      if (tokens > 0) totals.set(model, (totals.get(model) ?? 0) + tokens);
    }
  }
  // A display-language change must not reorder tied models or change their colours.
  const sortName = (model: string | null) => model || tUsage("unknownModel", undefined, "en");
  return [
    ...Array.from(totals)
      .sort((a, b) => b[1] - a[1] || sortName(a[0]).localeCompare(sortName(b[0])))
      .map<Series>(([model], index) => ({
        label: model || tr("unknownModel"),
        fill: `usage-overview-family-${index % modelLimit}`,
        tokens: (row) => row.models.find((entry) => entry.model === model)?.tokens ?? 0,
      })),
    ...(rows.some((row) => row.other > 0)
      ? [{ label: tr("other"), fill: "usage-overview-other", tokens: (row: TrendRow) => row.other }]
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
  const tr = useUsageT();
  const { compact, count, shortDay, shortHour } = useUsageFormat();
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
  const series: Series[] =
    mode === "types"
      ? tokenParts.map((key) => ({
          label: tr(key),
          fill: `usage-fill-${key}`,
          tokens: (row) => row[key],
        }))
      : modelSeries(
          buckets.flatMap(({ row }) => (row ? [row] : [])),
          tr,
        );
  const peak = Math.max(0, ...buckets.map(({ row }) => (row ? totalTokens(row) : 0)));
  const axisFormat = granularity === "hour" ? shortHour : shortDay;
  const granularityLabel = tr(granularity === "hour" ? "chartHour" : "chartDay");
  const chartLabel = tr("chartLabel", {
    series: tr(mode === "types" ? "tokenTypes" : "topModelFamilies"),
    granularity: granularityLabel,
  });
  const position = (time: number) => ((time - since) / (until - since)) * 100;
  return (
    <figure className="usage-card usage-chart">
      <figcaption className="usage-overview-caption">
        <div>
          <h3>{tr("tokenTrend")}</h3>
          <span>{tr("trendGranularity", { granularity: granularityLabel })}</span>
        </div>
        <div
          className="bp-views usage-overview-modes"
          role="group"
          aria-label={tr("chartBreakdown")}
        >
          <button type="button" aria-pressed={mode === "types"} onClick={() => setMode("types")}>
            {tr("tokenTypes")}
          </button>
          <button type="button" aria-pressed={mode === "models"} onClick={() => setMode("models")}>
            {tr("topModels")}
          </button>
        </div>
      </figcaption>
      {series.length > 0 && (
        <ul className="usage-legend" role="list" aria-label={tr("legend", { chart: chartLabel })}>
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
                {tr("chartDescription", {
                  since: new Date(since).toISOString(),
                  until: new Date(until).toISOString(),
                  count: count.format(bucketCount),
                  granularity: granularityLabel,
                  detail:
                    peak > 0 ? tr("chartPeak", { count: count.format(peak) }) : tr("chartNoPeak"),
                })}
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
                    <title>{`${row.day} UTC · ${parts.map(({ label, value }) => tr("labeledValue", { field: label, value: count.format(value) })).join(" · ")}`}</title>
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
            {peak === 0 && <span className="usage-chart-empty">{tr("chartEmpty")}</span>}
          </div>
          <div className="usage-dates">
            <time dateTime={new Date(since).toISOString()}>{axisFormat.format(since)}</time>
            {axisFormat.format(since) !== axisFormat.format(until) && (
              <time dateTime={new Date(until).toISOString()}>{axisFormat.format(until)}</time>
            )}
          </div>
        </div>
      ) : (
        <p>{tr("chartInvalid")}</p>
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
  const tr = useUsageT();
  const { compact, count } = useUsageFormat();
  const models = ranking.slice(0, modelLimit);
  const peak = Math.max(1, ...models.map(({ tokens }) => tokens));
  return (
    <figure className="usage-card usage-chart">
      <figcaption>
        <h3>{tr("topModels")}</h3>
        <span>{tr("rankedByTokens")}</span>
      </figcaption>
      {models.length > 0 ? (
        <div className="usage-overview-ranks">
          <svg
            role="img"
            aria-label={tr("rankedChart")}
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
          <ol className="usage-overview-ranking" role="list" aria-label={tr("rankedTotals")}>
            {models.map(({ model: name, tokens }) => {
              const label = name || tr("unknownModel");
              const formattedCount = count.format(tokens);
              const contents = (
                <span className="usage-overview-rank-label">
                  <span title={label}>{label}</span>
                  <strong title={tr("tokens", { count: formattedCount })}>
                    {compact.format(tokens)}
                  </strong>
                </span>
              );
              return (
                <li key={JSON.stringify(name)}>
                  {name !== null && name !== "" ? (
                    <button
                      type="button"
                      aria-label={tr("modelTokens", { model: name, count: formattedCount })}
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
        <p>{tr("noModelTotals")}</p>
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
  const tr = useUsageT();
  const { compact, count, usd, share, incomplete } = useUsageFormat();
  const prompt = data.input + data.cacheRead + data.cacheWrite;
  return (
    <section className="usage-overview" aria-label={tr("overview")}>
      {!data.count && (
        <p className="usage-notice" role="status">
          {tr("noUsageRecords")}
        </p>
      )}
      <div className="usage-kpis">
        <div className="usage-card">
          <h3>{tr("totalTokens")}</h3>
          <strong title={count.format(totalTokens(data))}>
            {compact.format(totalTokens(data))}
          </strong>
          <p>
            {tr("promptOutput", {
              prompt: compact.format(prompt),
              output: compact.format(data.output),
            })}
          </p>
        </div>
        <div className="usage-card">
          <h3>{tr("weightedShare")}</h3>
          <strong>{share(data.cacheRead, prompt)}</strong>
          <p>
            {tr("promptRecords", {
              withPrompt: count.format(data.promptBearing),
              total: count.format(data.count),
            })}
          </p>
        </div>
        <div className="usage-card usage-prices">
          <h3>
            {tr("costByBasis")} <small>USD</small>
          </h3>
          <dl>
            {priceBases.map((kind) => (
              <div key={kind}>
                <dt>{tr(kind)}</dt>
                <dd>{data.costs[kind] === null ? "—" : usd.format(data.costs[kind])}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="usage-card">
          <h3>{tr("usageRecords")}</h3>
          <strong>{count.format(data.count)}</strong>
          <p>{tr("recordsByUnit", { unit: tr(unit) })}</p>
          <p>
            {tr("pricedRecords", {
              priced: count.format(data.count - data.unpriced),
              unpriced: count.format(data.unpriced),
            })}
          </p>
          {sourcesPending && (
            <p className="usage-warning" role="status">
              {tr("scanPending")}
            </p>
          )}
          {incompleteSources > 0 && (
            <p className="usage-warning">{incomplete(incompleteSources)}</p>
          )}
          {!sourcesPending && incompleteSources === 0 && <p>{tr("noSourceIssues")}</p>}
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
        <summary tabIndex={0}>{tr("measurement")}</summary>
        <dl>
          {tokenParts.map((key) => (
            <div key={key}>
              <dt>{tr(key)}</dt>
              <dd>{count.format(data[key])}</dd>
            </div>
          ))}
        </dl>
        <p>
          {tr("weightedShareDetail", {
            read: count.format(data.cacheRead),
            prompt: count.format(prompt),
          })}
        </p>
        {unit === "inference" && (
          <p>
            {tr("inferenceDetail", {
              share: share(data.at96, data.eligible),
              at96: count.format(data.at96),
              eligible: count.format(data.eligible),
            })}
          </p>
        )}
        <p>{tr("pricingDetail")}</p>
      </details>
    </section>
  );
}
