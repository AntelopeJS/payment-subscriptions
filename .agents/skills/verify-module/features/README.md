# Feature map

One file per feature. `covers:` lists the source globs it owns, `docs:` the pages a verdict judges, `journeys:` the journeys it runs, and `seeded-breaks/<feature>.patch` the break its journeys must catch. `pnpm exec antelopejs-verify map` checks that every user-facing file is covered. `implementation.ts` is shared by `create`, `cancel` and `payment-method`, so a change to it runs all three.

| Feature | What the user does | Journeys |
|---|---|---|
| [create](create.md) | Creates a subscription for a saved payment method and reads it back. | create-and-read, idempotent-create, empty-and-unknown, validation-errors, trial-and-anchor, declined-initial, period-length |
| [cancel](cancel.md) | Cancels now or at period end. | cancel-now, cancel-at-period-end, cancel-errors |
| [payment-method](payment-method.md) | Switches the method later renewals charge. | change-method, change-method-errors |
| [renewal](renewal.md) | Lets the module charge renewals on its own clock, retry declines and survive restarts. | trial-renewal, failed-renewal-ends, survives-restart, redis-clock |
| [events](events.md) | Receives subscription events. | event-delivery |
| [config](config.md) | Tunes the module with its configuration. | retry-policy |
| [smoke](smoke.md) | The fixed journey every verdict runs, with the real-provider leg not verified without sandbox keys. | create-and-read, provider-sandbox |
