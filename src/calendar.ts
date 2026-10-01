import type { SubscriptionInterval } from "@antelopejs/interface-subscriptions";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS_PER_YEAR = 12;

type Step = (anchor: number, steps: number) => number;

function addDays(days: number): Step {
  return (anchor, steps) => anchor + steps * days * DAY_MS;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function addMonths(months: number): Step {
  return (anchor, steps) => {
    const start = new Date(anchor);
    const target = start.getUTCMonth() + steps * months;
    const year = start.getUTCFullYear() + Math.floor(target / MONTHS_PER_YEAR);
    const month =
      ((target % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
    const day = Math.min(start.getUTCDate(), lastDayOfMonth(year, month));
    const shifted = new Date(anchor);
    shifted.setUTCFullYear(year, month, day);
    return shifted.getTime();
  };
}

const STEPS: Record<SubscriptionInterval, Step> = {
  day: addDays(1),
  week: addDays(7),
  month: addMonths(1),
  year: addMonths(MONTHS_PER_YEAR),
};

/**
 * Where period `index` begins, counting the period that starts at `anchor` as
 * period 0.
 *
 * Always counted from the anchor rather than from the previous boundary, so a
 * cycle anchored on the 31st ends on 28 February and then on 31 March, instead
 * of drifting to the 28th for good. UTC throughout.
 */
export function PeriodBoundary(
  anchor: number,
  interval: SubscriptionInterval,
  intervalCount: number,
  index: number,
): number {
  return STEPS[interval](anchor, index * intervalCount);
}
