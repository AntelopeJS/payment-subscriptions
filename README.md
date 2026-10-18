# @antelopejs/payment-subscriptions

<div align="center">
<a href="https://www.npmjs.com/package/@antelopejs/payment-subscriptions"><img alt="npm" src="https://img.shields.io/npm/v/@antelopejs/payment-subscriptions?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/@antelopejs/payment-subscriptions?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="https://discord.gg/sjK28QHrA7"><img alt="Discord" src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000"></a>
<a href="./docs/1.introduction.md"><img alt="Docs" src="https://img.shields.io/badge/Docs-18181B?style=for-the-badge&color=000000"></a>
</div>

Subscriptions for any AntelopeJS payment provider. Implements
`@antelopejs/interface-subscriptions` on top of `@antelopejs/interface-payment`,
using saved payment methods and off-session charges, and runs the renewal clock
itself — for the providers that leave each renewal to the merchant (Adyen,
Checkout.com, Mangopay), and for any provider at all.

## Installation

```bash
ajs project modules add @antelopejs/payment-subscriptions
ajs project modules install
```

Wire it alongside:

- a module implementing `@antelopejs/interface-payment` (the one that charges);
- a module implementing `@antelopejs/interface-database` (where every
  subscription lives — `@antelopejs/mongodb`, for instance);
- optionally, `@antelopejs/redis`, for renewals charged on time rather than
  within one poll.

The example below deliberately selects the generic scheduler with Stripe payments and MongoDB storage. For Stripe-native billing, use Stripe alone instead. Supply the three environment variables before startup.

```typescript [antelope.config.ts] docs-check
import { defineConfig } from "@antelopejs/interface-core/config";

export default defineConfig({
  name: "billing-project",
  modules: {
    subscriptions: {
      source: {
        type: "package",
        package: "@antelopejs/payment-subscriptions",
        version: "^0.0.2",
      },
    },
    stripe: {
      source: {
        type: "package",
        package: "@antelopejs/stripe",
        version: "^1.1.0",
      },
      disabledExports: ["@antelopejs/interface-subscriptions"],
      config: { apiKey: "REPLACE_VIA_ENV", webhookSecret: "REPLACE_VIA_ENV" },
    },
    mongodb: {
      source: {
        type: "package",
        package: "@antelopejs/mongodb",
        version: "^1.4.2",
      },
      config: { url: "REPLACE_VIA_ENV", database: "billing" },
    },
  },
  envOverrides: {
    STRIPE_SECRET_KEY: "modules.stripe.config.apiKey",
    STRIPE_WEBHOOK_SECRET: "modules.stripe.config.webhookSecret",
    MONGODB_URL: "modules.mongodb.config.url",
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
  ever waits on it: a module with no Redis wired starts and renews. The suite
  verifies normal Redis interface routing under AntelopeJS core 1.16.0.
- **Charge recovery is bounded.** An instance claims a due renewal with a
  conditional write before charging it, so of several racing instances one
  charges and the rest stand down. The charge also carries an idempotency key
  derived from the subscription, the period and the attempt, so an instance that
  takes over an abandoned claim can replay only within the configured provider
  guarantee. Without that protection, an unknown result halts for reconciliation.

## Configuration

Every field is optional.

| Field                | Default                   | Meaning                                                                             |
| -------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `pollIntervalMs`     | 60 000                    | How often the database is polled when no Redis scheduler is wired                   |
| `sweepIntervalMs`    | 900 000                   | How often the database is swept when one is                                         |
| `leaseMs`            | 300 000                   | How long a claim on a renewal lasts before another instance may take it over        |
| `retryDelaysMs`      | one, three and seven days | The failed-renewal policy: one retry per entry, then the subscription ends          |
| `settlementPollMs`   | 3 600 000                 | How often a charge that is still settling is read again                             |
| `errorBackoffMs`     | 300 000                   | How long to wait when the payment provider cannot be reached at all                 |
| `batchSize`          | 100                       | How many due subscriptions one sweep takes on                                       |
| `providerSchedule`   | `payment-interface`       | How the schedule is mirrored with the provider; see the provider schedule document  |
| `guaranteedReplayMs` | `0`                       | Guaranteed provider idempotency retention, with safety margin; zero disables replay |

Use Stripe's native subscriptions by default for Stripe users; this module is an
explicit fallback. Before enabling retries of uncertain requests, verify the
provider's retention guarantee for every wired account. There is no portable
capability API and no assumed Stripe-style 24-hour window. See
[safe recovery](./docs/3.failed-renewals.md#reconciliation-and-operational-recovery).

## Documentation

| Document                                               | Contents                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| [Introduction](./docs/1.introduction.md)               | What it implements, what it needs, what it records          |
| [The renewal clock](./docs/2.renewal-clock.md)         | Polling and Redis, claims, idempotency, several instances   |
| [Failed renewals](./docs/3.failed-renewals.md)         | The retry policy, settling charges, an unreachable provider |
| [The provider schedule](./docs/4.provider-schedule.md) | The seam for providers that store a schedule (Mangopay)     |

## Compatibility

<!-- docs-compat: ./package.json#dependencies -->

| Package                               | Range            |
| ------------------------------------- | ---------------- |
| `@antelopejs/interface-core`          | `>=0.0.5 <1.0.0` |
| `@antelopejs/interface-database`      | `^0.1.8`         |
| `@antelopejs/interface-payment`       | `>=0.0.2 <1.0.0` |
| `@antelopejs/interface-subscriptions` | `>=0.0.2 <0.1.0` |

<!-- docs-compat: ./package.json#optionalDependencies -->

| Package                                 | Range            |
| --------------------------------------- | ---------------- |
| `@antelopejs/interface-redis`           | `>=0.0.6 <1.0.0` |
| `@antelopejs/interface-redis-scheduler` | `>=0.0.7 <1.0.0` |

These are the manifest's interface requirements. Provider modules can impose additional requirements; the example above uses Stripe 1.1 and MongoDB 1.4.

## Testing

`pnpm test` runs the suite twice, once per clock, against a real MongoDB and —
for the second run — a real Redis, both started by the suite. The interface's
conformance suite runs in both. A test-only payment provider in
`test/payment-provider` stands in for the payment module; it is never published.
The scripts use the local AntelopeJS core 1.16.0 runner (`ajs module test .`).

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md). Use Node.js 24 and pnpm 10.6.5:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm format:check
pnpm knip
```

The first test run downloads MongoDB and builds Redis, so it needs network access and a local C/C++ build toolchain. No Stripe credentials are required.

## License

[Apache-2.0](./LICENSE)
