import * as path from "path";
import { existsSync, realpathSync } from "node:fs";
import { refreshUsage } from "./usage/service";
import { Server } from "./server/server";
import { doctor } from "./config/doctor";
import { formatReport } from "./config/diagnostics";

const port = parseInt(process.env.AGENT_TEAM_PORT ?? "9800", 10);
const baseDir = process.env.AGENT_TEAM_BASE_DIR ?? process.cwd();
const webDir = process.env.AGENT_TEAM_WEB_DIR ?? path.join(__dirname, "webview");

if (
  process.argv[2] === "--doctor" &&
  (process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === "--json"))
) {
  void doctor(baseDir).then(({ report, ok }) => {
    console.log(
      process.argv[3] === "--json" ? JSON.stringify(report, null, 2) : formatReport(report),
    );
    process.exitCode = ok ? 0 : 1;
  });
} else if (process.argv.length > 2) {
  console.error("Usage: node dist/server.js [--doctor [--json]]");
  process.exitCode = 2;
} else serve();

function serve() {
  const installedRepoDir = process.env.AGENT_TEAM_INSTALLED_REPO;
  const label = process.env.YAAT_SERVICE_LABEL;
  const generation = realpathSync(__dirname);
  const legacy = installedRepoDir && generation === path.join(installedRepoDir, "dist");
  const staged =
    installedRepoDir &&
    path.dirname(generation) === path.join(installedRepoDir, ".agent-team/releases");
  const target =
    installedRepoDir && label && (staged || (legacy && !process.env.AGENT_TEAM_WEB_DIR))
      ? {
          installedRepoDir,
          label,
          port,
          baseDir: realpathSync(baseDir),
          releaseId: staged ? path.basename(generation) : "legacy",
        }
      : undefined;
  // A new boot must not take work that a failed health check would cut off.
  // This is a boot fence for an external transaction, not a restored lease.
  const transaction = staged ? path.join(path.dirname(generation), "transaction.json") : undefined;
  const server = new Server(
    port,
    baseDir,
    staged ? path.join(generation, "webview") : webDir,
    target,
    transaction && existsSync(transaction) ? transaction : undefined,
  );
  void server.controlReady.catch((error: unknown) => {
    void server.listening.then(
      () => console.error("Deploy control unavailable:", error),
      (startupError: unknown) => {
        console.error("Service startup failed:", startupError);
        void shutdown(1);
      },
    );
  });

  const collect = () =>
    void refreshUsage(baseDir).catch(() => console.warn("[usage] ACP reader unavailable"));
  const timer = setInterval(collect, 60_000).unref();
  collect();

  async function shutdown(code = 0): Promise<void> {
    clearInterval(timer);
    await server.close();
    process.exit(code);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGHUP", () => void shutdown());

  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception, saving state before exit:", err);
    void shutdown(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection, saving state before exit:", reason);
    void shutdown(1);
  });
}
