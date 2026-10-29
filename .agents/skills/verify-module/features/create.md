---
covers:
  - src/implementation.ts
  - src/initial.ts
  - src/view.ts
  - src/calendar.ts
docs:
  - README.md
  - docs/1.introduction.md
journeys:
  - create-and-read
  - idempotent-create
  - empty-and-unknown
  - validation-errors
  - trial-and-anchor
  - declined-initial
  - period-length
---

# Create

A consumer creates a subscription for a customer's saved payment method; the module validates it, charges the first period (unless a trial or anchor defers it), stores one record and answers it.

## Sub-features

- `create-and-read`: `CreateSubscription` answers an active, paid, one-month subscription; `GetSubscription` and `ListSubscriptions` answer the same one; MongoDB holds exactly one live record with the same customer, method, amount and charge; the project log says the polling clock was chosen.
- `idempotent-create`: the same idempotency key answers the same subscription and leaves one record; another key makes a second one.
- `empty-and-unknown`: a customer without subscriptions lists `[]`; `GetSubscription` of an unknown id is `SubscriptionNotFoundError`; nothing is stored.
- `validation-errors`: seven invalid requests are each rejected with `InvalidSubscriptionRequestError` naming its rule, and nothing is stored.
- `trial-and-anchor`: `trialEnd` gives a trialing subscription and `billingAnchor` an active one, both unpaid with the first period ending at that time; MongoDB shows the trial.
- `declined-initial`: a method the provider declines raises `SubscriptionPaymentError`, the customer ends with no subscription and replaying the key is refused the same way.
- `period-length`: 3 days, 2 weeks, 1 month and 1 year give periods of the matching length.

## How to get to it (user POV)

- A billing module calls `CreateSubscription(request, idempotencyKey)` from `@antelopejs/interface-subscriptions` after saving a payment method with the payment interface.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" create
```

## Gotchas

- The in-repo test payment provider (`test/payment-provider`) stands in for a real provider: `tok_succeeds` and `tok_declines_off_session` are its outcomes. Every journey starts from a dropped `verify` database.
