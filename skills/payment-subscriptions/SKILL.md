---
name: payment-subscriptions
description: Guides wiring the generic payment-subscriptions fallback, configuring bounded charge recovery, and diagnosing stalled renewals or reconciliation holds. Use when a payment provider lacks native subscriptions or the merchant explicitly chooses a locally owned renewal clock.
metadata:
  category: antelopejs-module
---

# payment-subscriptions

Implements the subscriptions interface for any payment provider. Consumers code
against `@antelopejs/interface-subscriptions` (see its skill); this module is
what you wire.

Prefer Stripe's native subscriptions for Stripe users. Use this module only as
an explicit fallback, disabling Stripe's subscriptions export or configuring
consumer import overrides so just one implementation owns each subscription.

## Wiring

Run `ajs project modules add @antelopejs/payment-subscriptions` in a project.
For an embedded runtime, add the module to the host runtime configuration instead.

```ts
modules: {
  subscriptions: { source: { type: "package", package: "@antelopejs/payment-subscriptions" }, config: {} },
  payments: { ... },   // anything implementing @antelopejs/interface-payment
  mongodb: { ... },    // anything implementing @antelopejs/interface-database with atomicMutation
  redis: { ... },      // optional
}
```

## Config (all optional)

| Field                | Default             | Meaning                                                                           |
| -------------------- | ------------------- | --------------------------------------------------------------------------------- |
| `pollIntervalMs`     | 60 000              | Database poll without Redis: max lateness of a renewal                            |
| `sweepIntervalMs`    | 900 000             | Database sweep with Redis: catches tasks Redis lost                               |
| `leaseMs`            | 300 000             | How long one instance's claim on a renewal lasts                                  |
| `retryDelaysMs`      | 1d, 3d, 7d          | Retries after a failed renewal, then it ends                                      |
| `settlementPollMs`   | 3 600 000           | How often a still-settling charge is read again                                   |
| `errorBackoffMs`     | 300 000             | Retry delay when the payment provider is unreachable                              |
| `batchSize`          | 100                 | Due subscriptions handled per sweep                                               |
| `providerSchedule`   | `payment-interface` | Mirror the schedule with the provider (seam; one schedule)                        |
| `guaranteedReplayMs` | `0`                 | Verified provider replay retention with a safety margin; default allows no replay |

## Facts to reason from when debugging

- **The database is the truth.** Schema `payment-subscriptions`, table
  `subscriptions`; `dueAt` is what the sweep queries, `nextActionAt` is the next
  renewal, retry or settlement read, `outbox` holds undelivered events,
  `leaseOwner`/`leaseUntil` is the current claim.
- **Charged at most once per attempt.** A claim (conditional write) precedes every
  charge; the charge's idempotency key is
  `payment-subscriptions:<id>:<period>:<attempt>`. Two payments for one period
  with different attempts are deliberate retries, not duplicates.
- **Late renewal without Redis** is expected up to `pollIntervalMs`.
- **The log line `renewal clock is polling|redis`** at start says which trigger
  is in use. Core 1.16.0 supports the published Redis scheduler through normal
  routing; a handler-registration failure logs a warning and falls back to polling.
- **An uncertain charge** retries with the pinned method and same key only
  strictly before persisted `attemptReplayUntil`. Verify retention for every
  account before setting `guaranteedReplayMs`; never assume Stripe's duration.
- **A reconciliation hold** appears in `vendorData.reconciliationRequired` and
  logs. Unknown expired or legacy attempts halt; known pending IDs are read only.
  Method updates and cancellation do not restart held charges. Before repairing
  state, follow [operational recovery](../../docs/3.failed-renewals.md#reconciliation-and-operational-recovery).
- **Payment charges carry `metadata.antelopeSubscription`.**

## Not in this module

Proration, dunning beyond the retry list, tax, coupons, metered billing, several
items per subscription. A Mangopay provider schedule is a seam
(`ProviderSchedule`), not an implementation.
