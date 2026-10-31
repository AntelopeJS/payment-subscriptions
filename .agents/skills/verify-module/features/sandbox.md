---
covers:
  - src/schedule.ts
docs:
  - README.md
  - docs/4.provider-schedule.md
journeys:
  - charge-request
  - provider-sandbox
---

# Sandbox

The outbound funnel: every charge the module makes leaves through `src/schedule.ts` as an off-session `CreatePayment`. What only a real payment account can show is that the provider accepts that request.

## Sub-features

- `charge-request`: a subscription created with metadata makes a charge the in-repo test provider holds with the subscription's amount, reference, customer and method, and the metadata carries the subscription's own keys plus `antelopeSubscription` set to the subscription id.
- `provider-sandbox`: a real Stripe sandbox charge. Without `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` the journey is not verified, so a verdict that requires this feature is NOT VERIFIED, never PASS. With the keys present it still reports not verified: a Stripe-backed fixture is not written yet.

## How to get to it (user POV)

- A project with the module, `@antelopejs/stripe` in test mode, a database module and a consumer of `@antelopejs/interface-subscriptions`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" sandbox
```

## Gotchas

- Every other journey runs against the in-repo test provider, not a payment service, so a PASS of those journeys says nothing about Stripe or any real account.
