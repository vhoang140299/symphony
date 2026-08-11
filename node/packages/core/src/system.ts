const maxTimerDelayMs = 2_147_483_647;

export function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return error instanceof Error
    && "code" in error
    && (code === undefined || error.code === code);
}

export function scheduleLongTimeout(callback: () => void, delayMs: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  const schedule = (remainingMs: number) => {
    const chunkMs = Math.min(remainingMs, maxTimerDelayMs);
    timer = setTimeout(() => {
      timer = undefined;
      const nextMs = remainingMs - chunkMs;
      if (nextMs > 0) schedule(nextMs);
      else callback();
    }, chunkMs);
  };
  schedule(delayMs);
  return () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}

export function terminateProcessTreeBestEffort(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (pid === undefined) return;
  const targets = process.platform === "win32" ? [pid] : [-pid, pid];
  for (const target of targets) {
    try {
      process.kill(target, signal);
    } catch {
      // Best-effort cleanup must not replace the original process outcome.
    }
  }
}
