# Changelog

## v0.0.2


### 🚀 Enhancements

- Generic subscriptions on any payment provider, with its own renewal clock ([3faaa26](https://github.com/AntelopeJS/payment-subscriptions/commit/3faaa26))

### 🩹 Fixes

- Refusals decline, cancelled subscriptions never charge again, in-doubt retries keep their method ([37cab6b](https://github.com/AntelopeJS/payment-subscriptions/commit/37cab6b))
- Bound uncertain subscription charge recovery ([#3](https://github.com/AntelopeJS/payment-subscriptions/pull/3))

### 💅 Refactors

- Keep TSDoc to the public surface, and drive the Redis trigger in the suite ([89c339f](https://github.com/AntelopeJS/payment-subscriptions/commit/89c339f))
- Validate requests with the interface's own rules ([f08a792](https://github.com/AntelopeJS/payment-subscriptions/commit/f08a792))

### 📖 Documentation

- Refusals, in-doubt charges, stalls and abandoned creations ([a1931ba](https://github.com/AntelopeJS/payment-subscriptions/commit/a1931ba))
- Choosing between this module and a native implementation ([bdb266c](https://github.com/AntelopeJS/payment-subscriptions/commit/bdb266c))
- **agents:** Simplify repository guidance ([#2](https://github.com/AntelopeJS/payment-subscriptions/pull/2))

### ✅ Tests

- A stale outcome does not move a renewal twice ([b9fd24e](https://github.com/AntelopeJS/payment-subscriptions/commit/b9fd24e))
- A stale outage outcome must not bring the next renewal forward ([f781cae](https://github.com/AntelopeJS/payment-subscriptions/commit/f781cae))
- Split the instance tests by what they show ([8a53b7c](https://github.com/AntelopeJS/payment-subscriptions/commit/8a53b7c))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>
- Thomasims <thomas@antelopejs.com>

