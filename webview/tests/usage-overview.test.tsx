import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { resetLocaleForTests, setServerLanguage } from "../src/i18n";
import { UsageOverview as Overview, type TrendMode } from "../src/usage/UsageOverview";

afterEach(resetLocaleForTests);
function UsageOverview(props: Omit<ComponentProps<typeof Overview>, "mode" | "setMode">) {
  const [mode, setMode] = useState<TrendMode>("types");
  return <Overview {...props} mode={mode} setMode={setMode} />;
}

const since = Date.parse("2026-06-01T00:30:00Z");
const until = Date.parse("2026-06-01T04:15:00Z");
type Props = ComponentProps<typeof UsageOverview>;
const data: Props["data"] = {
  count: 2,
  input: 160,
  cacheRead: 0,
  cacheWrite: 0,
  output: 40,
  promptBearing: 2,
  eligible: 0,
  at96: 0,
  unpriced: 1,
  costs: { reported: 0, "channel-estimate": null, "api-equivalent": null },
  trend: [
    {
      day: "2026-06-01T00:00:00Z",
      input: 80,
      cacheRead: 0,
      cacheWrite: 0,
      output: 20,
      models: [{ model: "atlas", tokens: 75 }],
      other: 25,
    },
    {
      day: "2026-06-01T03:00:00Z",
      input: 80,
      cacheRead: 0,
      cacheWrite: 0,
      output: 20,
      models: [{ model: null, tokens: 100 }],
      other: 0,
    },
  ],
  ranking: [
    { model: null, tokens: 100 },
    { model: "atlas-high", tokens: 75 },
    { model: "nebula", tokens: 25 },
  ],
};
const props: Props = {
  data,
  since,
  until,
  granularity: "hour",
  incompleteSources: 0,
  unit: "turn",
  model: "",
  onModelChange: () => {},
};

it("UsageOverview positions UTC hourly bars across partial endpoints and missing buckets", () => {
  render(
    <UsageOverview
      {...props}
      data={{ ...data, trend: [...data.trend, { ...data.trend[0], day: "2026-06-01T04:00:00Z" }] }}
    />,
  );
  const chart = screen.getByRole("img", { name: "Token types by UTC hour" });
  const slots = Array.from(chart.querySelectorAll("g rect:first-of-type"));
  expect(slots).toHaveLength(3);
  expect(Number(slots[0].getAttribute("x"))).toBe(0);
  expect(Number(slots[0].getAttribute("width"))).toBeCloseTo((30 / 225) * 100);
  expect(Number(slots[1].getAttribute("x"))).toBeCloseTo((150 / 225) * 100);
  expect(Number(slots[1].getAttribute("width"))).toBeCloseTo((60 / 225) * 100);
  expect(Number(slots[2].getAttribute("x"))).toBeCloseTo((210 / 225) * 100);
  expect(Number(slots[2].getAttribute("width"))).toBeCloseTo((15 / 225) * 100);
  expect(chart.querySelector("desc")?.textContent).toContain(
    "2026-06-01T04:15:00.000Z (end exclusive). 5 UTC hour buckets",
  );
});

it("UsageOverview uses a half-open UTC day domain, not the first and last returned rows", () => {
  const row = data.trend[0];
  render(
    <UsageOverview
      {...props}
      granularity="day"
      since={Date.parse("2026-06-01T12:00:00Z")}
      until={Date.parse("2026-06-04T00:00:00Z")}
      data={{
        ...data,
        trend: [
          { ...row, day: "2026-06-02" },
          { ...row, day: "2026-06-04" },
        ],
      }}
    />,
  );
  const chart = screen.getByRole("img", { name: "Token types by UTC day" });
  expect(chart.querySelector("desc")?.textContent).toContain("3 UTC day buckets");
  const slots = chart.querySelectorAll("g rect:first-of-type");
  expect(slots).toHaveLength(1);
  expect(Number(slots[0].getAttribute("x"))).toBeCloseTo(20);
  expect(Number(slots[0].getAttribute("width"))).toBeCloseTo(40);
});

it("UsageOverview shows model family series and Other without inferring names from ranked identifiers", () => {
  render(<UsageOverview {...props} />);
  expect(screen.getByRole("group", { name: "Chart breakdown" }).classList).toContain("bp-views");
  expect(screen.getByRole("button", { name: "Top models" }).classList).not.toContain(
    "btn-secondary",
  );
  fireEvent.click(screen.getByRole("button", { name: "Top models" }));
  expect(screen.getByRole("button", { name: "Top models" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  const legend = within(
    screen.getByRole("list", { name: "Top model families by UTC hour legend" }),
  );
  expect(legend.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "Unknown model",
    "atlas",
    "Other",
  ]);
  const chart = screen.getByRole("img", { name: "Top model families by UTC hour" });
  const first = chart.querySelector("g")!;
  expect(first.querySelector("title")?.textContent).toContain("atlas: 75 · Other: 25");
  const bars = Array.from(first.querySelectorAll("rect")).slice(1);
  expect(bars.map((bar) => bar.getAttribute("height"))).toEqual(["75", "25"]);
  expect(bars.map((bar) => bar.getAttribute("y"))).toEqual(["25", "0"]);
  fireEvent.click(screen.getByRole("button", { name: "Token types" }));
  expect(screen.getByRole("list", { name: "Token types by UTC hour legend" })).toBeTruthy();
});

it("UsageOverview toggles a named ranked model and does not turn an unknown model into a filter", () => {
  const onModelChange = vi.fn();
  const { rerender } = render(<UsageOverview {...props} onModelChange={onModelChange} />);
  const ranking = within(screen.getByRole("list", { name: "Ranked model totals" }));
  const atlas = ranking.getByRole("button", { name: "atlas-high, 75 tokens" });
  expect(atlas.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(atlas);
  expect(onModelChange).toHaveBeenLastCalledWith("atlas-high");
  rerender(<UsageOverview {...props} model="atlas-high" onModelChange={onModelChange} />);
  expect(atlas.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(atlas);
  expect(onModelChange).toHaveBeenLastCalledWith("");
  expect(ranking.getByText("Unknown model")).toBeTruthy();
  expect(ranking.queryByRole("button", { name: /unknown model/i })).toBeNull();
});

it("UsageOverview permits all 169 hourly buckets of a misaligned seven-day window", () => {
  const { rerender } = render(<UsageOverview {...props} until={since + 7 * 86_400_000} />);
  expect(
    screen.getByRole("img", { name: "Token types by UTC hour" }).querySelector("desc")?.textContent,
  ).toContain("169 UTC hour buckets");
  rerender(<UsageOverview {...props} until={since + 7 * 86_400_000 + 3_600_000} />);
  expect(screen.queryByRole("img", { name: "Token types by UTC hour" })).toBeNull();
  expect(
    screen.getByText("Cannot chart this UTC window at the selected granularity."),
  ).toBeTruthy();
});

it("switches chart labels, tooltips and prices to Chinese without changing the UTC chart or model ID", () => {
  const onModelChange = vi.fn();
  const localizedData = {
    ...data,
    input: 11_960,
    ranking: [{ model: "atlas-high", tokens: 12_000 }, ...data.ranking.slice(2)],
    trend: [{ ...data.trend[0], models: [{ model: "atlas", tokens: 100 }] }, data.trend[1]],
  };
  render(<UsageOverview {...props} data={localizedData} onModelChange={onModelChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Top models" }));
  const chart = screen.getByRole("img", { name: "Top model families by UTC hour" });
  const bars = Array.from(chart.querySelectorAll("g rect"));
  const legend = screen.getByRole("list", { name: "Top model families by UTC hour legend" });
  const items = () =>
    within(legend)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
  expect(items()).toEqual(["atlas", "Unknown model", "Other"]);
  expect(screen.getAllByText("12K")).toHaveLength(2);

  act(() => setServerLanguage("zh-CN"));
  expect(screen.getByRole("img", { name: "用量最高的模型系列（按 UTC 每小时）" })).toBe(chart);
  expect(screen.getByRole("list", { name: "用量最高的模型系列（按 UTC 每小时）图例" })).toBe(
    legend,
  );
  expect(items()).toEqual(["atlas", "未知模型", "其他"]);
  expect(chart.querySelector("desc")?.textContent).toContain(
    "从 2026-06-01T00:30:00.000Z 到 2026-06-01T04:15:00.000Z（不含结束时刻）。按 UTC 每小时分组，共 5 组。",
  );
  expect(chart.querySelector("g title")?.textContent).toBe(
    "2026-06-01T00:00:00Z UTC · atlas：100 · 未知模型：0 · 其他：25",
  );
  expect(Array.from(chart.querySelectorAll("g rect"))).toEqual(bars);
  expect(screen.getAllByText("1.2万")).toHaveLength(2);
  expect(screen.getByText("已报告费用").nextElementSibling?.textContent).toBe("US$0");
  expect(screen.getByText("渠道估算费用").nextElementSibling?.textContent).toBe("—");
  expect(screen.getByText("API 等效费用").nextElementSibling?.textContent).toBe("—");
  expect(screen.getByText(/API 等效费用并非账户实际扣费/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "atlas-high，12,000 个 Token" }));
  expect(onModelChange).toHaveBeenLastCalledWith("atlas-high");
  fireEvent.click(screen.getByRole("button", { name: "Token 类型" }));
  expect(
    within(screen.getByRole("list", { name: "Token 类型（按 UTC 每小时）图例" })).getByText(
      "缓存写入",
    ),
  ).toBeTruthy();
});

it("UsageOverview distinguishes missing usage, source status and a reported zero price", () => {
  const { rerender } = render(<UsageOverview {...props} sourcesPending incompleteSources={1} />);
  expect(screen.getByText("Turn records")).toBeTruthy();
  expect(screen.getByText("1 priced · 1 unpriced")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Source scan pending");
  expect(screen.getByText("1 source unavailable or partially read")).toBeTruthy();
  expect(screen.getByText("Reported").nextElementSibling?.textContent).toBe("$0");
  expect(screen.getByText("Channel estimate").nextElementSibling?.textContent).toBe("—");
  expect(screen.queryByText(/Inferences with/)).toBeNull();
  rerender(
    <UsageOverview
      {...props}
      data={{
        ...data,
        count: 0,
        promptBearing: 0,
        unpriced: 0,
        input: 0,
        output: 0,
        costs: { ...data.costs, reported: null },
        trend: [],
        ranking: [],
      }}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe("No usage records returned.");
  expect(screen.getByText("No dated tokens returned")).toBeTruthy();
  expect(screen.getByText("No model totals returned")).toBeTruthy();
  expect(screen.getByText("Not available")).toBeTruthy();
  expect(screen.getByText("No source issues reported")).toBeTruthy();
  act(() => setServerLanguage("zh-CN"));
  expect(screen.getByRole("status").textContent).toBe("未返回用量记录。");
  expect(screen.getByText("未返回带时间的 Token 用量")).toBeTruthy();
  expect(screen.getByText("未返回模型用量汇总")).toBeTruthy();
  expect(screen.getByText("不可用")).toBeTruthy();
  expect(screen.getByText("未报告数据源问题")).toBeTruthy();
});
