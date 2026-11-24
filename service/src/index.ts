import * as path from "path";
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
  const server = new Server(port, baseDir, webDir);

  async function shutdown(code = 0): Promise<void> {
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
