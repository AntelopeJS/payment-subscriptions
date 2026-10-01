export interface Clock {
  now(): number;
}

export const SYSTEM_CLOCK: Clock = Object.freeze({ now: () => Date.now() });

let current: Clock = SYSTEM_CLOCK;

export function Now(): number {
  return current.now();
}

export function UseClock(clock: Clock): void {
  current = clock;
}

export function RealDelayUntil(time: number): number {
  return Math.max(0, time - Now());
}
