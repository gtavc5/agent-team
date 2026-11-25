import { Fragment, useEffect, useState } from "react";
import type {
  UsageGranularity,
  UsageJourney,
  UsageObservation,
  UsageOverview as OverviewData,
} from "../../../shared/usage";
import { useUsageT } from "../i18n/usage";
import { DialogFrame } from "../workspace/DialogFrame";
import { Icon } from "../panels/Icon";
import { formatRecordTime, tokenParts, useUsageFormat } from "./format";
import { UsageOverview, type TrendMode } from "./UsageOverview";

const sourceLabel: Record<UsageObservation["source"], string> = {
  acp: "ACP",
  pi: "Pi",
  codex: "Codex",
};
type RecordFilter = "workspace" | "session" | "turn";

function recordTitle(row: UsageJourney["rows"][number], tr: ReturnType<typeof useUsageT>) {
  if (!("kind" in row)) return row.model ?? tr("unknownModel");
  if (row.kind === "compaction") {
    if (row.source === "pi" && row.name === "Context compaction") return tr("piCompaction");
    if (row.source === "codex" && row.name === "contextCompaction") return tr("codexCompaction");
  }
  return row.name;
}

function JourneyRow({
  row,
  onFilter,
}: {
  row: UsageJourney["rows"][number];
  onFilter: (field: RecordFilter, value: string) => void;
}) {
  const tr = useUsageT();
  const { count, share, usd, locale } = useUsageFormat();
  const date = row.timestamp === null ? null : new Date(row.timestamp);
  const time = date && formatRecordTime(date, undefined, locale);
  const filterButton = (field: RecordFilter, value: string, label = value) => (
    <button type="button" className="usage-filter-link" onClick={() => onFilter(field, value)}>
      {label}
    </button>
  );
  const event = "kind" in row;
  const title = recordTitle(row, tr);
  return (
    <details className="usage-row">
      <summary tabIndex={0}>
        <span className="usage-row-name" title={title}>
          {title}
        </span>
        <span className="usage-row-type">
          {sourceLabel[row.source]} · {tr(event ? row.kind : row.unit)}
        </span>
        <span className="usage-row-time">
          {date && time ? (
            <time dateTime={date.toISOString()}>
              <span>{time.utc}</span> <span>({time.local})</span>
            </time>
          ) : (
            tr("unknownTime")
          )}
        </span>
        <span className="usage-row-total">
          {!event &&
            tr("tokens", {
              count: count.format(row.input + row.cacheRead + row.cacheWrite + row.output),
            })}
        </span>
      </summary>
      <dl className="usage-details">
        <dt>{tr("id")}</dt>
        <dd>{row.id}</dd>
        {(row.workspaceId || row.workspaceName) && (
          <>
            <dt>{tr("workspace")}</dt>
            <dd>
              {row.workspaceName &&
                filterButton("workspace", row.workspaceId ?? row.workspaceName, row.workspaceName)}
              {row.workspaceId && filterButton("workspace", row.workspaceId)}
            </dd>
          </>
        )}
        <dt>{tr("sessionId")}</dt>
        <dd>{filterButton("session", row.sessionId)}</dd>
        {!event && row.piSessionId && (
          <>
            <dt>{tr("piSessionId")}</dt>
            <dd>{filterButton("session", row.piSessionId)}</dd>
          </>
        )}
        {row.turnId !== undefined && (
          <>
            <dt>{tr("turn")}</dt>
            <dd>{filterButton("turn", row.turnId)}</dd>
          </>
        )}
        {!event && (
          <>
            <dt>{tr("channel")}</dt>
            <dd>{row.channel || tr("unknown")}</dd>
            {tokenParts.map((key) => (
              <Fragment key={key}>
                <dt>{tr(key)}</dt>
                <dd>{count.format(row[key])}</dd>
              </Fragment>
            ))}
            {row.unit === "inference" && (
              <>
                <dt>{tr("cacheReadShare")}</dt>
                <dd>{share(row.cacheRead, row.input + row.cacheRead + row.cacheWrite)}</dd>
              </>
            )}
            <dt>{tr("price")}</dt>
            <dd>
              {tr(row.price.kind)}
              {row.price.usd !== null && ` · ${usd.format(row.price.usd)} USD`}
              {row.price.asOf && ` · ${tr("priceAsOf", { date: row.price.asOf })}`}
            </dd>
            {!!row.toolCalls?.length && (
              <>
                <dt>{tr("linkedTools")}</dt>
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

const emptyDraft = { model: "", channel: "", workspace: "", session: "" };
const emptyFilters = { ...emptyDraft, source: "", turn: "" };
type FilterField = keyof typeof emptyFilters;
const textKeys = Object.keys(emptyDraft) as (keyof typeof emptyDraft)[];
const filterKeys = Object.keys(emptyFilters) as FilterField[];
const ranges = ["24h", "7d", "30d", "90d"] as const;
const units = ["inference", "turn", "session"] as const;
type Range = (typeof ranges)[number];
type WorkspaceOption = { id: string; name: string };
const views = ["overview", "journey"] as const;
type View = (typeof views)[number];
type UsageSourceStatus = {
  incompleteSources: number;
  sourcesPending: boolean;
  since: number;
  until: number;
};
type UsageData = UsageSourceStatus &
  ({ view: "overview"; payload: OverviewData } | { view: "journey"; payload: UsageJourney });
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
  const tr = useUsageT();
  const { count, incomplete } = useUsageFormat();
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
  const { version } = request;
  const navigate = (page = 1, until?: number, refresh = false) => {
    setRequest((previous) => ({ version: previous.version + 1, refresh, page, until }));
    setJump(String(page));
  };
  const changeFilter = (field: FilterField, value: string) => {
    setFilters((previous) => ({ ...previous, [field]: value }));
    if (field in emptyDraft) setDraft((previous) => ({ ...previous, [field]: value }));
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
          data = { view, payload: payload as OverviewData, ...status };
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
          data = { view, payload: payload as UsageJourney, ...status };
          setJump(String(page));
        }
        setLoad({ version, status: "ready", data });
      } catch {
        if (!controller.signal.aborted) setLoad({ version, status: "error" });
      }
    }
    void fetchUsage();
    return () => controller.abort();
  }, [url, version, view]);

  const current = load?.version === version ? load : undefined;
  const data = current?.status === "ready" ? current.data : null;
  const journey = data?.view === "journey" ? data.payload : null;
  const activeFilters = filterKeys.filter((field) => filters[field]);
  const lastPage = journey ? Math.max(1, Math.ceil(journey.total / journey.pageSize)) : 1;
  const goToPage = (page: number) => {
    if (
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
  return (
    <DialogFrame title={tr("dashboard")} className="usage-dialog" onClose={onClose}>
      <div className="usage-toolbar">
        <div className="usage-controls usage-views" role="group" aria-label={tr("views")}>
          {views.map((value) => (
            <button
              key={value}
              type="button"
              className="btn-secondary"
              aria-pressed={view === value}
              onClick={() => {
                if (view !== value) {
                  setView(value);
                  navigate();
                }
              }}
            >
              {tr(value)}
            </button>
          ))}
        </div>
        <div className="usage-quick-filters">
          <label className="dialog-field">
            <span>{tr("window")}</span>
            <select
              value={range}
              onChange={(event) => {
                const next = event.target.value as Range;
                setRange(next);
                setGranularity(next === "24h" ? "hour" : "day");
                navigate();
              }}
            >
              {ranges.map((value) => (
                <option key={value} value={value}>
                  {tr(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="dialog-field">
            <span>{tr("granularity")}</span>
            <select
              value={granularity}
              disabled={!shortRange}
              onChange={(event) => {
                setGranularity(event.target.value as UsageGranularity);
                navigate();
              }}
            >
              <option value="day">{tr("day")}</option>
              {shortRange && <option value="hour">{tr("hour")}</option>}
            </select>
          </label>
          <label className="dialog-field">
            <span>{tr("reportingUnit")}</span>
            <select
              value={unit}
              onChange={(event) => {
                setUnit(event.target.value as UsageObservation["unit"]);
                navigate();
              }}
            >
              {units.map((value) => (
                <option key={value} value={value}>
                  {tr(value)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="dialog-body usage-body">
        <details className="usage-filters">
          <summary tabIndex={0}>
            {activeFilters.length > 0
              ? tr("filtersWithCount", { count: activeFilters.length })
              : tr("filters")}
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
                <span>{tr("source")}</span>
                <select
                  value={filters.source}
                  onChange={(event) => changeFilter("source", event.target.value)}
                >
                  <option value="">{tr("allSources")}</option>
                  {Object.entries(sourceLabel).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="dialog-field">
                <span>{tr("workspace")}</span>
                <select
                  value={filters.workspace}
                  onChange={(event) => changeFilter("workspace", event.target.value)}
                >
                  <option value="">{tr("allWorkspaces")}</option>
                  {!selectedWorkspace && filters.workspace && (
                    <option value={filters.workspace}>
                      {tr("textFilter", { value: filters.workspace })}
                    </option>
                  )}
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspaceLabel(workspace)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="dialog-field">
                <span>{tr("model")}</span>
                <select
                  value={filters.model}
                  onChange={(event) => changeFilter("model", event.target.value)}
                >
                  <option value="">{tr("allModels")}</option>
                  {filters.model && !knownModels.includes(filters.model) && (
                    <option value={filters.model}>
                      {tr("textFilter", { value: filters.model })}
                    </option>
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
                  <span>{tr(`${field}Contains`)}</span>
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
                {tr(
                  textKeys.some((field) => draft[field] !== filters[field])
                    ? "applyChanges"
                    : "applyFilters",
                )}
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
                {tr("clearFilters")}
              </button>
            </div>
          </form>
        </details>
        {activeFilters.length > 0 && (
          <ul className="usage-controls usage-chips" aria-label={tr("activeFilters")}>
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
                    className="btn-secondary"
                    aria-label={tr("removeFilter", { field: tr(field).toLowerCase(), value })}
                    onClick={() => changeFilter(field, "")}
                  >
                    {tr("labeledValue", { field: tr(field), value })}{" "}
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!current && (
          <p className="usage-notice" role="status">
            {tr("loading")}
          </p>
        )}
        {current?.status === "error" && (
          <p className="usage-notice" role="status">
            {tr("loadError")}
          </p>
        )}
        {data?.view === "journey" && data.sourcesPending && (
          <p className="usage-notice usage-warning" role="status">
            {tr("scanPending")}
          </p>
        )}
        {data?.view === "journey" && data.incompleteSources > 0 && (
          <p className="usage-notice usage-warning">{incomplete(data.incompleteSources)}</p>
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
            granularity={granularity}
            unit={unit}
            model={filters.model}
            onModelChange={(model: string) => changeFilter("model", model)}
          />
        )}
        {journey && (
          <section aria-label={tr("journey")}>
            <p className="usage-journey-note">
              {tr("recordsOrder")}
              {(filters.model || filters.channel) && ` · ${tr("eventsExcluded")}`}
            </p>
            {!journey.rows.length ? (
              <p className="usage-notice" role="status">
                {tr("noMatchingRecords")}
              </p>
            ) : (
              <ol
                className="usage-journey"
                aria-label={tr("recordsList")}
                role="list"
                key={version}
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
            aria-label={tr("recordPages")}
            onSubmit={(event) => {
              event.preventDefault();
              goToPage(Number(jump));
            }}
          >
            <span aria-live="polite">
              {journey
                ? tr("pageSummary", {
                    page: journey.page,
                    pages: lastPage,
                    count: count.format(journey.total),
                  })
                : tr("pageStatus", { page: request.page })}
            </span>
            <button
              type="button"
              className="btn-secondary usage-page-button"
              aria-label={tr("first")}
              title={tr("firstPage")}
              disabled={!journey || journey.page <= 1}
              onClick={() => goToPage(1)}
            >
              <Icon name="first" />
            </button>
            <button
              type="button"
              className="btn-secondary usage-page-button"
              aria-label={tr("previous")}
              title={tr("previousPage")}
              disabled={!journey || journey.page <= 1}
              onClick={() => journey && goToPage(journey.page - 1)}
            >
              <Icon name="previous" />
            </button>
            <input
              aria-label={tr("pageNumber")}
              type="number"
              min={1}
              max={lastPage}
              value={jump}
              disabled={!journey}
              required
              onChange={(event) => setJump(event.target.value)}
            />
            <button type="submit" className="btn-secondary" disabled={!journey}>
              {tr("jump")}
            </button>
            <button
              type="button"
              className="btn-secondary usage-page-button"
              aria-label={tr("next")}
              title={tr("nextPage")}
              disabled={!journey || journey.page >= lastPage}
              onClick={() => journey && goToPage(journey.page + 1)}
            >
              <Icon name="next" />
            </button>
            <button
              type="button"
              className="btn-secondary usage-page-button"
              aria-label={tr("last")}
              title={tr("lastPage")}
              disabled={!journey || journey.page >= lastPage}
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
          {tr("refresh")}
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>
          {tr("close")}
        </button>
      </div>
    </DialogFrame>
  );
}
