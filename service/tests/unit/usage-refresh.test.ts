import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseUsageRequest } from "../../src/usage/request";
import { usageView } from "../../src/usage/service";
import * as sources from "../../src/usage/sync";

it("shares one scan across overlapping explicit refreshes without rescanning on pagination", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "usage-refresh-"));
  const scan = vi.spyOn(sources, "syncSources").mockReturnValue(3);
  try {
    const request = (view: "overview" | "journey", query: string) =>
      usageView(baseDir, parseUsageRequest(view, new URLSearchParams(query)));
    const results = await Promise.all([
      request("overview", "refresh=1"),
      request("journey", "refresh=1"),
    ]);
    for (const result of results)
      expect(result).toMatchObject({ incompleteSources: 3, sourcesPending: false });
    await request("journey", "page=2");
    expect(scan).toHaveBeenCalledTimes(1);
    await request("overview", "refresh=1");
    expect(scan).toHaveBeenCalledTimes(2);
  } finally {
    scan.mockRestore();
    rmSync(baseDir, { recursive: true, force: true });
  }
});
