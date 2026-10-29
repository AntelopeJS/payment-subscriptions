---
covers:
  - src/config.ts
  - src/runtime.ts
docs:
  - README.md
  - docs/2.renewal-clock.md
journeys:
  - retry-policy
---

# Config

The configuration is resolved once at construct time; every field is optional and overrides a default.

## Sub-features

- `retry-policy`: with `retryDelaysMs: []` the first declined renewal ends the subscription with `payment_failed`, without a past_due step, and the events are exactly one `payment_failed` then `canceled`.

## How to get to it (user POV)

- `config: { pollIntervalMs, retryDelaysMs, ... }` of the module entry in `antelope.config.ts`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" config
```

## Gotchas

- The default delays are days long; journeys always set short ones.
