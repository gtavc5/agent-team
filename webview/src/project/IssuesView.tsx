import { useEffect, useRef } from "react";
import type { Evidence, IssueModule, IssueState, Objective } from "../state/useServer";
import { InlineMd, MdBlock, NoLinks } from "../chat/markdown";
import { Icon } from "../panels/Icon";
import { formatRelative } from "../format";
import { tProject, useProjectT, type ProjectMessageKey } from "../i18n/project";
import {
  issueMatches,
  issueSummary,
  linkedObjectives,
  moduleCounts,
  tagCounts,
  type IssueEntry,
  type IssueFilter,
} from "./issues";
import { DetailSection, FilterChip } from "./parts";

// The project's issues on the board page: modules and filters on the left,
// the issues by module and group in the middle, the selected one in full on
// the right. Read-only, like the objectives.

export const ISSUE_STATES: IssueState[] = ["open", "decision", "accepted"];
const ISSUE_STATE_KEY: Record<IssueState, ProjectMessageKey> = {
  open: "issueStateOpen",
  decision: "issueStateDecision",
  accepted: "issueStateAccepted",
};
export const ISSUE_STATE_LABEL: Record<IssueState, string> = {
  open: tProject("issueStateOpen", undefined, "en"),
  decision: tProject("issueStateDecision", undefined, "en"),
  accepted: tProject("issueStateAccepted", undefined, "en"),
};
const EVIDENCE: Evidence[] = ["R", "V", "H", "S", "C"];
const EVIDENCE_KEY: Record<Evidence, ProjectMessageKey> = {
  R: "evidenceR",
  V: "evidenceV",
  H: "evidenceH",
  S: "evidenceS",
  C: "evidenceC",
};

// A module's title up to its parenthesised scope: "Hosting (hosting.cpp)".
function shortTitle(m: IssueModule): string {
  return m.title.split(/\s*[（(]/)[0] || m.title;
}

function toggle<T>(list: T[], x: T): T[] {
  return list.includes(x) ? list.filter((y) => y !== x) : [...list, x];
}

export function IssueNav({
  modules,
  entries,
  filter,
  onFilter,
}: {
  modules: IssueModule[];
  entries: IssueEntry[];
  filter: IssueFilter;
  onFilter: (f: IssueFilter) => void;
}) {
  const tr = useProjectT();
  // Each number is the rows the filter it stands on gives with the others.
  const count = (f: IssueFilter) => entries.filter((e) => issueMatches(e, f)).length;
  const inView = count({ ...filter, module: null });
  const tags = tagCounts(entries, filter);
  return (
    <nav className="bp-nav" aria-label={tr("issueFiltersLabel")}>
      <div className="bp-areas">
        <button
          className={`bp-area${filter.module === null ? " active" : ""}`}
          onClick={() => onFilter({ ...filter, module: null })}
        >
          <span className="bp-area-name">{tr("allModules")}</span>
          <span className="bp-count">{inView}</span>
        </button>
        {moduleCounts(modules, entries, filter).map(({ module: m, count: n }) => (
          <button
            key={m.id}
            className={`bp-area${filter.module === m.id ? " active" : ""}${n ? "" : " empty"}`}
            title={`${m.id}: ${m.title}`}
            onClick={() => onFilter({ ...filter, module: m.id })}
          >
            <span className="bp-area-name">{shortTitle(m)}</span>
            <span className="bp-count">{n}</span>
          </button>
        ))}
      </div>
      <div className="bp-filters">
        <div className="bp-statuses" role="group" aria-label={tr("issueStateGroupLabel")}>
          {ISSUE_STATES.map((s) => (
            <FilterChip
              key={s}
              label={tr(ISSUE_STATE_KEY[s])}
              count={count({ ...filter, states: [s] })}
              pressed={filter.states.includes(s)}
              onClick={() => onFilter({ ...filter, states: toggle(filter.states, s) })}
            />
          ))}
        </div>
        <div className="bp-chips" role="group" aria-label={tr("issueEvidenceGroupLabel")}>
          {EVIDENCE.map((ev) => (
            <FilterChip
              key={ev}
              label={<span className={`bi-ev ev-${ev}`}>{ev}</span>}
              count={count({ ...filter, evidence: [ev] })}
              pressed={filter.evidence.includes(ev)}
              title={tr(EVIDENCE_KEY[ev])}
              onClick={() => onFilter({ ...filter, evidence: toggle(filter.evidence, ev) })}
            />
          ))}
        </div>
        {tags.length > 0 && (
          <div className="bp-chips" role="group" aria-label={tr("issueTagsGroupLabel")}>
            {tags.map(({ tag, count: n }) => (
              <FilterChip
                key={tag}
                label={tag}
                count={n}
                pressed={filter.tags.includes(tag)}
                onClick={() => onFilter({ ...filter, tags: toggle(filter.tags, tag) })}
              />
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}

export function IssueList({
  shown,
  grouped,
  selected,
  onSelect,
}: {
  shown: IssueEntry[];
  // All modules: each under its title.
  grouped: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return;
    const el = [...(boxRef.current?.querySelectorAll<HTMLElement>("[data-issue]") ?? [])].find(
      (e) => e.dataset.issue === selected,
    );
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const modules = [...new Set(shown.map((e) => e.module))];
  return (
    <div ref={boxRef}>
      {modules.map((m) => {
        const mine = shown.filter((e) => e.module === m);
        const groups = [...new Set(mine.map((e) => e.group))];
        return (
          <section key={m.id} className="bp-group">
            {grouped && (
              <h3 className="bp-group-title bi-module-title" title={m.id}>
                {m.title}
              </h3>
            )}
            {m.notes && (
              <p className="bi-group-notes bi-module-notes">
                <InlineMd>{issueSummary(m.notes)}</InlineMd>
              </p>
            )}
            {groups.map((g) => (
              <div key={g?.id ?? ""} className="bi-group">
                {g && (
                  <div className="bi-group-head">
                    <h4 className="bi-group-title">{g.title}</h4>
                    {g.notes && (
                      <p className="bi-group-notes">
                        <InlineMd>{issueSummary(g.notes)}</InlineMd>
                      </p>
                    )}
                  </div>
                )}
                <div className="bi-rows">
                  {mine
                    .filter((e) => e.group === g)
                    .map((e) => (
                      <IssueRow
                        key={e.issue.id}
                        entry={e}
                        selected={e.issue.id === selected}
                        onSelect={onSelect}
                      />
                    ))}
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function IssueRow({
  entry: { issue: x },
  selected,
  onSelect,
}: {
  entry: IssueEntry;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const tr = useProjectT();
  return (
    <button
      data-issue={x.id}
      className={`bi-row is-${x.state}${selected ? " selected" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(x.id)}
    >
      <span className="bi-row-top">
        <span className="bp-id">{x.id}</span>
        {x.evidence && (
          <span className={`bi-evidence ev-${x.evidence}`} title={tr(EVIDENCE_KEY[x.evidence])}>
            {x.evidence}
          </span>
        )}
        {x.state !== "open" && (
          <span className={`bp-pill is-${x.state}`}>{tr(ISSUE_STATE_KEY[x.state])}</span>
        )}
        {x.tags.map((t) => (
          <span key={t} className="bi-tag">
            {t}
          </span>
        ))}
      </span>
      <span className="bi-row-text">
        <NoLinks>
          <InlineMd>{issueSummary(x.text)}</InlineMd>
        </NoLinks>
      </span>
    </button>
  );
}

export function IssueDetail({
  entry: e,
  objectives,
  onSelectObjective,
  onClose,
}: {
  entry: IssueEntry;
  objectives: Objective[];
  onSelectObjective: (id: string) => void;
  onClose: () => void;
}) {
  const tr = useProjectT();
  const self = useRef<HTMLElement>(null);
  useEffect(() => {
    if (document.activeElement === document.body) self.current?.focus({ preventScroll: true });
  }, []);
  const x = e.issue;
  const byId = new Map(objectives.map((o) => [o.id, o]));
  const linked = linkedObjectives(e);
  return (
    <aside
      ref={self}
      tabIndex={-1}
      className="bp-detail"
      aria-label={tr("issueDetailLabel", { id: x.id })}
    >
      <div className="bp-detail-head">
        <button className="bp-back" aria-label={tr("backLabel")} onClick={onClose}>
          ‹
        </button>
        <span className="bp-id">{x.id}</span>
        <button
          className="side-panel-btn bp-close bp-detail-close"
          aria-label={tr("closeDetailsLabel")}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="bp-meta bi-meta">
        <span className={`bp-pill is-${x.state}`}>{tr(ISSUE_STATE_KEY[x.state])}</span>
        {x.evidence && (
          <span className={`bi-evidence ev-${x.evidence}`}>
            {x.evidence} · {tr(EVIDENCE_KEY[x.evidence])}
          </span>
        )}
        {x.tags.map((t) => (
          <span key={t} className="bi-tag">
            {t}
          </span>
        ))}
        {x.written !== undefined && (
          <span className="bp-updated">
            {x.commit
              ? tr("writtenRelativeAt", { time: formatRelative(x.written), commit: x.commit })
              : tr("writtenRelative", { time: formatRelative(x.written) })}
          </span>
        )}
      </div>
      <p className="bi-where" title={e.module.id}>
        {e.module.title}
        {e.group && <> › {e.group.title}</>}
      </p>
      <div className="message-content bp-md">
        <MdBlock>{x.text}</MdBlock>
      </div>
      {e.group?.notes && (
        <DetailSection title={tr("sectionIssueGroupNotes")}>
          <div className="message-content bp-md">
            <MdBlock>{e.group.notes}</MdBlock>
          </div>
        </DetailSection>
      )}
      {e.module.notes && (
        <DetailSection title={tr("sectionIssueModuleNotes")}>
          <div className="message-content bp-md">
            <MdBlock>{e.module.notes}</MdBlock>
          </div>
        </DetailSection>
      )}
      <DetailSection title={tr("sectionObjectives")}>
        {linked.length ? (
          <div className="bp-refs">
            {linked.map((id) => {
              const o = byId.get(id);
              return o ? (
                <button
                  key={id}
                  className={`bp-ref st-${o.status}`}
                  title={o.goal || o.reason}
                  onClick={() => onSelectObjective(id)}
                >
                  {/* A button holds no links of its own. */}
                  <NoLinks>
                    <span className="clip">
                      <InlineMd>{o.title}</InlineMd>
                    </span>
                  </NoLinks>
                </button>
              ) : (
                <span key={id} className="bp-ref missing" title={tr("notAnObjective")}>
                  <span className="clip">{id}</span>
                </span>
              );
            })}
          </div>
        ) : (
          <p className="bp-none">{tr("noLinkedObjectives")}</p>
        )}
      </DetailSection>
    </aside>
  );
}
