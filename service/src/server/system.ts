import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as os from "os";

const MEMORY_SAMPLE_TIMEOUT_MS = 500;

type MemoryRead = { signal: AbortSignal; deadline: number };

function expired(read: MemoryRead): boolean {
  return read.signal.aborted || performance.now() >= read.deadline;
}

// Host CPU and memory for the sidebar status panel. CPU usage is measured
// between two consecutive snapshots.
export class SystemMonitor {
  private prevIdle = 0;
  private prevTotal = 0;
  private memorySample: { memTotal: number; memUsed: number } | null = null;
  private samplingMemory: MemoryRead | null = null;

  constructor() {
    [this.prevIdle, this.prevTotal] = cpuTimes();
  }

  snapshot(): {
    osName: string;
    osArch: string;
    cpuModel: string;
    cpuCores: number;
    cpuUsage: number;
    memTotal: number;
    memUsed: number;
    uptime: number;
    hostname: string;
  } {
    const cpus = os.cpus();
    const [idle, total] = cpuTimes();
    const idleDelta = idle - this.prevIdle;
    const totalDelta = total - this.prevTotal;
    const cpuUsage = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
    this.prevIdle = idle;
    this.prevTotal = total;

    const memTotal = os.totalmem();
    const sample = this.samplingMemory && expired(this.samplingMemory) ? null : this.memorySample;
    void this.sampleMemory(os.platform(), memTotal);

    return {
      osName: `${os.type()} ${os.release()}`,
      osArch: os.arch(),
      cpuModel: cpus[0]?.model ?? "Unknown",
      cpuCores: cpus.length,
      cpuUsage,
      memTotal,
      memUsed: sample?.memTotal === memTotal ? sample.memUsed : memTotal - os.freemem(),
      uptime: os.uptime(),
      hostname: os.hostname(),
    };
  }

  private async sampleMemory(platform: NodeJS.Platform, memTotal: number): Promise<void> {
    if (this.samplingMemory || (platform !== "darwin" && platform !== "linux")) return;
    const deadline = performance.now() + MEMORY_SAMPLE_TIMEOUT_MS;
    const signal = AbortSignal.timeout(MEMORY_SAMPLE_TIMEOUT_MS);
    const read = { signal, deadline };
    this.samplingMemory = read;
    try {
      let memUsed: number | null;
      if (platform === "darwin") {
        const stdout = await readVmStat(signal);
        memUsed = stdout === null ? null : parseVmStat(stdout, memTotal);
      } else {
        const text = await readFile("/proc/meminfo", { encoding: "utf8", signal });
        memUsed = parseMeminfo(text, memTotal);
      }
      this.memorySample = expired(read) || memUsed === null ? null : { memTotal, memUsed };
    } catch {
      this.memorySample = null;
    } finally {
      this.samplingMemory = null;
    }
  }
}

function readVmStat(signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/vm_stat",
      [],
      { encoding: "utf8", signal, killSignal: "SIGKILL", maxBuffer: 16 * 1024 },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

export function parseVmStat(text: string, memTotal: number): number | null {
  const pageSize = parseCount(
    text.match(/^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)\r?$/m)?.[1],
  );
  const anonymous = vmStatCounter(text, "Anonymous pages");
  const purgeable = vmStatCounter(text, "Pages purgeable");
  const wired = vmStatCounter(text, "Pages wired down");
  const compressed = vmStatCounter(text, "Pages occupied by compressor");
  if (
    pageSize === null ||
    pageSize === 0 ||
    anonymous === null ||
    purgeable === null ||
    wired === null ||
    compressed === null
  ) {
    return null;
  }
  return clampMemory((anonymous - purgeable + wired + compressed) * pageSize, memTotal);
}

function vmStatCounter(text: string, name: string): number | null {
  return parseCount(text.match(new RegExp(`^${name}:[ \\t]*(\\d+)\\.?[ \\t]*\\r?$`, "m"))?.[1]);
}

export function parseMeminfo(text: string, memTotal: number): number | null {
  const total = parseCount(text.match(/^MemTotal:[ \t]*(\d+)[ \t]+kB[ \t]*\r?$/m)?.[1]);
  const available = parseCount(text.match(/^MemAvailable:[ \t]*(\d+)[ \t]+kB[ \t]*\r?$/m)?.[1]);
  if (total === null || available === null || total * 1024 !== memTotal) return null;
  return clampMemory((total - available) * 1024, memTotal);
}

function parseCount(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function clampMemory(used: number, total: number): number {
  return Math.max(0, Math.min(used, total));
}

function cpuTimes(): [idle: number, total: number] {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
  }
  return [idle, total];
}
