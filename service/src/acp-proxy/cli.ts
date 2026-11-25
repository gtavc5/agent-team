import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { startCcpaProxy } from "./proxy";

function reportError(error: unknown): void {
  console.error(`ccpa-proxy: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      port: { type: "string", default: "0" },
      "base-dir": { type: "string" },
      "upstream-url": { type: "string" },
    },
  });
  if (values.help) {
    console.log(`Usage: ccpa-proxy [--port PORT] [--upstream-url URL] [--base-dir DIR]

  --port          Listen port (default: 0, choose an available port)
  --upstream-url  Override the default CCPA upstream
  --base-dir      State directory (default: AGENT_TEAM_BASE_DIR or current directory)
  -h, --help      Show this help`);
    return;
  }

  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port > 65535) {
    throw new Error("--port must be an integer from 0 to 65535");
  }
  const baseDir = resolve(values["base-dir"] ?? process.env.AGENT_TEAM_BASE_DIR ?? process.cwd());
  const handle = await startCcpaProxy({ baseDir, port, upstreamUrl: values["upstream-url"] });
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void handle.close().catch(reportError);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`export AGY_ACP_CCPA_BASE_URL=${handle.url}`);
}

void main().catch(reportError);
