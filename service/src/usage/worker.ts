import { parentPort, workerData } from "node:worker_threads";
import { runUsageJob, type UsageJob } from "./service";
try {
  parentPort!.postMessage({ result: runUsageJob(workerData as UsageJob) });
} catch (error) {
  if (!(error instanceof RangeError)) throw error;
  parentPort!.postMessage({ invalid: true });
}
