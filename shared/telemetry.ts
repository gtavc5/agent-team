// Semantic UI actions only. Never add free text or entity identifiers here.
export const TELEMETRY_LAYOUTS = ["narrow", "wide"] as const;
export const TELEMETRY_OUTCOMES = ["trigger", "open", "confirm", "cancel"] as const;
export const TELEMETRY_ACTIONS = [
  "confirm.clear_context",
  "confirm.remove_agent",
  "confirm.delete_session",
  "panel.files",
  "panel.diff",
  "panel.agents",
  "panel.board",
  "panel.notes",
  "panel.issues",
  "panel.close",
  "workspace.switch",
  "sidebar.search",
  "sidebar.archive_toggle",
  "quota.refresh",
  "dialog.add_agent",
  "dialog.add_project",
  "dialog.add_session",
] as const;
export const TELEMETRY_BATCH_MAX = 50;

export type TelemetryLayout = (typeof TELEMETRY_LAYOUTS)[number];
export type TelemetryOutcome = (typeof TELEMETRY_OUTCOMES)[number];
export type TelemetryAction = (typeof TELEMETRY_ACTIONS)[number];
export type TelemetryConfirmation = Extract<TelemetryAction, `confirm.${string}`>;

export interface TelemetryEvent {
  ts: number;
  layout: TelemetryLayout;
  action: TelemetryAction;
  outcome: TelemetryOutcome;
}

export interface TelemetryBatch {
  tab_run_id: string;
  events: TelemetryEvent[];
}
