export function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return error instanceof Error
    && "code" in error
    && (code === undefined || error.code === code);
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
