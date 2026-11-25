import { useWorkspaceT } from "../i18n/workspace";
import type { GitInfo, PrInfo } from "../state/useServer";

// Branch, working-tree and PR summary for the workspace header.
export function GitBar({ git, pr }: { git: GitInfo | null; pr: PrInfo | null }) {
  const tr = useWorkspaceT();
  if (!git?.branch && !pr) return null;
  const dirtyTitle = git
    ? [
        git.dirty
          ? tr(git.dirty === 1 ? "gitDirtyFile" : "gitDirtyFiles", { count: git.dirty })
          : tr("gitClean"),
        git.ahead ? tr("gitAheadUpstream", { count: git.ahead }) : "",
        git.behind ? tr("gitBehindUpstream", { count: git.behind }) : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const prState = pr
    ? pr.state === "merged"
      ? "merged"
      : pr.state === "closed"
        ? "closed"
        : pr.draft
          ? "draft"
          : "open"
    : null;
  const prLabel =
    prState === "merged"
      ? tr("prMerged")
      : prState === "closed"
        ? tr("prClosed")
        : prState === "draft"
          ? tr("prDraft")
          : prState === "open"
            ? tr("prOpen")
            : null;
  const prChecks =
    pr?.checks === "success"
      ? tr("prCheckSuccess")
      : pr?.checks === "failure"
        ? tr("prCheckFailure")
        : pr?.checks === "pending"
          ? tr("prCheckPending")
          : null;
  return (
    <>
      {git?.branch && (
        <span className="ws-info-item ws-info-branch" title={dirtyTitle}>
          <span className="ws-info-icon">&#9831;</span>
          <span className="ws-branch-name">{git.branch}</span>
          {git.dirty > 0 && <span className="git-badge git-dirty">●{git.dirty}</span>}
          {git.ahead > 0 && <span className="git-badge git-ahead">↑{git.ahead}</span>}
          {git.behind > 0 && <span className="git-badge git-behind">↓{git.behind}</span>}
        </span>
      )}
      {pr && (
        <a
          className={`pr-card pr-${prState}`}
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          title={tr("prTitleTooltip", {
            title: pr.title,
            state: prLabel ?? "",
            checks: prChecks ? tr("prChecksDetail", { checks: prChecks }) : "",
          })}
        >
          <span className="pr-number">#{pr.number}</span>
          {pr.title && <span className="pr-title">{pr.title}</span>}
          <span className="pr-state">{prLabel}</span>
          {pr.checks && <span className={`pr-checks pr-checks-${pr.checks}`} />}
        </a>
      )}
    </>
  );
}
