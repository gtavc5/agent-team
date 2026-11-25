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
      filters: { granularity: "day", unit: "inference", since: end - 30 * day, until: end },
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
        granularity: "day",
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
    ["24h", "", 1],
    ["24h", "day", 1],
    ["7d", "hour", 7],
  ] as const)("anchors %s %s at next UTC hour", (range, granularity, days) => {
    const { filters } = parseUsageRequest(
      "overview",
      params(`range=${range}${granularity ? `&granularity=${granularity}` : ""}`),
      now + 123456,
    );
    expect(filters.granularity).toBe(granularity || "hour");
    expect(filters.until).toBe(now + day / 24);
    expect(filters.since).toBe(filters.until - days * day);
  });
  it("accepts explicit refresh and page jump", () => {
    expect(parseUsageRequest("journey", params("page=123&refresh=1"))).toMatchObject({
      page: 123,
      refresh: true,
    });
  });
  it.each([
    "page=0",
    "page=2.5",
    "page=-1",
    "page=NaN",
    "page=1&cursor=test",
    "page=9007199254740992",
  ])("rejects invalid page query %s", (input) => {
    expect(() => parseUsageRequest("journey", params(input))).toThrow(RangeError);
  });
  it.each([
    "refresh=true",
    "range=30d&granularity=hour",
    "range=90d&granularity=hour",
    "granularity=minute",
    "page=1",
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
