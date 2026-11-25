import { parentPort, workerData } from "node:worker_threads";
import { syncSources } from "./sync";
parentPort!.postMessage(syncSources((workerData as { baseDir: string }).baseDir));
