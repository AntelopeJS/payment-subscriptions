---
covers:
  - src/events.ts
docs:
  - README.md
  - docs/1.introduction.md
journeys:
  - event-delivery
---

# Events

Each change records its events in the same write as the change and delivers them to the handlers registered on `SubscriptionEvents`.

## Sub-features

- `event-delivery`: creating then cancelling announces `subscription.created`, `subscription.payment_succeeded` and `subscription.canceled` in that order, each with its subscription, unique ids and the charge id on the payment event; the MongoDB outbox is empty afterwards.

## How to get to it (user POV)

- A module calls `SubscriptionEvents.register(id, handler)`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" events
```

## Gotchas

- The fixture's bridge module is the registered handler and keeps every event.
