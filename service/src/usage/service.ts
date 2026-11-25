import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { UsageJourney, UsageOverview } from "../../../shared/usage";
import { maintainUsageLedger } from "./ledger";
import { syncSources } from "./sync";
import { journey, overview } from "./queries";
import type { UsageRequest } from "./request";

const bundle = join(__dirname, "usage-worker.js");
type Data = UsageOverview | UsageJourney;
export type UsageJob = { baseDir: string; request?: UsageRequest };
export function runUsageJob(job: UsageJob): Data | number {
  if (!job.request) {
    maintainUsageLedger(job.baseDir);
    return syncSources(job.baseDir);
  }
  const { view, filters, cursor } = job.request;
  return view === "overview"
    ? overview(job.baseDir, filters)
    : journey(job.baseDir, filters, cursor);
}

// Keep SQLite aggregation and native imports off the session event loop in the built server.
// Tests run TypeScript directly and use the same job implementation without a worker bundle.
function run(job: UsageJob): Promise<Data | number> {
  if (!existsSync(bundle)) return Promise.resolve().then(() => runUsageJob(job));
  return new Promise((resolve, reject) => {
    const worker = new Worker(bundle, { workerData: job });
    worker.once("message", (msg: { result: Data | number } | { invalid: true }) =>
      "invalid" in msg ? reject(new RangeError("Invalid usage query")) : resolve(msg.result),
    );
    worker.once("error", reject);
    worker.once("exit", () => reject(new Error("Usage worker stopped without a result")));
  });
}

const collecting = new Map<string, Promise<number>>();
const lastScan = new Map<string, number>();
export function refreshUsage(baseDir: string): Promise<number> {
  const active = collecting.get(baseDir);
  if (active) return active;
  const scan = run({ baseDir })
    .then((result) => {
      if (typeof result !== "number") throw new Error("Invalid source status");
      lastScan.set(baseDir, result);
      return result;
    })
    .catch((err: unknown) => {
      lastScan.set(baseDir, 1);
      throw err;
    })
    .finally(() => collecting.delete(baseDir));
  collecting.set(baseDir, scan);
  return scan;
}

// Serialize reads (including receipt reconciliation) and bound queued work during refresh bursts.
let tail = Promise.resolve();
let outstanding = 0;
export async function usageView(baseDir: string, request: UsageRequest) {
  if (outstanding >= 8) throw new Error("Usage reader busy");
  outstanding++;
  const read = tail.then(() => run({ baseDir, request }));
  tail = read.then(
    () => {},
    () => {},
  );
  try {
    const data = await read;
    if (typeof data === "number") throw new Error("Invalid usage response");
    return {
      ...data,
      since: request.filters.since,
      until: request.filters.until,
      incompleteSources: lastScan.get(baseDir) ?? 0,
      sourcesPending: !lastScan.has(baseDir),
    };
  } finally {
    outstanding--;
  }
}
