/**
 * Where the module reads the time. Every renewal, trial end, retry and period
 * boundary is decided against this, never against `Date.now()` directly, so a
 * test can move time forward and watch what happens.
 */
export interface Clock {
  now(): number;
}

export const SYSTEM_CLOCK: Clock = Object.freeze({ now: () => Date.now() });

let current: Clock = SYSTEM_CLOCK;

export function Now(): number {
  return current.now();
}

/**
 * Replaces the clock. Exists for the module's own suite, which drives renewals
 * by advancing a manual clock; production never calls it.
 */
export function UseClock(clock: Clock): void {
  current = clock;
}

/**
 * How long from now, in real milliseconds, until the module's clock reads
 * `time`. Equal to `time - Date.now()` on the system clock.
 */
export function RealDelayUntil(time: number): number {
  return Math.max(0, time - Now());
}
