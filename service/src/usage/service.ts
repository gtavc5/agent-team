import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { syncSources } from "./sync";
import { queryJourney, queryUsage } from "./ledger";

// Native metadata can be much larger than the projected counters. Scan off the service thread.
const pending = new Map<string, Promise<number>>();
export function refreshUsage(baseDir: string): Promise<number> {
  const active = pending.get(baseDir);
  if (active) return active;
  try {
    if (
      !statSync(join(baseDir, "pi-sessions"), {
        throwIfNoEntry: false,
      })
    )
      return Promise.resolve(0);
  } catch {
    return Promise.resolve(1);
  }
  const bundle = join(__dirname, "usage-worker.js");
  const work = existsSync(bundle)
    ? new Promise<number>((resolve, reject) => {
        const worker = new Worker(bundle, { workerData: { baseDir } });
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", () => reject(new Error("Usage reader exited without a result")));
      })
    : Promise.resolve().then(() => syncSources(baseDir));
  pending.set(baseDir, work);
  void work.then(
    () => pending.delete(baseDir),
    () => pending.delete(baseDir),
  );
  return work;
}

export async function usageView(baseDir: string) {
  // Existing observations remain queryable if the optional native source is unavailable.
  const incompleteSources = await refreshUsage(baseDir).catch(() => 1);
  return { observations: queryUsage(baseDir), events: queryJourney(baseDir), incompleteSources };
}
