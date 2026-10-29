---
covers:
  - src/engine.ts
  - src/transitions.ts
  - src/triggers.ts
  - src/clock.ts
  - src/schedule.ts
  - src/index.ts
  - src/records.ts
docs:
  - README.md
  - docs/2.renewal-clock.md
  - docs/3.failed-renewals.md
  - docs/4.provider-schedule.md
journeys:
  - trial-renewal
  - failed-renewal-ends
  - survives-restart
  - redis-clock
---

# Renewal

The module owns the renewal clock: it polls MongoDB (or fires one Redis task per subscription), charges due renewals off-session, retries declines on the configured delays and announces the outcome.

## Sub-features

- `trial-renewal`: after a 2 s trial the subscription turns active by itself, the charge is recorded in the answer and in MongoDB, and `subscription.payment_succeeded` is announced.
- `failed-renewal-ends`: with `retryDelaysMs: [500, 500]` and a declining method the subscription goes past_due, then canceled with `payment_failed`; MongoDB agrees; three `payment_failed` events precede the `canceled` one.
- `survives-restart`: a subscription created with a 10 s trial is still in MongoDB while the module is stopped, is read back after the next `ajs project dev` and is charged by the new process (the in-memory test provider is refilled with the same ids first, because its state does not survive a restart). This is the containment journey of the Format door.
- `redis-clock`: with `@antelopejs/redis` wired the log says the Redis clock is chosen, `SchedulerUtil.Tasks` holds one `payment-subscriptions:<id>` task scored at the trial end, and cancelling removes it.

## How to get to it (user POV)

- The renewal happens by itself in a running project; the app developer sets `pollIntervalMs`, `retryDelaysMs` and optionally wires a Redis module.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" renewal
```

## Gotchas

- Journeys use `pollIntervalMs: 100`. The Redis clock keeps a timer alive, so its stop can take a few seconds.
