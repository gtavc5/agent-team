import { createContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TracePage, TraceTarget, TraceWindow } from "../../../shared/subagent-trace";

export interface TraceConnection {
  workspaceId: string;
  epoch: number | null;
  requestPage: (
    target: TraceTarget,
    window: TraceWindow,
    receive: (page: TracePage) => void,
  ) => () => void;
}

export const SubagentTraceContext = createContext<TraceConnection | null>(null);

const REFRESH_MS = 400;
const TIMEOUT_MS = 5000;

// Mounted only by the expanded card. A refresh replaces its sole page;
// collapse or session switch releases it and cancels the outstanding request.
export function useTracePage(
  connection: TraceConnection | null,
  target: TraceTarget | null,
  window: TraceWindow,
  revision: number,
) {
  const [loaded, setLoaded] = useState<{ window: TraceWindow; page: TracePage } | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const currentRevision = useRef(revision);
  useLayoutEffect(() => {
    currentRevision.current = revision;
  }, [revision]);

  useEffect(() => {
    if (connection?.epoch == null || !target) return;
    const { requestPage } = connection;
    const traceTarget = target;
    let cancel: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let fetchedRevision: number | undefined;
    function refresh() {
      const requestedRevision = currentRevision.current;
      if (cancel || (fetchedRevision !== undefined && fetchedRevision >= requestedRevision)) return;
      setTimedOut(false);
      timeout = setTimeout(() => {
        cancel?.();
        cancel = undefined;
        fetchedRevision = requestedRevision;
        setTimedOut(true);
      }, TIMEOUT_MS);
      const release = requestPage(traceTarget, window, (next) => {
        clearTimeout(timeout);
        timeout = undefined;
        cancel = undefined;
        // Install this bounded snapshot even if a newer revision arrived
        // during the round trip. The next tick catches up without starvation.
        fetchedRevision = Math.max(next.revision, requestedRevision);
        setLoaded({ window, page: next });
      });
      if (timeout !== undefined) cancel = release;
      else release();
    }
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(timeout);
      cancel?.();
    };
  }, [connection, target, window]);

  return { page: loaded?.page, isNavigating: !!loaded && loaded.window !== window, timedOut };
}
