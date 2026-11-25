import { useWorkspaceT } from "../i18n/workspace";
import type { ProjectLink } from "../state/useServer";

// A project session's role beside its name: the lead, or a worker kept to
// its own task. `name` already saying "lead" makes the tag redundant.
export function RoleTag({ link, name }: { link?: ProjectLink; name?: string }) {
  const tr = useWorkspaceT();
  if (link?.role === "lead") {
    return name && /\blead\b/i.test(name) ? null : (
      <span className="task-role-tag">{tr("roleLead")}</span>
    );
  }
  if (!link?.isolated) return null;
  return (
    <span className="task-role-tag" title={tr("roleIsolatedTitle")}>
      {tr("roleIsolated")}
    </span>
  );
}
