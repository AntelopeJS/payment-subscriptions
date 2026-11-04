---
covers:
docs:
  - README.md
journeys:
  - create-and-read
---

# Smoke

The fixed journey every verdict runs, whatever the diff touches: create a subscription against the in-repo test payment provider and MongoDB and read it back.

## Sub-features

- `create-and-read`: as in [create](create.md).

## How to get to it (user POV)

- A project with the module, a payment module, a database module and a consumer of `@antelopejs/interface-subscriptions`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" smoke
```

## Gotchas

- The smoke feature covers no glob, so it never marks a file as mapped. The real provider sandbox journey lives in [sandbox](sandbox.md), so a diff that touches no subscription code is judged on the in-repo journeys.
- Every other journey runs against the in-repo test provider, not a payment service, so a PASS of those journeys says nothing about Stripe, Adyen or any real account.
