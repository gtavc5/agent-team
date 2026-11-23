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
        '**Bash**\n```bash\nprintf example\n```\n```json\n{\n  "timeout": 4\n}\n```',
        null,
        "Synthetic bash result.",
      ],
      [
        "edit",
        "builtin",
        '**Edit** `example.txt`\n```diff\n- old\n+ new\n```\n```json\n{\n  "dryRun": true\n}\n```',
        { tool: "Edit", file_path: "example.txt", old_string: "old", new_string: "new" },
        "Synthetic edit result.",
      ],
      [
        "read",
        "builtin",
        '**Read** `example.txt`\n```json\n{\n  "offset": 2,\n  "limit": 5\n}\n```',
        { tool: "Read", file_path: "example.txt" },
        "Synthetic read result.",
      ],
      [
        "grep",
        "builtin",
        '**Grep** `example`\n```json\n{\n  "path": "example.txt",\n  "ignoreCase": true\n}\n```',
        null,
        "Synthetic grep result.",
      ],
    ]);
  },
});
