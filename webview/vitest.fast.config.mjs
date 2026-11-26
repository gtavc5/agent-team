import { availableParallelism } from "node:os";
import unit from "./vitest.config.ts";

// Exercise composer/session and reconnect contracts in jsdom, not Chromium.
export default {
  ...unit,
  test: {
    ...unit.test,
    maxWorkers: Math.max(1, Math.min(5, Math.floor(availableParallelism() / 2))),
    include: ["tests/{app,events,liveness,queue-journey,stream}.test.{ts,tsx}"],
    tagsFilter: ["!history-stress && !app-detail"],
  },
};
