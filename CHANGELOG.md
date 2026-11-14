# Changelog

## v0.0.6

[compare changes](https://github.com/AntelopeJS/payment-subscriptions/compare/v0.0.5...v0.0.6)

### 📖 Documentation

- **readme:** Adopt the AntelopeJS framework README style ([#45](https://github.com/AntelopeJS/payment-subscriptions/pull/45))
- **agents:** Name the pinned core 1.21.0 and recheck its exit hang ([#46](https://github.com/AntelopeJS/payment-subscriptions/pull/46))
- **readme:** Use ~ ranges on the newest stripe and mongodb minors ([#51](https://github.com/AntelopeJS/payment-subscriptions/pull/51))

### 📦 Build

- **deps:** Require interface-redis-scheduler 0.0.12 and drop the test exit workaround ([#48](https://github.com/AntelopeJS/payment-subscriptions/pull/48))
- **deps:** ⚠️  Cap @antelopejs ranges on the newest published minors ([#50](https://github.com/AntelopeJS/payment-subscriptions/pull/50))

### ✅ Tests

- Deliver a new subscription's events before the clock moves ([#49](https://github.com/AntelopeJS/payment-subscriptions/pull/49))

### 🤖 CI

- Run the checks and tests on Windows beside Linux ([#47](https://github.com/AntelopeJS/payment-subscriptions/pull/47))

#### ⚠️ Breaking Changes

- **deps:** ⚠️  Cap @antelopejs ranges on the newest published minors ([#50](https://github.com/AntelopeJS/payment-subscriptions/pull/50))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.0.5

[compare changes](https://github.com/AntelopeJS/payment-subscriptions/compare/v0.0.4...v0.0.5)

### 🩹 Fixes

- **verify:** Cover the files every journey loads ([#39](https://github.com/AntelopeJS/payment-subscriptions/pull/39))
- **cancel:** Reject Object.prototype names as the cancellation timing ([#41](https://github.com/AntelopeJS/payment-subscriptions/pull/41))

### 📦 Build

- **deps:** Bump @antelopejs packages to the 2026-11-06 releases ([#35](https://github.com/AntelopeJS/payment-subscriptions/pull/35))
- **deps:** Bump @antelopejs/tooling-configs to 0.3.4 ([#36](https://github.com/AntelopeJS/payment-subscriptions/pull/36))
- **deps:** Bump @antelopejs/tooling-configs to 0.4.0 ([#42](https://github.com/AntelopeJS/payment-subscriptions/pull/42))
- **deps:** Wire the interface-ranges lint and align interface floors ([#40](https://github.com/AntelopeJS/payment-subscriptions/pull/40))
- **deps:** Bump @antelopejs/tooling-configs to 0.5.0 ([#43](https://github.com/AntelopeJS/payment-subscriptions/pull/43))
- **deps:** Bump @antelopejs/tooling-configs to 0.5.1 ([#44](https://github.com/AntelopeJS/payment-subscriptions/pull/44))

### 🏡 Chore

- Land the cleanup campaign on main ([#31](https://github.com/AntelopeJS/payment-subscriptions/pull/31))
- **verify:** Remove seeded runs from the verification skill ([#32](https://github.com/AntelopeJS/payment-subscriptions/pull/32))
- **ci:** Remove the weekly mutation caller ([#33](https://github.com/AntelopeJS/payment-subscriptions/pull/33))

### 🤖 CI

- Call ci-node.yml@v1 ([#34](https://github.com/AntelopeJS/payment-subscriptions/pull/34))
- Cache the compiled Redis test binary ([#37](https://github.com/AntelopeJS/payment-subscriptions/pull/37))
- Persist formal-check results between runs ([#38](https://github.com/AntelopeJS/payment-subscriptions/pull/38))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.0.4

[compare changes](https://github.com/AntelopeJS/payment-subscriptions/compare/v0.0.3...v0.0.4)

### 🚀 Enhancements

- **skills:** Add the verify-module verification skill ([#14](https://github.com/AntelopeJS/payment-subscriptions/pull/14))

### 🩹 Fixes

- **skills:** Make the verify containments catch their doors ([#15](https://github.com/AntelopeJS/payment-subscriptions/pull/15))

### 📖 Documentation

- **readme:** Use one Discord invite ([#22](https://github.com/AntelopeJS/payment-subscriptions/pull/22))
- **github:** Send questions and ideas to Discord ([#23](https://github.com/AntelopeJS/payment-subscriptions/pull/23))
- **readme:** Link the package to AntelopeJS and AntelopeJS DMS ([c2f91de](https://github.com/AntelopeJS/payment-subscriptions/commit/c2f91de))

### 📦 Build

- **deps:** Bump @antelopejs/tooling-configs to 0.2.17 ([#16](https://github.com/AntelopeJS/payment-subscriptions/pull/16))

### 🏡 Chore

- Land the cleanup campaign on main ([#29](https://github.com/AntelopeJS/payment-subscriptions/pull/29))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.0.3

[compare changes](https://github.com/AntelopeJS/payment-subscriptions/compare/v0.0.2...v0.0.3)

### 🩹 Fixes

- **triggers:** Ignore Redis tasks while the trigger is stopped ([#7](https://github.com/AntelopeJS/payment-subscriptions/pull/7))

### 💅 Refactors

- Clean the repo with the guardrail pack ([#13](https://github.com/AntelopeJS/payment-subscriptions/pull/13))

### 📦 Build

- **deps:** Adopt @antelopejs/interface-database 0.2.0 ([#9](https://github.com/AntelopeJS/payment-subscriptions/pull/9))
- **deps:** Adopt @antelopejs/interface-subscriptions 0.1.0 ([#10](https://github.com/AntelopeJS/payment-subscriptions/pull/10))

### 🏡 Chore

- Align public documentation and repository standards ([#4](https://github.com/AntelopeJS/payment-subscriptions/pull/4))
- Adopt the guardrail pack from tooling-configs 0.2.0 ([#5](https://github.com/AntelopeJS/payment-subscriptions/pull/5))
- Configure Renovate with the shared preset ([#6](https://github.com/AntelopeJS/payment-subscriptions/pull/6))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

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

