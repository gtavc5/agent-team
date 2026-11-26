import unit from "./vitest.config.ts";

// Browser technology is not a tier boundary: keep the local reconnect and
// composer/session contracts here, and run the real browser queue pilot from root Fast.
export default {
  ...unit,
  test: {
    ...unit.test,
    include: ["tests/{app,events,liveness,stream}.test.{ts,tsx}"],
  },
};
