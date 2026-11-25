import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { telemetryTarget } from "../telemetryEvents";
import type {
  IssueModule,
  IssueModules,
  Objective,
  ObjectiveStatus,
  Priority,
  Project,
  TaskState,
} from "../state/useServer";
import {
  InlineMd,
  IssueRefContext,
  MdBlock,
  NoLinks,
  ProsePathContext,
  type IssueRefs,
} from "../chat/markdown";
import { FileOpenContext, splitFileRef } from "../chat/fileRef";
import { formatRelative } from "../format";
import { useProjectT, type ProjectMessageKey } from "../i18n/project";
import { Icon } from "../panels/Icon";
import {
  areaCounts,
  compareObjectives,
  isBroken,
  layout,
  matches,
  openDecisions,
  progress,
  reach,
  relations,
  stage,
  type BoardFilter,
  type Relations,
  type Stage,
} from "./board";
import {
  DEFAULT_ISSUE_FILTER,
  duplicateIds,
  isBrokenModule,
  isOpen,
  issueEntries,
  issueIdPattern,
  issueMatches,
  issueSummary,
  issuesByObjective,
  type IssueEntry,
  type IssueFilter,
} from "./issues";
import { IssueDetail, IssueList, IssueNav } from "./IssuesView";
import { DetailSection, FilterChip } from "./parts";
import { NotesView, openInEditor, reachable, type BoardFile } from "./NotesView";
import { NameInput } from "./NameInput";
import { inVSCode } from "../vscode";

// A worker session as the board shows it.
export interface SessionInfo {
  name: string;
  state: "working" | "idle" | "archived";
}

const STATUSES: ObjectiveStatus[] = ["active", "later", "done", "dropped"];
const STATUS_KEY: Record<ObjectiveStatus, ProjectMessageKey> = {
  active: "statusActive",
  later: "statusLater",
  done: "statusDone",
  dropped: "statusDropped",
};
const PRIORITY_KEY: Record<Priority, ProjectMessageKey> = {
  high: "priorityHigh",
  normal: "priorityNormal",
  low: "priorityLow",
};
const STAGE_KEY: Record<Stage, ProjectMessageKey> = {
  blocked: "stageBlocked",
  ready: "stageReady",
  "in progress": "stageInProgress",
  review: "stageReview",
};
const TASK_STATE_KEY: Record<TaskState, ProjectMessageKey> = {
  todo: "taskTodo",
  doing: "taskDoing",
  review: "taskReview",
  done: "taskDone",
  dropped: "taskDropped",
};
const TASK_MARK: Record<TaskState, string> = {
  todo: "○",
  doing: "◐",
  review: "◎",
  done: "●",
  dropped: "⊘",
};

// Brings the element for `id` into view inside its scroller.
function reveal(root: HTMLElement | null, id: string | null): void {
  if (!root || !id) return;
  const el = [...root.querySelectorAll<HTMLElement>("[data-objective]")].find(
    (e) => e.dataset.objective === id,
  );
  el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

const NO_ISSUES: IssueEntry[] = [];
const NO_MODULES: IssueModules = [];

// The project's objectives on a page of their own: areas on the left, the
// objectives as cards or as a dependency graph in the middle, the selected
// one in full on the right, and the archive of finished ones; its issues
// the same way, a switch away. Read-only: the lead keeps the board, the
// user talks to it ("Ask the lead").
export const BoardPage = memo(function BoardPage({
  project,
  issues = NO_MODULES,
  sessions,
  onClose,
  onOpenSession,
  onAskLead,
  onRename,
  onArchive,
  onSeal,
  onDelete,
}: {
  project: Project;
  issues?: IssueModules;
  sessions: Map<string, SessionInfo>;
  onClose: () => void;
  onOpenSession: (workspaceId: string) => void;
  onAskLead: ((objectiveId: string) => void) | null;
  onRename: (name: string) => void;
  // File the project away (true) or bring it back (false).
  onArchive?: (archived: boolean) => void;
  onSeal?: () => void;
  onDelete: () => void;
}) {
  const tr = useProjectT();
  const [mode, setMode] = useState<"objectives" | "issues" | "notes">("objectives");
  const [noteFile, setNoteFile] = useState<BoardFile | null>(null);
  // Where the open file was opened from: closing it goes back there.
  const [fileFrom, setFileFrom] = useState<"objectives" | "issues" | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Bumped by every file opened and every step elsewhere: an answer from
  // VS Code that comes after the user moved on is dropped.
  const opening = useRef(0);
  // The details' scroll when a file was opened from them, to come back to.
  const returnScroll = useRef<number | null>(null);
  const [view, setView] = useState<"list" | "graph">("list");
  const [filter, setFilter] = useState<BoardFilter>({
    area: null,
    statuses: ["active", "later"],
    search: "",
    archive: false,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [issueFilter, setIssueFilter] = useState<IssueFilter>(DEFAULT_ISSUE_FILTER);
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  useEffect(() => {
    opening.current++;
  }, [mode, selected, selectedIssue, noteFile]);
  const pageRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const objectives = useMemo(
    () => project.objectives.filter((o): o is Objective => !isBroken(o)),
    [project.objectives],
  );
  const broken = project.objectives.filter(isBroken);
  const rel = useMemo(() => relations(objectives), [objectives]);
  const shown = useMemo(
    () => objectives.filter((o) => matches(o, filter)).sort(compareObjectives),
    [objectives, filter],
  );
  const current = objectives.find((o) => o.id === selected) ?? null;
  const onBoard = objectives.filter((o) => !o.archived);
  const counts = Object.fromEntries(
    STATUSES.map((s) => [s, onBoard.filter((o) => o.status === s).length]),
  ) as Record<ObjectiveStatus, number>;
  const archivedCount = objectives.length - onBoard.length;

  const modules = useMemo(
    () => issues.filter((m): m is IssueModule => !isBrokenModule(m)),
    [issues],
  );
  const brokenModules = issues.filter(isBrokenModule);
  const duplicates = useMemo(() => duplicateIds(issues), [issues]);
  const entries = useMemo(() => issueEntries(issues), [issues]);
  const byObjective = useMemo(() => issuesByObjective(entries), [entries]);
  const shownIssues = useMemo(
    () => entries.filter((e) => issueMatches(e, issueFilter)),
    [entries, issueFilter],
  );
  const currentIssue = entries.find((e) => e.issue.id === selectedIssue) ?? null;
  const issueFilterRef = useRef(issueFilter);
  issueFilterRef.current = issueFilter;
  const openIssues = entries.filter(isOpen).length;
  const issueRefs = useMemo<IssueRefs | null>(() => {
    const pattern = issueIdPattern(entries.map((e) => e.issue.id));
    return pattern
      ? {
          pattern,
          open: (id) => {
            const e = entries.find((x) => x.issue.id === id);
            setMode("issues");
            setSelectedIssue(id);
            // One the filter hides is shown with the defaults and its state.
            if (e && !issueMatches(e, issueFilterRef.current)) {
              setIssueFilter({
                ...DEFAULT_ISSUE_FILTER,
                states: [...new Set([...DEFAULT_ISSUE_FILTER.states, e.issue.state])],
              });
            }
          },
        }
      : null;
  }, [entries]);
  const openObjective = (id: string) => {
    const o = objectives.find((x) => x.id === id);
    setMode("objectives");
    setSelected(id);
    // One the filter hides is shown: its archive or its status, all areas.
    if (o && !matches(o, filter)) {
      setFilter({
        area: null,
        statuses: [...new Set([...filter.statuses, o.status])],
        search: "",
        archive: !!o.archived,
      });
    }
  };
  const detail = mode === "objectives" ? current : mode === "issues" ? currentIssue : null;

  // A file the board names: in VS Code when the panel is open in VS Code's
  // own browser, else (or when VS Code is not there) in the notes view.
  const editor = useMemo(() => inVSCode(), []);
  const showFile = useCallback((ref: string, notice?: string) => {
    const from = modeRef.current;
    if (from !== "notes") {
      setFileFrom(from);
      returnScroll.current = pageRef.current?.querySelector(".bp-detail")?.scrollTop ?? null;
    }
    setMode("notes");
    setNoteFile({ ...splitFileRef(ref), ...(notice && { notice }) });
  }, []);
  const openRef = useCallback(
    (ref: string) => {
      const n = ++opening.current;
      if (!editor) return showFile(ref);
      void openInEditor(project.id, splitFileRef(ref)).then((why) => {
        if (why === null || n !== opening.current) return;
        showFile(ref, why && tr("openFallbackNotice", { why }));
      });
    },
    [editor, project.id, showFile, tr],
  );
  const closeFile = () => {
    setNoteFile(null);
    if (fileFrom) setMode(fileFrom);
    else returnScroll.current = null;
    setFileFrom(null);
  };
  useLayoutEffect(() => {
    const detail = pageRef.current?.querySelector(".bp-detail");
    if (mode === "notes" || returnScroll.current === null || !detail) return;
    detail.scrollTop = returnScroll.current;
    returnScroll.current = null;
  }, [mode]);
  const choose = (m: typeof mode) => {
    setFileFrom(null);
    returnScroll.current = null;
    setMode(m);
  };
  const resolveFile = useCallback((path: string) => setNoteFile((f) => f && { ...f, path }), []);
  const sealed = project.status === "sealed";
  const accept = useCallback((path: string) => reachable(path, project.root), [project.root]);
  // Around the details and the notes: the issues and the files their text
  // names link.
  const links = (children: ReactNode) => (
    <IssueRefContext.Provider value={issueRefs}>
      <FileOpenContext.Provider value={openRef}>
        <ProsePathContext.Provider value={accept}>{children}</ProsePathContext.Provider>
      </FileOpenContext.Provider>
    </IssueRefContext.Provider>
  );

  // A selection whose objective is gone (deleted by the lead) is dropped, so
  // it neither swallows the next Escape nor comes back by itself.
  useEffect(() => {
    if (selected && !current) setSelected(null);
  }, [selected, current]);
  useEffect(() => {
    if (selectedIssue && !currentIssue) setSelectedIssue(null);
  }, [selectedIssue, currentIssue]);
  // So is the archive once its last objective is deleted: its filter goes
  // with it.
  useEffect(() => {
    if (filter.archive && archivedCount === 0) setFilter((f) => ({ ...f, archive: false }));
  }, [filter.archive, archivedCount]);

  // Focus moves into the page and goes back where it was on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    pageRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // A new view starts at its top-left, unless it opens on a selection: the
  // list (whose effects run first) has brought that into view.
  const opensOn = useRef(false);
  opensOn.current =
    mode === "issues"
      ? shownIssues.some((e) => e.issue.id === selectedIssue)
      : shown.some((o) => o.id === selected);
  useEffect(() => {
    if (!opensOn.current) mainRef.current?.scrollTo?.(0, 0);
  }, [mode, view, filter.archive]);

  // Escape steps back: clears the search, then leaves the details, then the
  // page. Not while composing text, and not for a dialog over the page.
  const showIssues = mode === "issues";
  const showNotes = mode === "notes";
  const state = useRef({
    issues: showIssues,
    notes: showNotes,
    file: !!noteFile,
    closeFile,
    selected,
    search: filter.search,
    onClose,
  });
  state.current = {
    issues: showIssues,
    notes: showNotes,
    file: !!noteFile,
    closeFile,
    selected: showIssues ? selectedIssue : selected,
    search: showIssues ? issueFilter.search : filter.search,
    onClose,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
      const target = e.target as Node | null;
      if (target instanceof Element && target.closest(".dialog-overlay")) return;
      const s = state.current;
      if (s.notes) {
        if (s.file) s.closeFile();
        else s.onClose();
      } else if (target === searchRef.current && s.search) {
        if (s.issues) setIssueFilter((f) => ({ ...f, search: "" }));
        else setFilter((f) => ({ ...f, search: "" }));
      } else if (s.selected) {
        if (s.issues) setSelectedIssue(null);
        else setSelected(null);
      } else {
        s.onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const toggleStatus = (s: ObjectiveStatus) =>
    setFilter((f) => ({
      ...f,
      statuses: f.statuses.includes(s) ? f.statuses.filter((x) => x !== s) : [...f.statuses, s],
    }));
  const inView = objectives.filter((o) => matches(o, { ...filter, area: null })).length;

  return (
    <div className="board-overlay" onClick={onClose}>
      <div
        ref={pageRef}
        className={`board-page${detail ? " has-detail" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={tr("boardDialogLabel", { name: project.name })}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={`bp-head${showNotes ? " no-search" : ""}`}>
          <ProjectName name={project.name} onRename={onRename} readOnly={sealed} />
          {sealed && (
            <span className="bp-sealed" title={project.sealedReason ?? undefined}>
              {tr("sealedBadge")}
            </span>
          )}
          <div className="bp-views bp-modes" role="group" aria-label={tr("showGroupLabel")}>
            <button
              aria-pressed={mode === "objectives"}
              {...telemetryTarget(mode !== "objectives" ? "panel.board" : undefined)}
              onClick={() => choose("objectives")}
            >
              {tr("tabObjectives")}
            </button>
            <button
              className="bp-mode-secondary"
              aria-pressed={showIssues}
              {...telemetryTarget(!showIssues ? "panel.issues" : undefined)}
              onClick={() => choose("issues")}
            >
              {tr("tabIssues")}
              {openIssues > 0 && <span className="bp-count">{openIssues}</span>}
            </button>
            <button
              className="bp-mode-secondary"
              aria-pressed={showNotes}
              {...telemetryTarget(!showNotes ? "panel.notes" : undefined)}
              onClick={() => choose("notes")}
            >
              {tr("tabNotes")}
            </button>
          </div>
          {!showNotes && (
            <span className="bp-summary">
              {showIssues
                ? tr("issuesSummary", {
                    open: entries.filter((e) => e.issue.state === "open").length,
                    decision: entries.filter((e) => e.issue.state === "decision").length,
                    accepted: entries.filter((e) => e.issue.state === "accepted").length,
                  })
                : tr("objectivesSummary", {
                    active: counts.active,
                    later: counts.later,
                    done: counts.done,
                  })}
            </span>
          )}
          {!showNotes && (
            <input
              ref={searchRef}
              className="bp-search"
              type="search"
              placeholder={
                showIssues ? tr("searchIssuesPlaceholder") : tr("searchObjectivesPlaceholder")
              }
              value={showIssues ? issueFilter.search : filter.search}
              onChange={(e) =>
                showIssues
                  ? setIssueFilter((f) => ({ ...f, search: e.target.value }))
                  : setFilter((f) => ({ ...f, search: e.target.value }))
              }
            />
          )}
          {mode === "objectives" && (
            <div className="bp-views" role="group" aria-label={tr("viewGroupLabel")}>
              <button aria-pressed={view === "list"} onClick={() => setView("list")}>
                {tr("viewList")}
              </button>
              <button aria-pressed={view === "graph"} onClick={() => setView("graph")}>
                {tr("viewDependencies")}
              </button>
            </div>
          )}
          <button
            className="side-panel-btn bp-close"
            aria-label={tr("closeLabel")}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>

        {showNotes ? (
          links(
            <NotesView
              project={project.id}
              file={noteFile}
              onOpen={(path) => {
                setFileFrom(null);
                returnScroll.current = null;
                setNoteFile({ path });
              }}
              onRef={openRef}
              onResolve={resolveFile}
              onClose={closeFile}
            />,
          )
        ) : showIssues ? (
          <div className="bp-body">
            <IssueNav
              modules={modules}
              entries={entries}
              filter={issueFilter}
              onFilter={setIssueFilter}
            />
            <main className="bp-main" ref={mainRef}>
              {brokenModules.map((b) => (
                <div key={b.id} className="bp-broken">
                  <strong>{b.id}.toml</strong> {tr("brokenFileSuffix", { error: b.error })}
                </div>
              ))}
              {duplicates.map((d) => (
                <div key={d.id} className="bp-broken">
                  <strong>{d.id}</strong>{" "}
                  {tr(d.modules.length === 1 ? "duplicateIssueTwice" : "duplicateIssueMultiple", {
                    modules: d.modules.join(tr("listAnd")),
                  })}
                </div>
              ))}
              {entries.length === 0 ? (
                brokenModules.length === 0 && <div className="bp-empty">{tr("emptyIssues")}</div>
              ) : shownIssues.length === 0 ? (
                <div className="bp-empty">{tr("nothingMatches")}</div>
              ) : (
                links(
                  <IssueList
                    shown={shownIssues}
                    grouped={issueFilter.module === null}
                    selected={selectedIssue}
                    onSelect={setSelectedIssue}
                  />,
                )
              )}
            </main>
            {currentIssue &&
              links(
                <IssueDetail
                  key={currentIssue.issue.id}
                  entry={currentIssue}
                  objectives={objectives}
                  onSelectObjective={openObjective}
                  onClose={() => setSelectedIssue(null)}
                />,
              )}
          </div>
        ) : (
          <div className="bp-body">
            <nav className="bp-nav" aria-label={tr("filtersLabel")}>
              <div className="bp-areas">
                <button
                  className={`bp-area${filter.area === null ? " active" : ""}`}
                  onClick={() => setFilter((f) => ({ ...f, area: null }))}
                >
                  <span className="bp-area-name">{tr("allAreas")}</span>
                  <span className="bp-count">{inView}</span>
                </button>
                {areaCounts(objectives, filter).map((a) => (
                  <button
                    key={a.area}
                    className={`bp-area${filter.area === a.area ? " active" : ""}${a.count ? "" : " empty"}`}
                    onClick={() => setFilter((f) => ({ ...f, area: a.area }))}
                  >
                    <span className="bp-area-name">{a.area}</span>
                    <span className="bp-count">{a.count}</span>
                  </button>
                ))}
              </div>
              <div className="bp-filters">
                <div className="bp-statuses" role="group" aria-label={tr("statusGroupLabel")}>
                  {STATUSES.map((s) => (
                    <FilterChip
                      key={s}
                      label={tr(STATUS_KEY[s])}
                      count={counts[s]}
                      pressed={!filter.archive && filter.statuses.includes(s)}
                      disabled={filter.archive}
                      onClick={() => toggleStatus(s)}
                    />
                  ))}
                  {archivedCount > 0 && (
                    <FilterChip
                      className="bp-archive-toggle"
                      label={tr("archiveFilterLabel")}
                      count={archivedCount}
                      pressed={filter.archive}
                      onClick={() => {
                        setSelected(null);
                        setFilter((f) => ({ ...f, archive: !f.archive }));
                      }}
                    />
                  )}
                </div>
              </div>
              {onArchive && !sealed && (
                <button className="bp-archive" onClick={() => onArchive(!project.archivedAt)}>
                  {project.archivedAt ? tr("restoreProject") : tr("archiveProject")}
                </button>
              )}
              {onSeal && !sealed && (
                <button className="bp-archive bp-seal" onClick={onSeal}>
                  {tr("sealProject")}
                </button>
              )}
              {!sealed && (
                <button className="bp-delete" onClick={onDelete}>
                  {tr("deleteProject")}
                </button>
              )}
            </nav>

            <main className="bp-main" ref={mainRef}>
              {!filter.archive &&
                broken.map((b) => (
                  <div key={b.id} className="bp-broken">
                    <strong>{b.id}.toml</strong> {tr("brokenFileSuffix", { error: b.error })}
                  </div>
                ))}
              {objectives.length === 0 ? (
                broken.length === 0 && <div className="bp-empty">{tr("emptyObjectives")}</div>
              ) : shown.length === 0 ? (
                <div className="bp-empty">
                  {filter.archive && !filter.search && !filter.area
                    ? tr("nothingArchived")
                    : tr("nothingMatches")}
                </div>
              ) : view === "list" || filter.archive ? (
                <ObjectiveList
                  objectives={shown}
                  rel={rel}
                  grouped={filter.area === null}
                  selected={selected}
                  sessions={sessions}
                  issues={byObjective}
                  onSelect={setSelected}
                />
              ) : (
                <DependencyGraph
                  objectives={shown}
                  rel={rel}
                  selected={selected}
                  onSelect={setSelected}
                />
              )}
            </main>

            {current &&
              links(
                <ObjectiveDetail
                  key={current.id}
                  objective={current}
                  all={objectives}
                  rel={rel.get(current.id)!}
                  sessions={sessions}
                  issues={byObjective.get(current.id) ?? NO_ISSUES}
                  onSelect={setSelected}
                  onClose={() => setSelected(null)}
                  onOpenSession={onOpenSession}
                  onOpenIssue={(id) => issueRefs?.open(id)}
                  onAskLead={sealed ? null : onAskLead}
                />,
              )}
          </div>
        )}
      </div>
    </div>
  );
});

function ObjectiveList({
  objectives,
  rel,
  grouped,
  selected,
  sessions,
  issues,
  onSelect,
}: {
  objectives: Objective[];
  rel: Map<string, Relations>;
  grouped: boolean;
  selected: string | null;
  sessions: Map<string, SessionInfo>;
  issues: Map<string, IssueEntry[]>;
  onSelect: (id: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => reveal(boxRef.current, selected), [selected]);
  const groups = grouped
    ? [...new Set(objectives.map((o) => o.area))]
        .sort()
        .map((area) => ({ area, items: objectives.filter((o) => o.area === area) }))
    : [{ area: null, items: objectives }];
  return (
    <div ref={boxRef}>
      {groups.map((g) => (
        <section key={g.area ?? ""} className="bp-group">
          {g.area && <h3 className="bp-group-title">{g.area}</h3>}
          <div className="bp-cards">
            {g.items.map((o) => (
              <ObjectiveCard
                key={o.id}
                objective={o}
                rel={rel.get(o.id)!}
                selected={o.id === selected}
                sessions={sessions}
                openIssues={issues.get(o.id)?.filter(isOpen).length ?? 0}
                onSelect={onSelect}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ObjectiveCard({
  objective: o,
  rel,
  selected,
  sessions,
  openIssues,
  onSelect,
}: {
  objective: Objective;
  rel: Relations;
  selected: boolean;
  sessions: Map<string, SessionInfo>;
  openIssues: number;
  onSelect: (id: string) => void;
}) {
  const tr = useProjectT();
  const { done, total } = progress(o);
  const toDecide = openDecisions(o);
  const st = o.archived ? null : stage(o, rel);
  const live = o.sessions.filter((s) => sessions.get(s)?.state === "working");
  return (
    <button
      data-objective={o.id}
      className={`bp-card prio-${o.priority} st-${o.status}${selected ? " selected" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(o.id)}
    >
      <span className="bp-card-top">
        <span className="bp-id">{o.id}</span>
        {o.priority !== "normal" && (
          <span className={`bp-prio prio-${o.priority}`}>{tr(PRIORITY_KEY[o.priority])}</span>
        )}
        {o.status !== "active" && (
          <span className={`bp-pill st-${o.status}`}>{tr(STATUS_KEY[o.status])}</span>
        )}
      </span>
      <span className="bp-card-title">
        <InlineMd>{o.title}</InlineMd>
      </span>
      {o.goal && (
        <span className="bp-card-goal">
          <InlineMd>{o.goal}</InlineMd>
        </span>
      )}
      {o.reason && o.status !== "active" && <span className="bp-card-reason">{o.reason}</span>}
      <span className="bp-card-foot">
        {total > 0 && (
          <span className="bp-progress" title={tr("tasksProgressTitle", { done, total })}>
            <span className="bp-bar">
              <span style={{ width: `${(done / total) * 100}%` }} />
            </span>
            {done}/{total}
          </span>
        )}
        {toDecide > 0 && !o.archived && (
          <span className="bp-decide">{tr("toDecideCount", { count: toDecide })}</span>
        )}
        {openIssues > 0 && !o.archived && (
          <span className="bi-count">
            {tr(openIssues === 1 ? "issueCountOne" : "issueCountMany", { count: openIssues })}
          </span>
        )}
        {st && (
          <span className={`bp-stage stage-${st.replace(" ", "-")}`}>
            {st === "blocked"
              ? tr("stageBlockedBy", { count: rel.blockedBy.length })
              : tr(STAGE_KEY[st])}
          </span>
        )}
        {o.archived && (
          <span className="bp-updated">
            {tr("archivedRelative", { time: formatRelative(o.updatedAt) })}
          </span>
        )}
        {live.length > 0 && (
          <span className="bp-live" title={live.map((s) => sessions.get(s)!.name).join(", ")}>
            <span className="streaming-dot" /> {live.length}
          </span>
        )}
      </span>
    </button>
  );
}

type Edge = { from: string; to: string; d: string };

// Columns left to right by depth of prerequisites, rows ordered to keep
// connected objectives close; edges from each prerequisite to what needs
// it. Selecting or hovering an objective lights up everything it waits on
// and everything waiting on it; those edges are drawn over the nodes.
function DependencyGraph({
  objectives,
  rel,
  selected,
  onSelect,
}: {
  objectives: Objective[];
  rel: Map<string, Relations>;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const tr = useProjectT();
  const { columns, independent } = useMemo(() => layout(objectives), [objectives]);
  const shownIds = useMemo(() => new Set(objectives.map((o) => o.id)), [objectives]);
  const [focus, setFocus] = useState<string | null>(null);
  const candidate = focus ?? selected;
  const lit = candidate && shownIds.has(candidate) ? candidate : null;
  const up = useMemo(() => (lit ? reach(objectives, lit, "up") : null), [objectives, lit]);
  const down = useMemo(() => (lit ? reach(objectives, lit, "down") : null), [objectives, lit]);
  const boxRef = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [edges, setEdges] = useState<Edge[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const measure = () => {
      const box = boxRef.current;
      if (!box) return;
      const origin = box.getBoundingClientRect();
      const at = (id: string) => nodes.current.get(id)?.getBoundingClientRect();
      const next: Edge[] = [];
      for (const o of objectives) {
        for (const dep of o.dependsOn) {
          if (!shownIds.has(dep)) continue;
          const a = at(dep);
          const b = at(o.id);
          if (!a || !b) continue;
          const x1 = a.right - origin.left;
          const y1 = a.top + a.height / 2 - origin.top;
          const x2 = b.left - origin.left;
          const y2 = b.top + b.height / 2 - origin.top;
          const bend = Math.max(24, (x2 - x1) / 2);
          next.push({
            from: dep,
            to: o.id,
            d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`,
          });
        }
      }
      setEdges(next);
      setSize({ w: box.scrollWidth, h: box.scrollHeight });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (boxRef.current) observer?.observe(boxRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [objectives, columns, independent, shownIds]);

  useEffect(() => reveal(boxRef.current, selected), [selected]);

  // An edge on the chain of prerequisites of the lit objective, or on the
  // chain of what waits on it.
  const edgeClass = (e: { from: string; to: string }) => {
    if (!lit) return "";
    if (up?.has(e.from) && (e.to === lit || up.has(e.to))) return "up";
    if (down?.has(e.to) && (e.from === lit || down.has(e.from))) return "down";
    return "dim";
  };
  const nodeClass = (id: string) => {
    if (!lit) return "";
    if (id === lit) return " lit";
    if (up?.has(id)) return " up";
    if (down?.has(id)) return " down";
    return " dim";
  };
  const node = (o: Objective) => {
    const st = stage(o, rel.get(o.id)!);
    const hidden = o.dependsOn.filter((d) => !shownIds.has(d));
    return (
      <button
        key={o.id}
        data-objective={o.id}
        ref={(el) => {
          if (el) nodes.current.set(o.id, el);
          else nodes.current.delete(o.id);
        }}
        className={`bp-node prio-${o.priority} st-${o.status}${nodeClass(o.id)}${o.id === selected ? " selected" : ""}`}
        onClick={() => onSelect(o.id)}
        // A tap raises pointer enter but never leave: hover is for mice.
        onPointerEnter={(e) => e.pointerType === "mouse" && setFocus(o.id)}
        onPointerLeave={(e) => e.pointerType === "mouse" && setFocus(null)}
      >
        <span className="bp-node-title">
          <InlineMd>{o.title}</InlineMd>
        </span>
        <span className="bp-node-meta">
          {o.id}
          {st && (
            <span className={`bp-stage stage-${st.replace(" ", "-")}`}>{tr(STAGE_KEY[st])}</span>
          )}
          {o.status !== "active" && (
            <span className={`bp-pill st-${o.status}`}>{tr(STATUS_KEY[o.status])}</span>
          )}
          {hidden.length > 0 && (
            <span className="bp-hidden" title={tr("notShownTitle", { ids: hidden.join(", ") })}>
              {tr("notShownBadge", { count: hidden.length })}
            </span>
          )}
        </span>
      </button>
    );
  };
  const lines = (layer: "under" | "over") => (
    <svg className={`bp-edges ${layer}`} width={size.w} height={size.h} aria-hidden="true">
      {edges
        .filter((e) => (layer === "over") === ["up", "down"].includes(edgeClass(e)))
        .map((e) => (
          <path key={`${e.from}>${e.to}`} className={edgeClass(e)} d={e.d} />
        ))}
    </svg>
  );

  return (
    <div className="bp-graph" ref={boxRef}>
      {lines("under")}
      {columns.map((col, i) => (
        <div key={i} className="bp-column">
          <div className="bp-column-title">{tr("graphStepColumn", { step: i + 1 })}</div>
          {col.map(node)}
        </div>
      ))}
      {independent.length > 0 && (
        <div className="bp-column bp-independent">
          <div className="bp-column-title">{tr("graphIndependentColumn")}</div>
          {independent.map(node)}
        </div>
      )}
      {lines("over")}
    </div>
  );
}

function ObjectiveDetail({
  objective: o,
  all,
  rel,
  sessions,
  issues,
  onSelect,
  onClose,
  onOpenSession,
  onOpenIssue,
  onAskLead,
}: {
  objective: Objective;
  all: Objective[];
  rel: Relations;
  sessions: Map<string, SessionInfo>;
  // Linked to it, by the issue, its group or its module.
  issues: IssueEntry[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpenSession: (workspaceId: string) => void;
  onOpenIssue: (id: string) => void;
  onAskLead: ((objectiveId: string) => void) | null;
}) {
  const tr = useProjectT();
  const self = useRef<HTMLElement>(null);
  // Opened from one of its own links, the details replace the button that
  // had focus: the keyboard goes on from the new details, not the page.
  useEffect(() => {
    if (document.activeElement === document.body) self.current?.focus({ preventScroll: true });
  }, []);
  const byId = new Map(all.map((x) => [x.id, x]));
  const { done, total } = progress(o);
  const open = o.decisions.filter((d) => !d.outcome);
  const settled = o.decisions.filter((d) => d.outcome);
  // Dropped and kept as its title and the reason only.
  const kept =
    o.status === "dropped" && !o.goal && o.tasks.length === 0 && o.dependsOn.length === 0;
  const ref = (id: string) => {
    const target = byId.get(id);
    if (!target) {
      return (
        <span key={id} className="bp-ref missing" title={tr("notAnObjective")}>
          <span className="clip">{id}</span>
        </span>
      );
    }
    const note = target.archived ? tr("archivedParen") : "";
    return (
      <button
        key={id}
        className={`bp-ref st-${target.status}${rel.blockedBy.includes(id) ? " blocking" : ""}`}
        onClick={() => onSelect(id)}
        title={tr("objectiveRefTitle", {
          status: tr(STATUS_KEY[target.status]),
          note,
          detail: target.goal || target.reason || "",
        })}
      >
        {/* A button holds no links of its own. */}
        <NoLinks>
          <span className="clip">
            <InlineMd>{target.title}</InlineMd>
          </span>
        </NoLinks>
      </button>
    );
  };
  const openIssues = issues.filter(isOpen);
  const accepted = issues.length - openIssues.length;
  const session = (id: string) => {
    const s = sessions.get(id);
    if (!s) return null;
    return (
      <button
        key={id}
        className={`bp-session ss-${s.state}`}
        title={s.name}
        onClick={() => onOpenSession(id)}
      >
        <span className="bp-session-dot" />
        <span className="clip">{s.name}</span>
      </button>
    );
  };

  return (
    <aside ref={self} tabIndex={-1} className="bp-detail" aria-label={o.title}>
      <div className="bp-detail-head">
        <button className="bp-back" aria-label={tr("backLabel")} onClick={onClose}>
          ‹
        </button>
        <span className="bp-id">{o.id}</span>
        {onAskLead && (
          <button className="bp-ask" onClick={() => onAskLead(o.id)}>
            {tr("askLead")}
          </button>
        )}
        <button
          className="side-panel-btn bp-close bp-detail-close"
          aria-label={tr("closeDetailsLabel")}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <h2 className="bp-detail-title">
        <InlineMd>{o.title}</InlineMd>
      </h2>
      <div className="bp-meta">
        <span className={`bp-pill st-${o.status}`}>{tr(STATUS_KEY[o.status])}</span>
        {o.archived && <span className="bp-pill">{tr("archivedPill")}</span>}
        <span className={`bp-prio prio-${o.priority}`}>
          {tr("priorityDetail", { priority: tr(PRIORITY_KEY[o.priority]) })}
        </span>
        <span className="bp-updated">
          {tr("updatedRelative", { time: formatRelative(o.updatedAt) })}
        </span>
      </div>
      {o.reason && (
        <p className="bp-reason">
          <InlineMd>{o.reason}</InlineMd>
        </p>
      )}

      {o.goal && (
        <DetailSection title={tr("sectionGoal")}>
          <p className="bp-goal">
            <InlineMd>{o.goal}</InlineMd>
          </p>
        </DetailSection>
      )}

      {!kept && (
        <DetailSection title={tr("sectionDependsOn")}>
          {o.dependsOn.length ? (
            <div className="bp-refs">{o.dependsOn.map(ref)}</div>
          ) : (
            <p className="bp-none">{tr("noDependencies")}</p>
          )}
        </DetailSection>
      )}
      {rel.unblocks.length > 0 && (
        <DetailSection title={tr("sectionNeededBy")}>
          <div className="bp-refs">{rel.unblocks.map(ref)}</div>
        </DetailSection>
      )}

      {o.context && (
        <DetailSection title={tr("sectionWhereItStands")}>
          <div className="message-content bp-md">
            <MdBlock>{o.context}</MdBlock>
          </div>
          {o.contextWritten !== undefined && (
            <p className="bp-updated bp-written">
              {o.contextCommit
                ? tr("writtenRelativeAt", {
                    time: formatRelative(o.contextWritten),
                    commit: o.contextCommit,
                  })
                : tr("writtenRelative", { time: formatRelative(o.contextWritten) })}
            </p>
          )}
        </DetailSection>
      )}

      {!kept && (
        <DetailSection
          title={total ? tr("sectionTasksProgress", { done, total }) : tr("sectionTasks")}
        >
          {o.tasks.length ? (
            <ul className="bp-tasks">
              {o.tasks.map((t) => (
                <li key={t.id} className={`task-${t.state}`}>
                  <span className="bp-task-mark" title={tr(TASK_STATE_KEY[t.state])}>
                    {TASK_MARK[t.state]}
                  </span>
                  <span className="bp-task-text">
                    <InlineMd>{t.text}</InlineMd>
                  </span>
                  {t.session && session(t.session)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="bp-none">{tr("noTasks")}</p>
          )}
        </DetailSection>
      )}

      {open.length > 0 && (
        <DetailSection title={tr("sectionToDecide", { count: open.length })}>
          <ul className="bp-decisions open">
            {open.map((d) => (
              <li key={d.id}>
                <InlineMd>{d.question}</InlineMd>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}
      {settled.length > 0 && (
        <DetailSection title={tr("sectionSettled")}>
          <ul className="bp-decisions">
            {settled.map((d) => (
              <li key={d.id}>
                <span className="bp-question">
                  <InlineMd>{d.question}</InlineMd>
                </span>
                <span className="bp-outcome">
                  <InlineMd>{d.outcome ?? ""}</InlineMd>
                </span>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      {issues.length > 0 && (
        <DetailSection title={tr("sectionIssuesOpen", { count: openIssues.length })}>
          {openIssues.length > 0 && (
            <ul className="bi-linked">
              {openIssues.map((e) => (
                <li key={e.issue.id}>
                  <button
                    className={`bi-ref is-${e.issue.state}`}
                    onClick={() => onOpenIssue(e.issue.id)}
                  >
                    <span className="bp-id">{e.issue.id}</span>
                    <NoLinks>
                      <span className="bi-ref-text">
                        <InlineMd>{issueSummary(e.issue.text)}</InlineMd>
                      </span>
                    </NoLinks>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {accepted > 0 && (
            <p className="bp-none">{tr("acceptedIssuesNote", { count: accepted })}</p>
          )}
        </DetailSection>
      )}

      {o.sessions.some((s) => sessions.has(s)) && (
        <DetailSection title={tr("sectionSessions")}>
          <div className="bp-refs">{o.sessions.map(session)}</div>
        </DetailSection>
      )}
      {o.notes && (
        <DetailSection title={tr("sectionNotes")}>
          <div className="message-content bp-md">
            <MdBlock>{o.notes}</MdBlock>
          </div>
        </DetailSection>
      )}
    </aside>
  );
}

function ProjectName({
  name,
  onRename,
  readOnly = false,
}: {
  name: string;
  onRename: (name: string) => void;
  readOnly?: boolean;
}) {
  const tr = useProjectT();
  const [editing, setEditing] = useState(false);
  if (readOnly) return <span className="bp-name">{name}</span>;
  if (!editing) {
    return (
      <button className="bp-name" title={tr("renameTitle")} onClick={() => setEditing(true)}>
        {name}
      </button>
    );
  }
  return (
    <NameInput
      name={name}
      label={tr("projectNameLabel")}
      className="bp-name-input"
      onDone={(renamed) => {
        setEditing(false);
        if (renamed) onRename(renamed);
      }}
    />
  );
}
