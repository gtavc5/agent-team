import { describe, it, expect } from "vitest";
import { parseUsageRequest } from "../../src/usage/request";
const day = 86400000;
const now = Date.UTC(2026, 10, 25, 18);
const params = (input = "") => new URLSearchParams(input);
describe("bounded usage requests", () => {
  it("selects only inference and 30 UTC dates by default", () => {
    const end = Date.UTC(2026, 10, 26);
    expect(parseUsageRequest("overview", params(), now)).toEqual({
      view: "overview",
      filters: { unit: "inference", since: end - 30 * day, until: end },
    });
  });
  it("pins the time window when paging and preserves exact identity filters", () => {
    const end = Date.UTC(2026, 10, 26);
    expect(
      parseUsageRequest(
        "journey",
        params(
          `range=7d&unit=turn&until=${end}&source=codex&model=a%2Fb&channel=x&workspace=w&session=s&turn=t&cursor=abc`,
        ),
        now + day,
      ),
    ).toEqual({
      view: "journey",
      cursor: "abc",
      filters: {
        since: end - 7 * day,
        until: end,
        unit: "turn",
        model: "a/b",
        channel: "x",
        source: "codex",
        workspace: "w",
        session: "s",
        turn: "t",
      },
    });
  });
  it.each([
    "unit=all",
    "range=all",
    "range=91d",
    "unit=turn&unit=inference",
    "channel=",
    "source=unknown",
    "since=0",
    "until=abc",
    "cursor=foo",
    "model=" + "x".repeat(257),
  ])("rejects %s without querying history", (input) => {
    expect(() => parseUsageRequest("overview", params(input), now)).toThrow(RangeError);
  });
});
