import { expect } from "vitest";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  description: "Pi built-ins preserve full Markdown arguments and structured file inputs.",
  steps: [{ op: "send", text: "Inspect and update a sample." }],
  verify(r) {
    const calls = agentMessages(r)[0].events!.filter((e) => e.kind === "tool_use");
    expect(
      calls.map((e) => [e.toolName, e.toolSource, e.content, e.toolInput ?? null, e.toolResult]),
    ).toEqual([
      [
        "bash",
        "builtin",
        "**Bash** timeout 4s\n```bash\nprintf example\n```",
        null,
        "Synthetic bash result.",
      ],
      [
        "edit",
        "builtin",
        '**Edit** `example.txt`\n```diff\n- old\n+ new\n\n- before\n+ after\n```\n```json\n{\n  "dryRun": true\n}\n```',
        { tool: "Edit", file_path: "example.txt" },
        "Synthetic edit result.",
      ],
      [
        "read",
        "builtin",
        "**Read** `docs/example.txt`",
        { tool: "Read", file_path: "docs/example.txt" },
        "Synthetic read result.",
      ],
      [
        "grep",
        "builtin",
        "**Grep** `example` in `example.txt` · ignore case",
        null,
        "Synthetic grep result.",
      ],
    ]);
  },
});
