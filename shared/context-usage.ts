export interface ContextUsage {
  tokens: number;
  window: number;
  estimated?: true;
}

export function estimatedContext(tokens: unknown, window: unknown): ContextUsage | null {
  if (
    typeof tokens !== "number" ||
    !Number.isSafeInteger(tokens) ||
    tokens < 0 ||
    typeof window !== "number" ||
    !Number.isSafeInteger(window) ||
    window <= 0
  )
    return null;
  return { tokens, window, estimated: true };
}
