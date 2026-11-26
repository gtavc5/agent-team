import { Fragment, useEffect, useState } from "react";
import type {
  UsageGranularity,
  UsageJourney,
  UsageObservation,
  UsageOverview as OverviewData,
} from "../../../shared/usage";
import { DialogFrame } from "../workspace/DialogFrame";
import { Icon } from "../panels/Icon";
import {
  count,
  priceLabel,
  share,
  tokenParts,
  UsageOverview,
  type TrendMode,
  usd,
} from "./UsageOverview";

const sourceLabel: Record<UsageObservation["source"], string> = {
  acp: "ACP",
  pi: "Pi",
  codex: "Codex",
};
const rowLabel = {
  tool: "Tool",
  compaction: "Compaction",
  inference: "Inference",
  turn: "Turn",
  session: "Session",
};
type RecordFilter = "workspace" | "session" | "turn";

const localTime = (timeZone?: string) =>
  new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
    timeZoneName: "longOffset",
  });
const browserTime = localTime();
const utcTime = localTime("UTC");

export function formatRecordTime(date: Date, timeZone?: string) {
  const parts = (format: Intl.DateTimeFormat) =>
    Object.fromEntries(format.formatToParts(date).map(({ type, value }) => [type, value]));
  const u = parts(utcTime),
    l = parts(timeZone ? localTime(timeZone) : browserTime);
  const offset =
    l.timeZoneName
      .slice(3)
      .replace(/^([+-])0(\d)/, "$1$2")
      .replace(/:00$/, "") || "+0";
  const sameDate = u.year === l.year && u.month === l.month && u.day === l.day;
  return {
    utc: `${u.day} ${u.month} ${u.year}, ${u.hour}:${u.minute} UTC`,
    local: `${sameDate ? "" : `${l.day} ${l.month}${l.year === u.year ? "" : ` ${l.year}`}, `}${l.hour}:${l.minute} UTC${offset}`,
  };
}

function JourneyRow({
  row,
  onFilter,
}: {
  row: UsageJourney["rows"][number];
  onFilter: (field: RecordFilter, value: string) => void;
}) {
  const date = row.timestamp === null ? null : new Date(row.timestamp);
  const time = date && formatRecordTime(date);
  const filterButton = (field: RecordFilter, value: string, label = value) => (
    <button type="button" className="usage-filter-link" onClick={() => onFilter(field, value)}>
      {label}
    </button>
  );
  const event = "kind" in row;
  const title = event ? row.name : (row.model ?? "Unknown model");
  return (
    <details className="usage-row">
      <summary tabIndex={0}>
        <span className="usage-row-name" title={title}>
          {title}
        </span>
        <span className="usage-row-type">
          {sourceLabel[row.source]} · {rowLabel[event ? row.kind : row.unit]}
        </span>
        <span className="usage-row-time">
          {date && time ? (
            <time dateTime={date.toISOString()}>
              <span>{time.utc}</span> <span>({time.local})</span>
            </time>
          ) : (
            "Timestamp unknown"
          )}
        </span>
        <span className="usage-row-total">
          {!event &&
            `${count.format(row.input + row.cacheRead + row.cacheWrite + row.output)} tokens`}
        </span>
      </summary>
      <dl className="usage-details">
        <dt>ID</dt>
        <dd>{row.id}</dd>
        {(row.workspaceId || row.workspaceName) && (
          <>
            <dt>Workspace</dt>
            <dd>
              {row.workspaceName &&
                filterButton("workspace", row.workspaceId ?? row.workspaceName, row.workspaceName)}
              {row.workspaceId && filterButton("workspace", row.workspaceId)}
            </dd>
          </>
        )}
        <dt>Session ID</dt>
        <dd>{filterButton("session", row.sessionId)}</dd>
        {!event && row.piSessionId && (
          <>
            <dt>Pi session ID</dt>
            <dd>{filterButton("session", row.piSessionId)}</dd>
          </>
        )}
        {row.turnId !== undefined && (
          <>
            <dt>Turn</dt>
            <dd>{filterButton("turn", row.turnId)}</dd>
          </>
        )}
        {!event && (
          <>
            <dt>Channel</dt>
            <dd>{row.channel || "Unknown"}</dd>
            {tokenParts.map(([key, label]) => (
              <Fragment key={key}>
                <dt>{label}</dt>
                <dd>{count.format(row[key])}</dd>
              </Fragment>
            ))}
            {row.unit === "inference" && (
              <>
                <dt>Cache read share</dt>
                <dd>{share(row.cacheRead, row.input + row.cacheRead + row.cacheWrite)}</dd>
              </>
            )}
            <dt>Price</dt>
            <dd>
              {priceLabel[row.price.kind]}
              {row.price.usd !== null && ` · ${usd.format(row.price.usd)} USD`}
              {row.price.asOf && ` · as of ${row.price.asOf}`}
            </dd>
            {!!row.toolCalls?.length && (
              <>
                <dt>Linked tools</dt>
                <dd>
                  <ul>
                    {row.toolCalls.map((tool) => (
                      <li key={tool.id}>
                        {tool.name} ({tool.id})
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
          </>
        )}
      </dl>
    </details>
  );
}

const textFields = {
  model: "Model",
  channel: "Channel",
  workspace: "Workspace",
  session: "Session",
} as const;
type TextField = keyof typeof textFields;
const textKeys = Object.keys(textFields) as TextField[];
const filterLabels = { ...textFields, source: "Source", turn: "Turn" };
type FilterField = keyof typeof filterLabels;
const filterKeys = Object.keys(filterLabels) as FilterField[];
const emptyDraft = { model: "", channel: "", workspace: "", session: "" };
const emptyFilters = { ...emptyDraft, source: "", turn: "" };
const ranges = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};
const units = { inference: "Inference", turn: "Turn", session: "Session" };
type Range = keyof typeof ranges;
type WorkspaceOption = { id: string; name: string };
type View = "overview" | "journey";
type UsageSourceStatus = {
  incompleteSources: number;
  sourcesPending: boolean;
  since: number;
  until: number;
};
type UsageData = UsageSourceStatus & {
  unit: UsageObservation["unit"];
  granularity: UsageGranularity;
  filters: typeof emptyFilters;
} & ({ view: "overview"; payload: OverviewData } | { view: "journey"; payload: UsageJourney });
type UsageLoad =
  { version: number; status: "error" } | { version: number; status: "ready"; data: UsageData };

function workspaceLabel({ id, name }: WorkspaceOption) {
  return `${name} · ${id.slice(0, 8)}`;
}

export function UsageDashboard({
  onClose,
  workspaces = [],
}: {
  onClose: () => void;
  workspaces?: readonly WorkspaceOption[];
}) {
  const [mode, setMode] = useState<TrendMode>("types");
  const [view, setView] = useState<View>("overview");
  const [range, setRange] = useState<Range>("30d");
  const [unit, setUnit] = useState<UsageObservation["unit"]>("inference");
  const [granularity, setGranularity] = useState<UsageGranularity>("day");
  const [filters, setFilters] = useState(emptyFilters);
  const [draft, setDraft] = useState(emptyDraft);
  const [knownModels, setKnownModels] = useState<string[]>([]);
  const [request, setRequest] = useState<{
    version: number;
    refresh: boolean;
    page: number;
    until?: number;
  }>({
    version: 0,
    refresh: false,
    page: 1,
  });
  const [jump, setJump] = useState("1");
  const [load, setLoad] = useState<UsageLoad>();
  const [retained, setRetained] = useState<Extract<UsageLoad, { status: "ready" }>>();
  const { version } = request;
  const navigate = (page = 1, until?: number, refresh = false) => {
    setRequest((previous) => ({ version: previous.version + 1, refresh, page, until }));
    setJump(String(page));
  };
  const changeFilter = (field: FilterField, value: string) => {
    setFilters((previous) => ({ ...previous, [field]: value }));
    if (field in textFields) setDraft((previous) => ({ ...previous, [field]: value }));
    navigate();
  };
  const shortRange = range === "24h" || range === "7d";
  const params = new URLSearchParams({ range, unit, granularity });
  for (const field of filterKeys) if (filters[field]) params.set(field, filters[field]);
  if (view === "journey") {
    params.set("page", String(request.page));
    if (request.until !== undefined) params.set("until", String(request.until));
  }
  if (request.refresh) params.set("refresh", "1");
  const url = `api/usage/${view}?${params}`;

  useEffect(() => {
    const controller = new AbortController();
    async function fetchUsage() {
      try {
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Usage request failed");
        const payload = (await response.json()) as Partial<
          OverviewData & UsageJourney & UsageSourceStatus
        > | null;
        if (controller.signal.aborted) return;
        if (!payload) throw new Error("Usage response missing");
        const { incompleteSources, since, until } = payload;
        if (
          incompleteSources === undefined ||
          !Number.isSafeInteger(incompleteSources) ||
          incompleteSources < 0 ||
          since === undefined ||
          !Number.isSafeInteger(since) ||
          until === undefined ||
          !Number.isSafeInteger(until) ||
          since >= until
        )
          throw new Error("Usage source status or window missing");
        const status = {
          incompleteSources,
          sourcesPending: payload.sourcesPending === true,
          since,
          until,
        };
        let data: UsageData;
        if (view === "overview") {
          if (
            !Array.isArray(payload.trend) ||
            !Array.isArray(payload.ranking) ||
            !payload.costs ||
            typeof payload.count !== "number" ||
            typeof payload.promptBearing !== "number"
          )
            throw new Error("Usage overview missing");
          const models = payload.ranking.flatMap(({ model }) => (model ? [model] : []));
          setKnownModels((previous) => [...new Set([...previous, ...models])]);
          data = { view, payload: payload as OverviewData, unit, granularity, filters, ...status };
        } else {
          const { total, page, pageSize } = payload;
          if (
            !Array.isArray(payload.rows) ||
            total === undefined ||
            !Number.isSafeInteger(total) ||
            total < 0 ||
            page === undefined ||
            !Number.isSafeInteger(page) ||
            page < 1 ||
            pageSize === undefined ||
            !Number.isSafeInteger(pageSize) ||
            pageSize < 1
          )
            throw new Error("Records page missing");
          data = { view, payload: payload as UsageJourney, unit, granularity, filters, ...status };
          setJump(String(page));
        }
        const ready = { version, status: "ready" as const, data };
        setRetained(ready);
        setLoad(ready);
      } catch {
        if (!controller.signal.aborted) setLoad({ version, status: "error" });
      }
    }
    void fetchUsage();
    return () => controller.abort();
  }, [url, version, view, filters, granularity, unit]);

  const current = load?.version === version ? load : undefined;
  const previous = retained?.data.view === view ? retained : undefined;
  const displayed = current?.status === "ready" ? current : previous;
  const data = displayed?.data ?? null;
  const journey = data?.view === "journey" ? data.payload : null;
  const activeFilters = filterKeys.filter((field) => filters[field]);
  const lastPage = journey ? Math.max(1, Math.ceil(journey.total / journey.pageSize)) : 1;
  const canPaginate = current?.status === "ready";
  const goToPage = (page: number) => {
    if (
      canPaginate &&
      journey &&
      data &&
      Number.isSafeInteger(page) &&
      page >= 1 &&
      page <= lastPage &&
      page !== journey.page
    )
      navigate(page, request.until ?? data.until);
  };
  const selectedWorkspace = workspaces.find(({ id }) => id === filters.workspace);
  const loadState = data
    ? !current
      ? "Updating usage…"
      : current.status === "error"
        ? "Update failed · previous results"
        : ""
    : "";
  return (
    <DialogFrame
      title="Usage dashboard"
      className="usage-dialog"
      onClose={onClose}
      titleAside={
        <span
          className={`usage-load-state${data && current?.status === "error" ? " usage-warning" : ""}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {loadState}
        </span>
      }
    >
      <div className="usage-toolbar">
        <div className="bp-views usage-views" role="group" aria-label="Usage views">
          {(
            [
              ["overview", "Overview"],
              ["journey", "Records"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => {
                if (view !== value) {
                  setView(value);
                  navigate();
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="usage-quick-filters">
          <label className="dialog-field">
            <span>Window (UTC)</span>
            <select
              value={range}
              onChange={(event) => {
                const next = event.target.value as Range;
                setRange(next);
                setGranularity(next === "24h" ? "hour" : "day");
                navigate();
              }}
            >
              {Object.entries(ranges).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="dialog-field">
            <span>Granularity</span>
            <select
              value={granularity}
              disabled={!shortRange}
              onChange={(event) => {
                setGranularity(event.target.value as UsageGranularity);
                navigate();
              }}
            >
              <option value="day">Day</option>
              {shortRange && <option value="hour">Hour</option>}
            </select>
          </label>
          <label className="dialog-field">
            <span>Reporting unit</span>
            <select
              value={unit}
              onChange={(event) => {
                setUnit(event.target.value as UsageObservation["unit"]);
                navigate();
              }}
            >
              {Object.entries(units).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="dialog-body usage-body" aria-busy={!current}>
        <details className="usage-filters">
          <summary tabIndex={0}>
            Filters{activeFilters.length > 0 && ` · ${activeFilters.length} active`}
          </summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const applied = {
                model: draft.model.trim(),
                channel: draft.channel.trim(),
                workspace: draft.workspace.trim(),
                session: draft.session.trim(),
              };
              setDraft(applied);
              setFilters((previous) => ({ ...previous, ...applied }));
              navigate();
            }}
          >
            <div className="usage-filter-grid">
              <label className="dialog-field">
                <span>Source</span>
                <select
                  value={filters.source}
                  onChange={(event) => changeFilter("source", event.target.value)}
                >
                  <option value="">All sources</option>
                  {Object.entries(sourceLabel).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="dialog-field">
                <span>Workspace</span>
                <select
                  value={filters.workspace}
                  onChange={(event) => changeFilter("workspace", event.target.value)}
                >
                  <option value="">All workspaces</option>
                  {!selectedWorkspace && filters.workspace && (
                    <option value={filters.workspace}>Text filter: {filters.workspace}</option>
                  )}
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspaceLabel(workspace)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="dialog-field">
                <span>Model</span>
                <select
                  value={filters.model}
                  onChange={(event) => changeFilter("model", event.target.value)}
                >
                  <option value="">All models</option>
                  {filters.model && !knownModels.includes(filters.model) && (
                    <option value={filters.model}>Text filter: {filters.model}</option>
                  )}
                  {knownModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </label>
              {textKeys.map((field) => (
                <label className="dialog-field" key={field}>
                  <span>
                    {field === "session"
                      ? "Session ID (Pi / ACP / Codex) contains"
                      : `${textFields[field]} contains`}
                  </span>
                  <input
                    maxLength={256}
                    value={draft[field]}
                    onChange={(event) =>
                      setDraft((previous) => ({ ...previous, [field]: event.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
            <div className="usage-controls">
              <button type="submit" className="btn-secondary">
                {textKeys.some((field) => draft[field] !== filters[field])
                  ? "Apply changes"
                  : "Apply filters"}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setDraft(emptyDraft);
                  setFilters(emptyFilters);
                  navigate();
                }}
              >
                Clear filters
              </button>
            </div>
          </form>
        </details>
        {activeFilters.length > 0 && (
          <ul className="bp-chips usage-chips" aria-label="Active filters">
            {activeFilters.map((field) => {
              const value =
                field === "workspace" && selectedWorkspace
                  ? workspaceLabel(selectedWorkspace)
                  : field === "source"
                    ? sourceLabel[filters.source as UsageObservation["source"]]
                    : filters[field];
              return (
                <li key={field}>
                  <button
                    type="button"
                    className="bp-chip"
                    aria-pressed={true}
                    aria-label={`Remove ${filterLabels[field].toLowerCase()} filter: ${value}`}
                    onClick={() => changeFilter(field, "")}
                  >
                    {filterLabels[field]}: {value} <span aria-hidden="true">×</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!current && !data && (
          <p className="usage-notice" role="status">
            Loading usage…
          </p>
        )}
        {current?.status === "error" && !data && (
          <p className="usage-notice" role="status">
            Could not load usage. Use Refresh to try again.
          </p>
        )}
        {data?.view === "journey" && data.sourcesPending && (
          <p className="usage-notice usage-warning" role="status">
            Source scan pending
          </p>
        )}
        {data?.view === "journey" && data.incompleteSources > 0 && (
          <p className="usage-notice usage-warning">
            {count.format(data.incompleteSources)}{" "}
            {data.incompleteSources === 1 ? "source" : "sources"} unavailable or partially read
          </p>
        )}
        {data?.view === "overview" && (
          <UsageOverview
            mode={mode}
            setMode={setMode}
            data={data.payload}
            incompleteSources={data.incompleteSources}
            sourcesPending={data.sourcesPending}
            since={data.since}
            until={data.until}
            granularity={data.granularity}
            unit={data.unit}
            model={data.filters.model}
            onModelChange={(model: string) => changeFilter("model", model)}
          />
        )}
        {journey && data && (
          <section aria-label="Records">
            <p className="usage-journey-note">
              Newest first · UTC and local time
              {(data.filters.model || data.filters.channel) &&
                " · Events excluded by model or channel filter"}
            </p>
            {!journey.rows.length ? (
              <p className="usage-notice" role="status">
                No records match these filters.
              </p>
            ) : (
              <ol
                className="usage-journey"
                aria-label="Recorded observations and events"
                role="list"
                key={displayed?.version}
              >
                {journey.rows.map((row) => (
                  <li key={JSON.stringify(["kind" in row, row.source, row.sessionId, row.id])}>
                    <JourneyRow row={row} onFilter={changeFilter} />
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
      </div>
      <div className="dialog-actions usage-actions">
        {view === "journey" && (
          <form
            className="usage-controls usage-pages"
            aria-label="Record pages"
            onSubmit={(event) => {
              event.preventDefault();
              goToPage(Number(jump));
            }}
          >
            <span aria-live="polite">
              {journey
                ? `Page ${journey.page} of ${lastPage} · ${count.format(journey.total)} records`
                : `Page ${request.page}`}
            </span>
            <button
              type="button"
              className="btn-secondary usage-page-button"
              aria-label="First"
              title="First page"
              disabled={!canPaginate || !journey || journey.page <= 1}
              onClick={() => goToPage(1)}
            >
              <Icon name="first" />
            </button>
            <button
              type="button"
              className="btn-secondary usage-page-button"
              aria-label="Previous"
              title="Previous page"
              disabled={!canPaginate || !journey || journey.page <= 1}
              onClick={() => journey && goToPage(journey.page - 1)}
            >
              <Icon name="previous" />
            </button>
            <input
              aria-label="Page number"
              type="number"
              min={1}
              max={lastPage}
              value={jump}
              disabled={!canPaginate || !journey}
              required
              onChange={(event) => setJump(event.target.value)}
            />
            <button type="submit" className="btn-secondary" disabled={!canPaginate || !journey}>
              Jump
            </button>
            <button
              type="button"
              className="btn-secondary usage-page-button"
              aria-label="Next"
              title="Next page"
              disabled={!canPaginate || !journey || journey.page >= lastPage}
              onClick={() => journey && goToPage(journey.page + 1)}
            >
              <Icon name="next" />
            </button>
            <button
              type="button"
              className="btn-secondary usage-page-button"
              aria-label="Last"
              title="Last page"
              disabled={!canPaginate || !journey || journey.page >= lastPage}
              onClick={() => goToPage(lastPage)}
            >
              <Icon name="last" />
            </button>
          </form>
        )}
        <button
          type="button"
          className="btn-secondary"
          onClick={() => navigate(1, undefined, true)}
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
