# @antelopejs/payment-subscriptions

[![npm version](https://img.shields.io/npm/v/@antelopejs/payment-subscriptions.svg)](https://www.npmjs.com/package/@antelopejs/payment-subscriptions)
[![license](https://img.shields.io/npm/l/@antelopejs/payment-subscriptions.svg)](./LICENSE)

Subscriptions for any AntelopeJS payment provider. Implements
`@antelopejs/interface-subscriptions` on top of `@antelopejs/interface-payment`,
using saved payment methods and off-session charges, and runs the renewal clock
itself — for the providers that leave each renewal to the merchant (Adyen,
Checkout.com, Mangopay), and for any provider at all.

## Installation

```bash
npm install @antelopejs/payment-subscriptions
```

Wire it alongside:

- a module implementing `@antelopejs/interface-payment` (the one that charges);
- a module implementing `@antelopejs/interface-database` (where every
  subscription lives — `@antelopejs/mongodb`, for instance);
- optionally, `@antelopejs/redis`, for renewals charged on time rather than
  within one poll.

```ts
export default defineConfig({
  modules: {
    subscriptions: { source: { type: "package", package: "@antelopejs/payment-subscriptions" } },
    payments: { source: { type: "package", package: "<your payment-interface module>" }, config: { ... } },
    mongodb: { source: { type: "package", package: "@antelopejs/mongodb" }, config: { ... } },
  },
});
```

### With a payment module that has subscriptions of its own

`@antelopejs/stripe` implements `@antelopejs/interface-subscriptions` natively.
Wire it alone for Stripe's own subscriptions. Wiring this module beside it makes
two providers of the interface, and the core picks one by module id, not by
intent. To use this module's clock with Stripe charges, say so: add
`disabledExports: ["@antelopejs/interface-subscriptions"]` to the Stripe module's
entry, or an `importOverrides` entry on each consumer.

## How it works

- **The database is the only source of truth.** Each subscription is one record
  holding its period, its status, when it next needs attention and the events it
  has yet to deliver. A renewal is recoverable from the database alone.
- **The clock is only a trigger.** With a Redis scheduler wired, each subscription
  is one task fired when it is due, and a slow database sweep catches anything
  Redis loses. Without one, the database is polled. Redis is optional, and nothing
  ever waits on it: a module with no Redis wired starts and renews. (The
  published Redis scheduler currently refuses the handler under AntelopeJS core
  1.10; the module then polls. [The renewal clock](./docs/2.renewal-clock.md)
  has the detail.)
- **Each renewal is charged once.** An instance claims a due renewal with a
  conditional write before charging it, so of several racing instances one
  charges and the rest stand down. The charge also carries an idempotency key
  derived from the subscription, the period and the attempt, so an instance that
  takes over an abandoned claim replays the original charge instead of making a
  second.

## Configuration

Every field is optional.

| Field              | Default                   | Meaning                                                                            |
| ------------------ | ------------------------- | ---------------------------------------------------------------------------------- |
| `pollIntervalMs`   | 60 000                    | How often the database is polled when no Redis scheduler is wired                  |
| `sweepIntervalMs`  | 900 000                   | How often the database is swept when one is                                        |
| `leaseMs`          | 300 000                   | How long a claim on a renewal lasts before another instance may take it over       |
| `retryDelaysMs`    | one, three and seven days | The failed-renewal policy: one retry per entry, then the subscription ends         |
| `settlementPollMs` | 3 600 000                 | How often a charge that is still settling is read again                            |
| `errorBackoffMs`   | 300 000                   | How long to wait when the payment provider cannot be reached at all                |
| `batchSize`        | 100                       | How many due subscriptions one sweep takes on                                      |
| `providerSchedule` | `payment-interface`       | How the schedule is mirrored with the provider; see the provider schedule document |

## Documentation

| Document                                               | Contents                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| [Introduction](./docs/1.introduction.md)               | What it implements, what it needs, what it records          |
| [The renewal clock](./docs/2.renewal-clock.md)         | Polling and Redis, claims, idempotency, several instances   |
| [Failed renewals](./docs/3.failed-renewals.md)         | The retry policy, settling charges, an unreachable provider |
| [The provider schedule](./docs/4.provider-schedule.md) | The seam for providers that store a schedule (Mangopay)     |

## Testing

`pnpm test` runs the suite twice, once per clock, against a real MongoDB and —
for the second run — a real Redis, both started by the suite. The interface's
conformance suite runs in both. A test-only payment provider in
`test/payment-provider` stands in for the payment module; it is never published.

## License

Apache-2.0
