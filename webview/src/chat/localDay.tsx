import { createContext, useEffect, useState, type ReactNode } from "react";

// Small buffer past 00:00:00 so timer jitter does not fire just before local midnight rolls over.
const MIDNIGHT_BUFFER_MS = 1_000;

export function localDayKey(now: number | Date = Date.now()): string {
  const d = now instanceof Date ? now : new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseLocalDayKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  // Noon avoids midnight DST transition quirks in timezones where 00:00 does not exist.
  return new Date(year, month - 1, day, 12, 0, 0);
}

export function msUntilNextLocalMidnight(now = Date.now()): number {
  const d = new Date(now);
  const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  return Math.max(MIDNIGHT_BUFFER_MS, nextMidnight.getTime() - now + MIDNIGHT_BUFFER_MS);
}

export const LocalDayContext = createContext<string | undefined>(undefined);

export function useLocalDayKey(): string {
  const [dayKey, setDayKey] = useState(() => localDayKey());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const syncAndSchedule = () => {
      const now = Date.now();
      const next = localDayKey(now);
      setDayKey((prev) => (prev === next ? prev : next));
      clearTimeout(timer);
      timer = setTimeout(syncAndSchedule, msUntilNextLocalMidnight(now));
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        syncAndSchedule();
      }
    };

    syncAndSchedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return dayKey;
}

export function LocalDayProvider({ children }: { children: ReactNode }) {
  const dayKey = useLocalDayKey();
  return <LocalDayContext.Provider value={dayKey}>{children}</LocalDayContext.Provider>;
}
