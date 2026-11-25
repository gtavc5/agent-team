import { Fragment, useEffect, useId, useState } from "react";
import type {
  JourneyEvent,
  UsageJourney,
  UsageObservation,
  UsageOverview as OverviewData,
} from "../../../shared/usage";
import { DialogFrame } from "../workspace/DialogFrame";
import { count, priceLabel, share, tokenParts, UsageOverview, usd } from "./UsageOverview";

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
const journeyTime = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function JourneyRow({ row }: { row: JourneyEvent | UsageObservation }) {
  const date = row.timestamp === null ? null : new Date(row.timestamp);
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
          {date ? (
            <time dateTime={date.toISOString()}>{journeyTime.format(date)}</time>
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
        <dt>Session</dt>
        <dd>{row.sessionId}</dd>
        {row.turnId !== undefined && (
          <>
            <dt>Turn</dt>
            <dd>{row.turnId}</dd>
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

const advancedFields = ["model", "channel", "source", "workspace", "session", "turn"] as const;
type AdvancedFilters = Record<(typeof advancedFields)[number], string>;
const emptyFilters: AdvancedFilters = {
  model: "",
  channel: "",
  source: "",
  workspace: "",
  session: "",
  turn: "",
};
type WorkspaceOption = { id: string; name: string };
type View = "overview" | "journey";
type UsageSourceStatus = { incompleteSources: number; sourcesPending?: boolean; until?: number };
type UsageData = UsageSourceStatus &
  ({ view: "overview"; payload: OverviewData } | { view: "journey"; payload: UsageJourney });
type UsageLoad =
  { key: string; status: "error" } | { key: string; status: "ready"; data: UsageData };

export function UsageDashboard({
  onClose,
  workspaces = [],
}: {
  onClose: () => void;
  workspaces?: readonly WorkspaceOption[];
}) {
  const workspaceList = useId();
  const [view, setView] = useState<View>("overview");
  const [refresh, setRefresh] = useState(0);
  const [range, setRange] = useState("30d");
  const [unit, setUnit] = useState("inference");
  const [filters, setFilters] = useState(emptyFilters);
  const [draft, setDraft] = useState(emptyFilters);
  const [page, setPage] = useState<{ cursors: (string | null)[]; until?: number }>({
    cursors: [null],
  });
  const { cursors } = page;
  const resetPage = () => setPage({ cursors: [null] });
  const [load, setLoad] = useState<UsageLoad>();
  const cursor = cursors[cursors.length - 1];
  const params = new URLSearchParams({ range, unit });
  for (const field of advancedFields) if (filters[field]) params.set(field, filters[field]);
  if (view === "journey") {
    if (cursor !== null) params.set("cursor", cursor);
    if (page.until !== undefined) params.set("until", String(page.until));
  }
  const url = `api/usage/${view}?${params}`;
  const key = `${refresh}:${url}`;

  useEffect(() => {
    const controller = new AbortController();
    async function fetchUsage() {
      try {
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Usage request failed");
        const payload = (await response.json()) as Partial<
          OverviewData & UsageJourney & UsageSourceStatus
        > | null;
        const incompleteSources = payload?.incompleteSources;
        if (
          !payload ||
          incompleteSources === undefined ||
          !Number.isInteger(incompleteSources) ||
          incompleteSources < 0
        )
          throw new Error("Usage source status missing");
        const status = {
          incompleteSources,
          sourcesPending: payload.sourcesPending === true,
          until: Number.isSafeInteger(payload.until) ? payload.until : undefined,
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
          data = { view, payload: payload as OverviewData, ...status };
        } else {
          if (
            !Array.isArray(payload.rows) ||
            (payload.nextCursor !== null && typeof payload.nextCursor !== "string")
          )
            throw new Error("Journey page missing");
          data = { view, payload: payload as UsageJourney, ...status };
        }
        if (!controller.signal.aborted) setLoad({ key, status: "ready", data });
      } catch {
        if (!controller.signal.aborted) setLoad({ key, status: "error" });
      }
    }
    void fetchUsage();
    return () => controller.abort();
  }, [url, key, view]);

  const current = load?.key === key ? load : undefined;
  const data = current?.status === "ready" ? current.data : null;
  const journey = data?.view === "journey" ? data.payload : null;
  const activeFilters = advancedFields.filter((field) => filters[field]).length;
  const updateDraft = (field: keyof AdvancedFilters, value: string) =>
    setDraft((previous) => ({ ...previous, [field]: value }));
  return (
    <DialogFrame title="Usage dashboard" className="usage-dialog" onClose={onClose}>
      <div className="usage-toolbar">
        <div className="usage-controls usage-views" role="group" aria-label="Usage views">
          {(
            [
              ["overview", "Overview"],
              ["journey", "Journey"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="btn-secondary"
              aria-pressed={view === value}
              onClick={() => {
                if (view !== value) {
                  setView(value);
                  resetPage();
                  setRefresh((previous) => previous + 1);
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
                setRange(event.target.value);
                resetPage();
              }}
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </select>
          </label>
          <label className="dialog-field">
            <span>Reporting unit</span>
            <select
              value={unit}
              onChange={(event) => {
                setUnit(event.target.value);
                resetPage();
              }}
            >
              <option value="inference">Inference</option>
              <option value="turn">Turn</option>
              <option value="session">Session</option>
            </select>
          </label>
        </div>
      </div>
      <div className="dialog-body usage-body">
        <details className="usage-filters">
          <summary tabIndex={0}>Filters{activeFilters > 0 && ` · ${activeFilters} active`}</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setFilters({
                model: draft.model.trim(),
                channel: draft.channel.trim(),
                source: draft.source,
                workspace: draft.workspace.trim(),
                session: draft.session.trim(),
                turn: draft.turn.trim(),
              });
              resetPage();
            }}
          >
            <div className="usage-filter-grid">
              <label className="dialog-field">
                <span>Model</span>
                <input
                  maxLength={256}
                  placeholder="Any model"
                  value={draft.model}
                  onChange={(e) => updateDraft("model", e.target.value)}
                />
              </label>
              <label className="dialog-field">
                <span>Channel</span>
                <input
                  maxLength={256}
                  placeholder="Any channel"
                  value={draft.channel}
                  onChange={(e) => updateDraft("channel", e.target.value)}
                />
              </label>
              <label className="dialog-field">
                <span>Source</span>
                <select
                  value={draft.source}
                  onChange={(e) => updateDraft("source", e.target.value)}
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
                <input
                  list={workspaces.length ? workspaceList : undefined}
                  maxLength={256}
                  placeholder="Any workspace ID"
                  value={draft.workspace}
                  onChange={(e) => updateDraft("workspace", e.target.value)}
                />
                {workspaces.length > 0 && (
                  <datalist id={workspaceList}>
                    {workspaces.map(({ id, name }) => (
                      <option key={id} value={id} label={name} />
                    ))}
                  </datalist>
                )}
              </label>
              <label className="dialog-field">
                <span>Session ID</span>
                <input
                  maxLength={256}
                  placeholder="Any session"
                  value={draft.session}
                  onChange={(e) => updateDraft("session", e.target.value)}
                />
              </label>
              <label className="dialog-field">
                <span>Turn ID</span>
                <input
                  maxLength={256}
                  placeholder="Any turn"
                  value={draft.turn}
                  onChange={(e) => updateDraft("turn", e.target.value)}
                />
              </label>
            </div>
            <div className="usage-controls">
              <button type="submit" className="btn-secondary">
                Apply filters
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setDraft(emptyFilters);
                  setFilters(emptyFilters);
                  resetPage();
                }}
              >
                Clear filters
              </button>
            </div>
          </form>
        </details>
        {!current && (
          <p className="usage-notice" role="status">
            Loading usage…
          </p>
        )}
        {current?.status === "error" && (
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
            Unavailable or partially decoded usage sources: {count.format(data.incompleteSources)}
          </p>
        )}
        {data?.view === "overview" && (
          <UsageOverview
            data={data.payload}
            incompleteSources={data.incompleteSources}
            sourcesPending={data.sourcesPending}
          />
        )}
        {view === "journey" && journey && (
          <section aria-label="Journey">
            <p className="usage-journey-note">
              Recorded observations and events · UTC
              {(filters.model || filters.channel) &&
                " · Events excluded by model or channel filter"}
            </p>
            {!journey.rows.length ? (
              <p className="usage-notice" role="status">
                No Journey records returned.
              </p>
            ) : (
              <ol
                className="usage-journey"
                aria-label="Recorded observations and events"
                role="list"
                key={key}
              >
                {journey.rows.map((row) => (
                  <li key={JSON.stringify(["kind" in row, row.source, row.sessionId, row.id])}>
                    <JourneyRow row={row} />
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
      </div>
      <div className="dialog-actions usage-actions">
        {view === "journey" && (
          <div className="usage-controls usage-pages" role="group" aria-label="Journey pages">
            <button
              type="button"
              className="btn-secondary"
              disabled={cursors.length === 1}
              onClick={() => setPage({ ...page, cursors: cursors.slice(0, -1) })}
            >
              Previous
            </button>
            <span aria-live="polite">Page {cursors.length}</span>
            <button
              type="button"
              className="btn-secondary"
              disabled={!journey?.nextCursor}
              onClick={() => {
                if (journey?.nextCursor)
                  setPage({
                    cursors: [...cursors, journey.nextCursor],
                    until: page.until ?? data?.until,
                  });
              }}
            >
              Next
            </button>
          </div>
        )}
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setRefresh((previous) => previous + 1)}
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
