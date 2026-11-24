import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

// Leave the output readers attached until close (not exit). A final frame may
// reveal unsolicited work; callers must reject retirement in that case.
// This path never escalates to a signal, even if the child ignores EOF.
export function retireOnEof(child: ChildProcess, stdin: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("close", closed);
      if (error) reject(error);
      else resolve();
    };
    const closed = (code: number | null) =>
      finish(code === 0 ? undefined : new Error("Backend did not exit cleanly"));
    const timer = setTimeout(() => finish(new Error("Idle backend did not retire")), 5000);
    child.once("close", closed);
    stdin.end();
  });
}
