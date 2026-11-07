# Feature map

One file per feature. `covers:` lists the source globs it owns, `docs:` the pages a verdict judges, and `journeys:` the journeys it runs. `pnpm exec antelopejs-verify map` checks that every user-facing file is covered. Every journey but `provider-sandbox` starts the module with the in-repo test provider: `src/index.ts` loads every `src/*.ts` and the renewal clock runs the engine throughout, so those features cover `src/*.ts` and `test/payment-provider/*`, and a change to any of them runs them all. `provider-sandbox` starts nothing yet, so `sandbox` covers only the outbound funnel `src/schedule.ts`.

| Feature | What the user does | Journeys |
|---|---|---|
| [create](create.md) | Creates a subscription for a saved payment method and reads it back. | create-and-read, idempotent-create, empty-and-unknown, validation-errors, trial-and-anchor, declined-initial, period-length |
| [cancel](cancel.md) | Cancels now or at period end. | cancel-now, cancel-at-period-end, cancel-errors |
| [payment-method](payment-method.md) | Switches the method later renewals charge. | change-method, change-method-errors |
| [renewal](renewal.md) | Lets the module charge renewals on its own clock, retry declines and survive restarts. | trial-renewal, failed-renewal-ends, survives-restart, redis-clock |
| [events](events.md) | Receives subscription events. | event-delivery |
| [config](config.md) | Tunes the module with its configuration. | retry-policy |
| [charge](charge.md) | The request each charge sends to the payment provider. | charge-request |
| [sandbox](sandbox.md) | The first charge against a real Stripe sandbox. NOT VERIFIED without sandbox keys. | provider-sandbox |
| [smoke](smoke.md) | The fixed journey every verdict runs. | create-and-read |
