/** Backoff schedule in seconds: 30s, 2m, 10m, 1h, 6h — then dead-letter. */
export const RETRY_SCHEDULE_SECONDS = [30, 120, 600, 3600, 21600];

export const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length + 1;

/**
 * Delay in seconds before the next attempt, given the attempt number that
 * just failed (1-based). Returns null when attempts are exhausted.
 */
export function nextRetryDelay(failedAttemptNo: number): number | null {
  return RETRY_SCHEDULE_SECONDS[failedAttemptNo - 1] ?? null;
}
