---
covers:
docs:
  - README.md
journeys:
  - create-and-read
  - provider-sandbox
---

# Smoke

The fixed journey every verdict runs, whatever the diff touches: create a subscription against the in-repo test payment provider and MongoDB, read it back, and try the real provider sandbox.

## Sub-features

- `create-and-read`: as in [create](create.md).
- `provider-sandbox`: a real Stripe sandbox charge. Without `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` the journey is not verified, so the verdict is NOT VERIFIED, never PASS. With the keys present it still reports not verified: a Stripe-backed fixture is not written yet.

## How to get to it (user POV)

- A project with the module, a payment module, a database module and a consumer of `@antelopejs/interface-subscriptions`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" smoke
```

## Gotchas

- The smoke feature covers no glob, so it never marks a file as mapped.
- Every other journey runs against the in-repo test provider, not a payment service, so a PASS of those journeys says nothing about Stripe, Adyen or any real account.
