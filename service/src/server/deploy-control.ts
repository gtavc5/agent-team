import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

export const DEPLOY_RETRY = "Deployment is sealing this server. Retry shortly.";
export type Blockers = Record<string, number>;
export interface DeployTarget {
  installedRepoDir: string;
  releaseId: string;
  baseDir: string;
  label: string;
  port: number;
}

interface Lease {
  id: string;
  expires: number;
  ready: boolean;
  controller: AbortController;
  committed?: boolean;
  timer?: NodeJS.Timeout;
}

export class DeployControl {
  private readonly bootId = randomUUID();
  private lease?: Lease;
  private retiring = false;
  private retirement?: Promise<void>;
  private closed = false;
  private server?: net.Server;
  private socketFile?: string;
  private readonly clients = new Set<net.Socket>();

  constructor(
    private readonly target: DeployTarget,
    private readonly blockers: () => Blockers,
    private readonly retire: (signal: AbortSignal) => Promise<void>,
    private readonly resumed: () => void,
    private readonly leaseMs = 20_000,
    private readonly transaction = path.join(
      target.installedRepoDir,
      ".agent-team/releases/transaction.json",
    ),
  ) {}

  get sealed(): boolean {
    return !!this.lease || this.retiring;
  }

  private release(lease = this.lease): void {
    if (!lease || lease !== this.lease) return;
    clearTimeout(lease.timer);
    this.lease = undefined;
    lease.controller.abort();
    if (!this.retiring && !this.closed) queueMicrotask(this.resumed);
  }

  // Called on unsolicited events, not only at the next status poll: a short
  // turn can start and end while the controller waits on child retirement.
  observe(busy = Object.values(this.blockers()).some(Boolean)): void {
    if (this.lease && !this.lease.committed && busy) this.release();
  }

  status() {
    if (
      this.lease &&
      (this.lease.committed
        ? !fs.existsSync(this.transaction)
        : performance.now() >= this.lease.expires)
    )
      this.release();
    if (!this.retiring) this.observe();
    return {
      ...this.target,
      pid: process.pid,
      bootId: this.bootId,
      sealed: this.sealed,
      deployId: this.lease?.id,
      commitReady: this.lease?.ready === true,
      committed: this.lease?.committed === true,
      leaseRemainingMs: this.lease ? Math.floor(this.lease.expires - performance.now()) : 0,
      blockers: { ...this.blockers(), ...(this.retiring ? { retirement: 1 } : {}) },
    };
  }

  async request(msg: Record<string, unknown>) {
    const state = this.status();
    if (msg.cmd === "status") return state;
    if (this.closed || !["seal", "unseal"].includes(String(msg.cmd)))
      throw new Error("Unavailable command");
    for (const key of [
      "pid",
      "bootId",
      "releaseId",
      "installedRepoDir",
      "baseDir",
      "label",
      "port",
    ] as const)
      if (msg[key] !== state[key]) throw new Error("Target identity mismatch");
    const id = msg.deployId;
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id))
      throw new Error("Invalid deploy ID");
    if (msg.cmd === "unseal") {
      if (this.lease && this.lease.id !== id) throw new Error("Seal owner mismatch");
      this.release();
      return this.status();
    }
    if (msg.commit === true) {
      const lease = this.lease;
      if (
        !lease ||
        lease.id !== id ||
        !lease.ready ||
        !fs.existsSync(this.transaction) ||
        this.retiring ||
        Object.values(state.blockers).some(Boolean)
      )
        return state;
      clearTimeout(lease.timer);
      lease.committed = true;
      // A committed handoff remains fenced until external recovery resolves the transaction.
      lease.timer = setInterval(() => {
        if (!fs.existsSync(this.transaction)) this.release(lease);
      }, 500);
      return this.status();
    }
    if (this.sealed || Object.values(state.blockers).some(Boolean)) return state;
    const lease: Lease = {
      id,
      expires: performance.now() + this.leaseMs,
      ready: false,
      controller: new AbortController(),
    };
    lease.timer = setTimeout(() => this.release(lease), this.leaseMs);
    this.lease = lease;
    this.retiring = true;
    try {
      this.retirement = this.retire(lease.controller.signal);
      await this.retirement;
      this.observe();
      lease.ready = true;
    } catch {
      this.release(lease);
    } finally {
      this.retiring = false;
      this.retirement = undefined;
      if (!this.lease && !this.closed) queueMicrotask(this.resumed);
    }
    return this.status();
  }

  async listen(): Promise<void> {
    if (this.closed) return;
    const dir = path.join(this.target.baseDir, "deploy-control");
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700)
      throw new Error("Deploy control directory must be owner-only");
    const socketFile = path.join(dir, "control.sock");
    // A forced exit may leave the socket name; never unlink a live listener.
    const old = fs.lstatSync(socketFile, { throwIfNoEntry: false });
    if (old) {
      if (!old.isSocket() || old.uid !== st.uid) throw new Error("Invalid deploy control socket");
      await new Promise<void>((resolve, reject) => {
        const probe = net.createConnection(socketFile);
        probe.setTimeout(1000, () => probe.destroy(new Error("Socket probe timed out")));
        probe.once("connect", () => {
          probe.destroy();
          reject(new Error("Deploy control already listening"));
        });
        probe.once("error", (e: NodeJS.ErrnoException) =>
          e.code === "ECONNREFUSED" ? resolve() : reject(e),
        );
      });
      if (fs.lstatSync(socketFile, { throwIfNoEntry: false })?.ino === old.ino)
        fs.unlinkSync(socketFile);
    }
    if (this.closed) return;
    const server = net.createServer((client) => {
      this.clients.add(client);
      client.on("close", () => this.clients.delete(client));
      client.on("error", () => client.destroy());
      client.setTimeout(25_000, () => client.destroy());
      let line = "";
      client.on("data", (chunk: Buffer) => {
        line += chunk.toString();
        if (line.length > 8192) return client.destroy();
        if (!line.includes("\n")) return;
        client.pause();
        void Promise.resolve()
          .then(() => {
            const message: unknown = JSON.parse(line);
            if (!message || typeof message !== "object" || Array.isArray(message))
              throw new Error("Invalid request");
            return this.request(message as Record<string, unknown>);
          })
          .then(
            (value) => client.end(JSON.stringify(value) + "\n"),
            (err: unknown) =>
              client.end(
                JSON.stringify({ error: err instanceof Error ? err.message : "Invalid request" }) +
                  "\n",
              ),
          );
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketFile, () => {
        this.socketFile = socketFile;
        try {
          fs.chmodSync(socketFile, 0o600);
        } catch (error) {
          server.close();
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (this.closed) server.close();
        resolve();
      });
    });
  }

  close(): Promise<void> | undefined {
    this.closed = true;
    this.release();
    for (const client of this.clients) client.destroy();
    // Node removes its own Unix socket on server.close().
    if (this.socketFile) this.server?.close();
    return this.retirement?.catch(() => undefined);
  }
}
