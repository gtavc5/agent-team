import * as path from "path";
import { Server } from "./server/server";

const port = parseInt(process.env.AGENT_TEAM_PORT ?? "9800", 10);
const baseDir = process.env.AGENT_TEAM_BASE_DIR ?? process.cwd();
const webDir = process.env.AGENT_TEAM_WEB_DIR ?? path.join(__dirname, "webview");

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
