---
covers:
  - src/*.ts
  - test/payment-provider/*
docs:
  - README.md
  - docs/4.provider-schedule.md
journeys:
  - charge-request
---

# Charge

Every charge, the first and each renewal, leaves through `src/schedule.ts` as an off-session `CreatePayment` on the customer's saved method.

## Sub-features

- `charge-request`: a subscription created with metadata makes a charge the in-repo test provider holds with the subscription's amount, reference, customer and method, and the metadata carries the subscription's own keys plus `antelopeSubscription` set to the subscription id.

## How to get to it (user POV)

- `CreateSubscription` with `metadata`, then the payment the provider received.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" charge
```

## Gotchas

- The charge lands in the in-repo test provider; what a real provider accepts is the `sandbox` feature.
