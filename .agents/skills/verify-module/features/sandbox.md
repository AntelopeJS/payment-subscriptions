---
covers:
  - src/calendar.ts
docs:
  - README.md
journeys:
  - period-length
  - provider-sandbox
---

# Sandbox

What only a real payment account can show: that the charge dates the module computes are accepted by the provider.

## Sub-features

- `period-length`: as in [create](create.md): the periods the module charges for have the length the request asked for, which the in-repo test provider can check.
- `provider-sandbox`: a real Stripe sandbox charge. Without `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` the journey is not verified, so a verdict that requires this feature is NOT VERIFIED, never PASS. With the keys present it still reports not verified: a Stripe-backed fixture is not written yet.

## How to get to it (user POV)

- A project with the module, `@antelopejs/stripe` in test mode, a database module and a consumer of `@antelopejs/interface-subscriptions`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" sandbox
```

## Gotchas

- Every other journey runs against the in-repo test provider, not a payment service, so a PASS of those journeys says nothing about Stripe or any real account.
