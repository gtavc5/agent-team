import type { CommandInfo } from "../session/types";

// Commands handled by this server (Workspace.tryHandleCommand) rather than
// forwarded to the agent. Merged into the SDK command list for autocomplete.
const LOCAL_COMMANDS: CommandInfo[] = [
  {
    name: "effort",
    description: "Show or set the model reasoning effort level",
    argumentHint: "[low|medium|high|xhigh|max|ultra]",
  },
  {
    name: "model",
    description: "Show or switch the agent's model; the conversation carries over",
    argumentHint: "[model id]",
  },
  {
    name: "fast",
    description: "Toggle fast mode (quicker responses, higher usage)",
    argumentHint: "[on|off]",
  },
  { name: "context", description: "Show context window usage", argumentHint: "" },
  { name: "usage", description: "Show session token usage and cost", argumentHint: "" },
];

export function mergeLocalCommands(commands: CommandInfo[]): CommandInfo[] {
  const active = commands.filter((c) => c.name !== "goal");
  return [
    ...LOCAL_COMMANDS.map((command): CommandInfo => ({ ...command, source: "panel" })),
    ...active,
  ];
}
