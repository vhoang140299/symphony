import type { Tracker } from "../domain.js";
import { GitHubTracker } from "./github.js";
import { MemoryTracker } from "./memory.js";

export function createTracker(kind: string, provider: Record<string, unknown>): Tracker {
  if (kind === "memory") return new MemoryTracker(provider);
  if (kind === "github") return new GitHubTracker(provider);
  throw new Error(`Unsupported tracker kind: ${kind}`);
}
