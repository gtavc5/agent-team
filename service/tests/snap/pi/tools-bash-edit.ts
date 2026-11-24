import { expect } from "vitest";
import { agentMessages, fixture } from "../fixture.ts";
import { captures } from "../pi-captures.ts";

export default fixture({
  ...captures["tools-bash-edit"],
  verify(r) {
    const calls = agentMessages(r)[0].events!.filter((e) => e.kind === "tool_use");
    expect(calls.map((e) => e.toolName)).toEqual(["bash", "read", "edit", "grep"]);
    expect(
      calls.every((e) => e.toolSource === "builtin" && !!e.toolResult && !e.toolResultIsError),
    ).toBe(true);
    expect(calls[0].content).toContain("```bash\npwd\n```");
    expect(calls[1].toolInput).toEqual({ tool: "Read", file_path: "fixture.ts" });
    expect(calls[2].toolInput).toMatchObject({ tool: "Edit", file_path: "fixture.ts" });
    expect(calls[3].content).toContain("**Grep** `example` in `fixture.ts`");
  },
});
