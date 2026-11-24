import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import * as os from "os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseMeminfo, parseVmStat, SystemMonitor } from "../../src/server/system";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("os", async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  platform: vi.fn(),
  totalmem: vi.fn(),
  freemem: vi.fn(),
}));

const GiB = 1024 ** 3;
const memTotal = 16 * GiB;
const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     5811.
Pages active:                                 404940.
Pages inactive:                               404287.
Pages speculative:                               239.
Pages throttled:                                   0.
Pages wired down:                             129474.
Pages purgeable:                                8973.
"Translation faults":                       79634474.
File-backed pages:                            362731.
Anonymous pages:                              446735.
Pages stored in compressor:                   200037.
Pages occupied by compressor:                  71808.
Pageouts:                                     165206.
`;
const meminfo = `MemTotal:       16777216 kB
MemFree:          601123 kB
MemAvailable:    8388608 kB
Buffers:          100050 kB
Cached:          4213500 kB
`;

describe("parseVmStat", () => {
  it("uses the reported page size and physical compressor occupancy, not file cache", () => {
    expect(parseVmStat(vmStat, memTotal)).toBe(639044 * 16384);
    expect(parseVmStat(vmStat.replace("16384", "4096"), memTotal)).toBe(639044 * 4096);
  });

  it.each([
    "Mach Virtual Memory Statistics",
    "Anonymous pages",
    "Pages purgeable",
    "Pages wired down",
    "Pages occupied by compressor",
  ])("rejects missing %s", (field) => {
    expect(
      parseVmStat(
        vmStat
          .split("\n")
          .filter((line) => !line.startsWith(`${field}:`))
          .join("\n"),
        memTotal,
      ),
    ).toBeNull();
  });

  it.each([
    ["16384", "0"],
    ["16384", "unknown"],
    ["446735.", "446735oops"],
    ["71808.", "-71808."],
    ["129474.", "9007199254740992."],
  ])("rejects malformed values (%s → %s)", (from, to) => {
    expect(parseVmStat(vmStat.replace(from, to), memTotal)).toBeNull();
  });

  it("preserves counts above the 32-bit range", () => {
    expect(parseVmStat(vmStat.replace("446735.", "4294967296."), 128 * 1024 * GiB)).toBe(
      4295159605 * 16384,
    );
  });

  it("subtracts excess purgeable pages before clamping the final total", () => {
    expect(parseVmStat(vmStat.replace("8973.", "500000."), memTotal)).toBe(148017 * 16384);
    expect(parseVmStat(vmStat.replace("8973.", "1000000."), memTotal)).toBe(0);
  });

  it("clamps the result to total physical memory", () => {
    expect(parseVmStat(vmStat, GiB)).toBe(GiB);
  });
});

describe("parseMeminfo", () => {
  it("uses MemAvailable rather than MemFree and converts from KiB to bytes", () => {
    expect(parseMeminfo(meminfo, memTotal)).toBe(8 * GiB);
  });

  it.each([
    "MemTotal: 12345 kB",
    "MemAvailable: 12345 kB",
    "MemTotal: 30 kB\nMemAvailable: 5 MB",
    "MemTotal: 30 kB\nMemAvailable: 5.5 kB",
    "MemTotal: 30 kB\nMemAvailable: -5 kB",
    "MemTotal: 30 kB\nMemAvailable:\n5 kB",
  ])("rejects missing or invalid counters in %j", (text) => {
    expect(parseMeminfo(text, memTotal)).toBeNull();
  });

  it("keeps the result within zero and total memory", () => {
    expect(parseMeminfo(meminfo.replace("8388608", "16777217"), memTotal)).toBe(0);
    expect(parseMeminfo(meminfo.replace("8388608", "0"), memTotal)).toBe(memTotal);
  });
});

describe("SystemMonitor memory sampling", () => {
  const fallback = memTotal - GiB;
  const runVmStat = vi.mocked(execFile);
  const readMeminfo = vi.mocked(readFile);

  beforeEach(() => {
    runVmStat.mockReset();
    readMeminfo.mockReset();
    vi.mocked(os.totalmem).mockReturnValue(memTotal);
    vi.mocked(os.freemem).mockReturnValue(GiB);
  });

  it("keeps snapshots synchronous and shares an in-flight vm_stat sample", async () => {
    vi.mocked(os.platform).mockReturnValue("darwin");
    const monitor = new SystemMonitor();
    expect(monitor.snapshot()).toMatchObject({ memTotal, memUsed: fallback });
    expect(monitor.snapshot().memUsed).toBe(fallback);
    expect(runVmStat).toHaveBeenCalledTimes(1);
    const signal = runVmStat.mock.calls[0]?.[2]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(runVmStat).toHaveBeenCalledWith(
      "/usr/bin/vm_stat",
      [],
      { encoding: "utf8", signal, killSignal: "SIGKILL", maxBuffer: 16 * 1024 },
      expect.any(Function),
    );
    runVmStat.mock.calls[0]?.[3]?.(null, vmStat, "");
    await setImmediate();
    expect(monitor.snapshot()).toMatchObject({ memTotal, memUsed: 639044 * 16384 });
  });

  it.each([
    ["timeout", Object.assign(new Error("timed out"), { cmd: "vm_stat", killed: true }), vmStat],
    [
      "missing executable",
      Object.assign(new Error("ENOENT"), { cmd: "vm_stat", code: "ENOENT" }),
      "",
    ],
    ["invalid output", null, "unexpected output"],
  ])(
    "falls back after vm_stat reports %s and recovers on a later sample",
    async (_, error, stdout) => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      const monitor = new SystemMonitor();
      monitor.snapshot();
      runVmStat.mock.calls[0]?.[3]?.(null, vmStat, "");
      await setImmediate();
      expect(monitor.snapshot().memUsed).toBe(639044 * 16384);
      runVmStat.mock.calls[1]?.[3]?.(error, stdout, "");
      await setImmediate();
      expect(monitor.snapshot().memUsed).toBe(fallback);
      runVmStat.mock.calls[2]?.[3]?.(null, vmStat, "");
      await setImmediate();
      expect(monitor.snapshot().memUsed).toBe(639044 * 16384);
    },
  );

  it("falls back for missing MemAvailable or unreadable meminfo without retaining stale samples", async () => {
    vi.mocked(os.platform).mockReturnValue("linux");
    readMeminfo
      .mockResolvedValueOnce(meminfo)
      .mockResolvedValueOnce("MemTotal: 16777216 kB")
      .mockResolvedValueOnce(meminfo)
      .mockRejectedValueOnce(new Error("EACCES"))
      .mockResolvedValue(meminfo);
    const monitor = new SystemMonitor();
    expect(monitor.snapshot().memUsed).toBe(fallback);
    expect(readMeminfo.mock.calls[0]).toMatchObject(["/proc/meminfo", { encoding: "utf8" }]);
    await setImmediate();
    expect(monitor.snapshot().memUsed).toBe(8 * GiB);
    await setImmediate();
    expect(monitor.snapshot().memUsed).toBe(fallback);
    await setImmediate();
    expect(monitor.snapshot().memUsed).toBe(8 * GiB);
    await setImmediate();
    expect(monitor.snapshot().memUsed).toBe(fallback);
    expect(runVmStat).not.toHaveBeenCalled();
  });

  it("does not pair a container meminfo sample with the host memory total", async () => {
    vi.mocked(os.platform).mockReturnValue("linux");
    readMeminfo.mockResolvedValue("MemTotal: 2097152 kB\nMemAvailable: 0 kB\n");
    const monitor = new SystemMonitor();
    monitor.snapshot();
    await setImmediate();
    expect(monitor.snapshot()).toMatchObject({ memTotal, memUsed: fallback });
  });

  it("drops stale results after a Linux read deadline without starting overlapping reads", async () => {
    vi.mocked(os.platform).mockReturnValue("linux");
    let finishRead!: (text: string) => void;
    const slowRead = new Promise<string>((resolve) => {
      finishRead = resolve;
    });
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      readMeminfo
        .mockResolvedValueOnce(meminfo)
        .mockReturnValueOnce(slowRead)
        .mockResolvedValue(meminfo.replace("8388608", "4194304"));
      const monitor = new SystemMonitor();
      monitor.snapshot();
      await setImmediate();
      timeout.mockReturnValueOnce(deadline.signal);
      expect(monitor.snapshot().memUsed).toBe(8 * GiB);
      expect(readMeminfo).toHaveBeenLastCalledWith("/proc/meminfo", {
        encoding: "utf8",
        signal: deadline.signal,
      });
      deadline.abort();
      expect(monitor.snapshot().memUsed).toBe(fallback);
      expect(readMeminfo).toHaveBeenCalledTimes(2);
      finishRead(meminfo);
      await setImmediate();
      expect(monitor.snapshot().memUsed).toBe(fallback);
      await setImmediate();
      expect(monitor.snapshot().memUsed).toBe(12 * GiB);
    } finally {
      timeout.mockRestore();
    }
  });

  it("rejects results past the deadline even before the abort timer runs", async () => {
    vi.mocked(os.platform).mockReturnValue("linux");
    readMeminfo.mockResolvedValue(meminfo);
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const monitor = new SystemMonitor();
      monitor.snapshot();
      now.mockReturnValue(501);
      await Promise.resolve();
      expect(monitor.snapshot().memUsed).toBe(fallback);
    } finally {
      now.mockRestore();
    }
  });

  it.each(["win32", "freebsd"] as const)("uses the OS fallback on %s", (platform) => {
    vi.mocked(os.platform).mockReturnValue(platform);
    expect(new SystemMonitor().snapshot()).toMatchObject({ memTotal, memUsed: fallback });
    expect(readMeminfo).not.toHaveBeenCalled();
    expect(runVmStat).not.toHaveBeenCalled();
  });
});
