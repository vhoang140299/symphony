export type TrackerErrorCategory =
  | "unsupported_tracker_kind"
  | "invalid_tracker_config"
  | "missing_tracker_secret"
  | "tracker_request"
  | "tracker_status"
  | "tracker_response"
  | "tracker_pagination"
  | "tracker_rate_limited";

export class TrackerError extends Error {
  constructor(readonly category: TrackerErrorCategory, message: string) {
    super(message);
    this.name = "TrackerError";
  }
}

export function asInvalidTrackerConfig(
  error: unknown,
  fallbackMessage: string,
): TrackerError {
  if (error instanceof TrackerError) return error;
  return new TrackerError(
    "invalid_tracker_config",
    error instanceof Error ? error.message : fallbackMessage,
  );
}
