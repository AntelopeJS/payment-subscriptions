---
name: payment-subscriptions
description: The generic AntelopeJS subscriptions module — implements @antelopejs/interface-subscriptions on top of any @antelopejs/interface-payment provider, keeps subscriptions in @antelopejs/interface-database, and fires renewals itself (Redis scheduler if wired, database polling if not). Use when wiring "@antelopejs/payment-subscriptions" into a project, when a payment provider has no native subscriptions (Adyen, Checkout.com, Mangopay), when configuring its retry policy, poll interval or lease, or when debugging a renewal that was late, charged twice, or never charged.
category: antelopejs-module
tags: [subscriptions, billing, recurring, payment, scheduler, antelopejs]
---

# payment-subscriptions

Implements the subscriptions interface for any payment provider. Consumers code
against `@antelopejs/interface-subscriptions` (see its skill); this module is
what you wire.

## Wiring

```ts
modules: {
  subscriptions: { source: { type: "package", package: "@antelopejs/payment-subscriptions" }, config: {} },
  payments: { ... },   // anything implementing @antelopejs/interface-payment
  mongodb: { ... },    // anything implementing @antelopejs/interface-database with atomicMutation
  redis: { ... },      // optional
}
```

## Config (all optional)

| Field              | Default             | Meaning                                                    |
| ------------------ | ------------------- | ---------------------------------------------------------- |
| `pollIntervalMs`   | 60 000              | Database poll without Redis: max lateness of a renewal     |
| `sweepIntervalMs`  | 900 000             | Database sweep with Redis: catches tasks Redis lost        |
| `leaseMs`          | 300 000             | How long one instance's claim on a renewal lasts           |
| `retryDelaysMs`    | 1d, 3d, 7d          | Retries after a failed renewal, then it ends               |
| `settlementPollMs` | 3 600 000           | How often a still-settling charge is read again            |
| `errorBackoffMs`   | 300 000             | Retry delay when the payment provider is unreachable       |
| `batchSize`        | 100                 | Due subscriptions handled per sweep                        |
| `providerSchedule` | `payment-interface` | Mirror the schedule with the provider (seam; one schedule) |

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
  is in use. With `@antelopejs/redis` 1.0.3 and core 1.10 the scheduler refuses
  the handler, a warning says so, and the module polls.
- **An unreachable provider** changes nothing and retries after `errorBackoffMs`
  with the same key; a decline makes the subscription `past_due`.
- **Payment charges carry `metadata.antelopeSubscription`.**

## Not in this module

Proration, dunning beyond the retry list, tax, coupons, metered billing, several
items per subscription. A Mangopay provider schedule is a seam
(`ProviderSchedule`), not an implementation.
