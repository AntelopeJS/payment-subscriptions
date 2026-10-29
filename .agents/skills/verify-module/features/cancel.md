---
covers:
  - src/implementation.ts
docs:
  - README.md
  - docs/1.introduction.md
journeys:
  - cancel-now
  - cancel-at-period-end
  - cancel-errors
---

# Cancel

`CancelSubscription` ends a subscription now or flags it to end with its period.

## Sub-features

- `cancel-now`: the answer and the MongoDB record are canceled with reason `requested` and an end time; the charge is unchanged after the clock had time to run.
- `cancel-at-period-end`: the subscription stays active and is flagged in the answer and in MongoDB.
- `cancel-errors`: unknown id (`SubscriptionNotFoundError`), unknown timing (`InvalidSubscriptionRequestError`) and a second cancel with a new key (`InvalidSubscriptionStateError`) are rejected; replaying a key answers the canceled subscription.

## How to get to it (user POV)

- `CancelSubscription(id, idempotencyKey, "now" | "period_end")`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" cancel
```

## Gotchas

- Cancellation keys are remembered per subscription; a replayed key is not an error.
