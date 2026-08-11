import type { Tracker } from "@ai-symphony/core/domain.js";
import { GitHubTracker, validateGitHubProvider } from "./github.js";
import {
  LinearTracker,
  type LinearTrackerDependencies,
  validateLinearProvider,
} from "./linear.js";
import { MemoryTracker } from "./memory.js";
import { TrackerError } from "./error.js";

export function createTracker(
  kind: string,
  provider: Record<string, unknown>,
  options: Pick<LinearTrackerDependencies, "logger" | "terminalStates"> = {},
): Tracker {
  if (kind === "memory") return new MemoryTracker(provider);
  if (kind === "github") return new GitHubTracker(provider);
  if (kind === "linear") return new LinearTracker(provider, options);
  throw new TrackerError("unsupported_tracker_kind", `Unsupported tracker kind: ${kind}`);
}

export function validateTrackerProvider(kind: string, provider: Record<string, unknown>): void {
  if (kind === "memory") {
    new MemoryTracker(provider);
    return;
  }
  if (kind === "github") {
    validateGitHubProvider(provider);
    return;
  }
  if (kind === "linear") {
    validateLinearProvider(provider);
    return;
  }
  throw new TrackerError("unsupported_tracker_kind", `Unsupported tracker kind: ${kind}`);
}
