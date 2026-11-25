import { useWorkspaceT } from "../i18n/workspace";
import type { ProjectLink } from "../state/useServer";

// Whether a project session reports to the lead, as the user switches it.
// The lead itself has no switch.
export function ReportSwitch({
  link,
  onSet,
  className = "btn-ghost ws-report-btn",
}: {
  link?: ProjectLink;
  onSet: (reports: boolean) => void;
  className?: string;
}) {
  const tr = useWorkspaceT();
  if (link?.role !== "worker") return null;
  const reports = !link.unreported;
  return (
    <button
      className={`${className} report-switch${reports ? " on" : ""}`}
      aria-pressed={reports}
      title={reports ? tr("reportsToLeadTitle") : tr("notReportingTitle")}
      onClick={() => onSet(!reports)}
    >
      {reports ? tr("reportsToLead") : tr("notReporting")}
    </button>
  );
}
