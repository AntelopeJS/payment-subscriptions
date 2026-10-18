const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The module's configuration. Every field is optional. */
export interface Config {
  /** Guaranteed provider replay retention, in milliseconds. Default zero (no replay).
   * Must be safe for every payment account wired to this module; include a safety margin.
   * Persisted per attempt so later configuration changes cannot extend protection.
   */
  guaranteedReplayMs?: number;
  /**
   * How often the database is polled for due renewals when no Redis
   * scheduler is wired. Default one minute: a renewal is charged at most this
   * late.
   */
  pollIntervalMs?: number;
  /**
   * How often the database is swept for due renewals when a Redis scheduler
   * is wired. Redis fires each renewal on time; this sweep catches any that
   * Redis lost, because the database alone must be enough. Default 15 minutes.
   */
  sweepIntervalMs?: number;
  /**
   * How long an instance holds its claim on a renewal while charging it.
   * Another instance takes the renewal over only after this has passed, and
   * may replay with the same key only within guaranteedReplayMs; otherwise it
   * halts for reconciliation. Default five minutes.
   */
  leaseMs?: number;
  /**
   * The failed-renewal policy: after the first failed charge of a period, one
   * retry per entry, each this long after the failure before it. When every
   * retry has failed the subscription ends with reason `payment_failed`.
   * Default one, three and seven days: four attempts over eleven days.
   */
  retryDelaysMs?: number[];
  /**
   * How long to wait before reading a charge that is still settling (a bank
   * debit, say) again. Default one hour.
   */
  settlementPollMs?: number;
  /**
   * How long to wait before retrying when the payment provider could not be
   * reached at all — not a decline. Replays require unexpired persisted
   * protection; known payment IDs are read only. Default five minutes.
   */
  errorBackoffMs?: number;
  /** How many due subscriptions one sweep takes on. Default 100. */
  batchSize?: number;
  /**
   * How the schedule is mirrored with the provider; see `ProviderSchedule`.
   * Default `payment-interface`, which records nothing with the provider.
   */
  providerSchedule?: string;
}

export type Settings = Required<Config>;

const DEFAULT_SETTINGS: Settings = Object.freeze({
  guaranteedReplayMs: 0,
  pollIntervalMs: MINUTE_MS,
  sweepIntervalMs: 15 * MINUTE_MS,
  leaseMs: 5 * MINUTE_MS,
  retryDelaysMs: Object.freeze([DAY_MS, 3 * DAY_MS, 7 * DAY_MS]) as number[],
  settlementPollMs: HOUR_MS,
  errorBackoffMs: 5 * MINUTE_MS,
  batchSize: 100,
  providerSchedule: "payment-interface",
});

export function ResolveSettings(config: Config = {}): Settings {
  if (
    config.guaranteedReplayMs !== undefined &&
    (!Number.isFinite(config.guaranteedReplayMs) ||
      config.guaranteedReplayMs < 0)
  ) {
    throw new Error(
      "guaranteedReplayMs must be a finite non-negative duration",
    );
  }
  const defined = Object.entries(config).filter(
    ([, value]) => value !== undefined,
  );
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(defined) };
}
