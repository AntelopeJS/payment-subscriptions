# `@antelopejs/payment-subscriptions`

<div align="center">
<a href="https://www.npmjs.com/package/@antelopejs/payment-subscriptions"><img data-illustration alt="npm" src="https://img.shields.io/npm/v/@antelopejs/payment-subscriptions?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="./LICENSE"><img data-illustration alt="License" src="https://img.shields.io/npm/l/@antelopejs/payment-subscriptions?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="https://discord.gg/g4pFt6eXqu"><img data-illustration alt="Discord" src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000"></a>
<a href="./docs/1.introduction.md"><img data-illustration alt="Docs" src="https://img.shields.io/badge/Docs-18181B?style=for-the-badge&color=000000"></a>
</div>

Subscriptions for any AntelopeJS payment provider. This module implements
`@antelopejs/interface-subscriptions` on top of `@antelopejs/interface-payment`.
It charges saved payment methods off-session and runs the renewal clock itself.
It is the implementation for providers that leave each renewal to the merchant,
such as Adyen, Checkout.com, and Mangopay, and it works with any payment
provider.

Part of [AntelopeJS](https://github.com/AntelopeJS/antelopejs), the TypeScript framework where modules depend on contracts and the application chooses the provider. Built by the team behind [AntelopeJS DMS](https://github.com/AntelopeJS/dms).

## Installation

```bash
ajs project modules add @antelopejs/payment-subscriptions
ajs project modules install
```

Wire it with these modules:

- A module that implements `@antelopejs/interface-payment`. That module makes
  the charges.
- A module that implements `@antelopejs/interface-database`, such as
  `@antelopejs/mongodb`. Every subscription lives there.
- Optionally, `@antelopejs/redis`, which implements both
  `@antelopejs/interface-redis` and `@antelopejs/interface-redis-scheduler`.
  With it, a renewal is charged when it is due instead of at the next poll.

The example below selects this module's renewal clock on purpose, with Stripe
payments and MongoDB storage. For Stripe's own billing, wire Stripe alone
instead. Set the three environment variables before startup.

```typescript [antelope.config.ts] docs-check
import { defineConfig } from "@antelopejs/interface-core/config";

export default defineConfig({
  name: "billing-project",
  modules: {
    subscriptions: {
      source: {
        type: "package",
        package: "@antelopejs/payment-subscriptions",
        version: "^0.0.3",
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
        version: "^1.6.0",
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
Wire it alone for Stripe's own subscriptions. If you wire this module beside it,
two modules implement the interface, and the core picks one by module ID. It
does not guess which one you meant. To use this module's clock with Stripe
charges, make the choice explicit. Add
`disabledExports: ["@antelopejs/interface-subscriptions"]` to the entry of the
Stripe module, or add an `importOverrides` entry on each consumer.

## How it works

- **The database is the only source of truth.** Each subscription is one record.
  The record holds its period, its status, when it next needs attention, and
  the events it has not delivered yet. The database alone is enough to recover
  a renewal.
- **The clock only triggers work.** With a Redis scheduler wired, each
  subscription is one Redis task that fires when it is due, and a slow database
  sweep catches any task that Redis loses. Without one, the module polls the
  database. Redis is optional, and nothing waits on it. A module with no Redis
  wired starts and renews. The suite checks the Redis scheduler through normal
  interface routing, with the `@antelopejs/core` version that `devDependencies`
  pins.
- **Charge recovery has a limit.** An instance claims a due renewal with a
  conditional write before it charges it. Of several instances that race, one
  charges and the rest stand down. The charge also carries an idempotency key
  built from the subscription, the period, and the attempt. An instance that
  takes over an abandoned claim can replay that key only within the configured
  provider guarantee, `guaranteedReplayMs`. Without that protection, an unknown
  result halts the subscription for reconciliation.

## Configuration

Every field is optional.

| Field                | Default                    | Meaning                                                                                             |
| -------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| `pollIntervalMs`     | 60 000                     | How often the module polls the database when no Redis scheduler is wired                            |
| `sweepIntervalMs`    | 900 000                    | How often the module sweeps the database when a Redis scheduler is wired                            |
| `leaseMs`            | 300 000                    | How long a claim on a renewal lasts before another instance can take it over                        |
| `retryDelaysMs`      | one, three, and seven days | The failed-renewal policy. One retry per entry, then the subscription ends                          |
| `settlementPollMs`   | 3 600 000                  | How often the module reads a charge that is still settling again                                    |
| `errorBackoffMs`     | 300 000                    | How long to wait when the payment provider cannot be reached at all                                 |
| `batchSize`          | 100                        | How many due subscriptions one sweep processes                                                      |
| `providerSchedule`   | `payment-interface`        | How the module mirrors the schedule with the provider. See the provider schedule page               |
| `guaranteedReplayMs` | `0`                        | The idempotency retention that the provider guarantees, minus a safety margin. Zero disables replay |

Durations are in milliseconds. A `guaranteedReplayMs` that is negative or not
finite makes the module throw
`guaranteedReplayMs must be a finite non-negative duration` at construction.
An unknown `providerSchedule` name also throws at construction.

For Stripe, use Stripe's native subscriptions by default. This module is a
fallback that you choose explicitly. Before you allow retries of uncertain
requests, check the retention guarantee of the provider for every wired account.
No portable API reports that capability, and the module does not assume a
Stripe-style 24-hour window. See
[reconciliation and operational recovery](./docs/3.failed-renewals.md#reconciliation-and-operational-recovery).

## Documentation

| Document                                               | Contents                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| [Introduction](./docs/1.introduction.md)               | What it implements, what it needs, what it records                        |
| [The renewal clock](./docs/2.renewal-clock.md)         | Polling and Redis, claims, idempotency, several instances                 |
| [Failed renewals](./docs/3.failed-renewals.md)         | The retry policy, settling charges, an unreachable provider               |
| [The provider schedule](./docs/4.provider-schedule.md) | The extension point for providers that store a schedule, such as Mangopay |

## Compatibility

<!-- antelopejs-docs-compat:start -->

| Package                                 | Supported        | Tested with |
| --------------------------------------- | ---------------- | ----------- |
| `@antelopejs/interface-core`            | `>=0.2.4 <1.0.0` | `0.4.0`     |
| `@antelopejs/interface-database`        | `>=0.2.0 <1.0.0` | `0.2.0`     |
| `@antelopejs/interface-payment`         | `>=0.0.2 <1.0.0` | `0.0.2`     |
| `@antelopejs/interface-redis`           | `>=0.0.9 <1.0.0` | `0.0.9`     |
| `@antelopejs/interface-redis-scheduler` | `>=0.0.9 <1.0.0` | `0.0.9`     |
| `@antelopejs/interface-subscriptions`   | `>=0.1.0 <0.2.0` | `0.1.0`     |

<!-- antelopejs-docs-compat:end -->

The table lists the interface requirements in `package.json`. Provider modules
can add requirements of their own. Check the compatibility table of each
provider module that you wire.

## Testing

`pnpm test` runs the suite twice, once per clock. Both runs use a real MongoDB,
and the second run also uses a real Redis. The suite starts both. The
conformance suite of the interface runs in both. A test-only payment provider in
`test/payment-provider` stands in for the payment module, and it is never
published. The scripts run `ajs module test .` from the `@antelopejs/core`
version that `devDependencies` pins.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md). Use the Node.js version in `.nvmrc`
and the pnpm version in the `packageManager` field of `package.json`:

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
