---
covers:
  - src/implementation.ts
docs:
  - README.md
  - docs/1.introduction.md
journeys:
  - change-method
  - change-method-errors
---

# Payment method

`UpdateSubscriptionPaymentMethod` switches the saved method later renewals are charged to.

## Sub-features

- `change-method`: the answer and the MongoDB record hold the new method of the same customer; replaying the key changes nothing.
- `change-method-errors`: another customer's method (`InvalidSubscriptionRequestError`), an unknown subscription (`SubscriptionNotFoundError`) and an ended subscription (`InvalidSubscriptionStateError`) are rejected and the stored method stays.

## How to get to it (user POV)

- `UpdateSubscriptionPaymentMethod(id, method, idempotencyKey)`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" payment-method
```

## Gotchas

- A second saved method of the same customer is made through the payment provider's `savePaymentMethod`.
