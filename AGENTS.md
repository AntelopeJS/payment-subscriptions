# payment-subscriptions

The AntelopeJS module `@antelopejs/payment-subscriptions`. It implements `@antelopejs/interface-subscriptions` on top of any `@antelopejs/interface-payment` provider, stores every subscription through `@antelopejs/interface-database`, and runs the renewal clock itself: database polling by default, or `@antelopejs/interface-redis-scheduler` when a Redis module is wired.

## Layout

- `src/`: the module. `implementation.ts` holds the interface implementation, `engine.ts` and `transitions.ts` the renewal state machine, `triggers.ts` the polling and Redis triggers, `schedule.ts` the provider schedule strategy chosen by the `providerSchedule` setting (the only one, `payment-interface`, charges off-session through `CreatePayment`), and `clock.ts` the replaceable time source the tests drive.
- `src/test/`: the mocha suites, compiled to `dist/test` and run by `ajs module test`. `src/test/antelope.test.ts` (`antelopeJs.test` in `package.json`) is the test project.
- `test/payment-provider/` (an in-memory payment provider) and `test/boot-probe/` (a consumer module) are plain-JS test modules loaded by path. They are never published; knip lists them as entries. Their types are JSDoc. `test/payment-provider/index.d.ts` is the typed face of the provider that `src/test/support.ts` imports (`src/` cannot import the `.js` itself: it sits outside `rootDir`), and `test/tsconfig.json` lists the two modules so the type-aware lint reads them with the Node types.

## Versioning

The interface packages are `dependencies` with ranges, and `@antelopejs/interface-redis` and `@antelopejs/interface-redis-scheduler` are `optionalDependencies`, so the module starts without Redis. The README compatibility table mirrors both blocks (`docs-compat` markers); change it with the ranges. `@antelopejs/core` is `~1.24.0`: the suite verifies Redis routing under that version. Recheck it when you bump it.

## Tests

- `pnpm test` builds `dist` once, then runs the suite twice: `test:polling`, then `test:redis` (`ANTELOPE_SUBSCRIPTIONS_TEST_CLOCK=redis`). The test project starts an in-memory MongoDB 8.0.8 (`mongodb-memory-server-core`) and, for the Redis run, Redis 8.10.2 (`redis-memory-server`); MongoDB downloads its binary on first use, and `redis-memory-server` downloads the Redis source and compiles `redis-server` into `~/.cache/redis-binaries/<version>` the first time a machine runs it (a parallel `make`, shared by every worktree; CI caches that folder, so a Redis bump changes the version in `src/test/antelope.test.ts` and in `cache-paths` of `.github/workflows/ci.yml` together), so the first run needs network access, `make` and a C compiler. Running `test:polling` or `test:redis` alone needs a built `dist`.
- `pnpm run checks` does not run the documentation check on `README.md` and `docs/`. CI runs it through the `docs-files` and `docs-typescript-project` inputs in `.github/workflows/ci.yml`, which also type-check the code examples against `docs/tsconfig.json`. To run it locally, clone `AntelopeJS/tooling-configs` at `v0.0.9` (the ref ci-node pins), run `npm ci --prefix actions/docs --omit=dev`, then run `node <clone>/actions/docs/check.mjs --files "$(printf 'README.md\ndocs')" --typescript-project docs/tsconfig.json` from this repository.

## Shipped files

`docs/` and `skills/` ship in the npm package. `skills/payment-subscriptions/SKILL.md` reaches users through `antelopeJs.skills`; update it when configuration or behaviour changes.

<!-- antelopejs-guardrails:start -->
<!-- Managed by @antelopejs/tooling-configs. `antelopejs-sync` rewrites everything between these markers; write repository-specific guidance outside them. -->

## Guardrails

CI runs `pnpm run checks` in full on every pull request and reports what failed. The commit hook formats and lints the staged files. Locally, check only what you touched, one test file and not the suite, as the [`verify-changes`](.agents/skills/verify-changes/SKILL.md) skill says.

### Comments

Say it in code: a constraint in a type, a lint rule or a test, a public item's contract in TSDoc. Other comments are lint directives naming their rules, `@ts-expect-error <reason>`, `SAFETY: <reason>` above a type assertion, and license or tool directives. A reason states what the code does now.

### Tests

Each test names the wrong implementation it fails on, or is deleted. Drive behaviour through the public interface. An invariant over many files is a lint rule.

### Review

No tool checks these:

- A type guard checks the nested elements and values it claims.
- A no-upward import rule rejects same-tier peers; probe it with an import.
- A finding only an evasion or a patched internal can trigger goes under Attention and never blocks.

### Suppressions

`guardrails.suppressions.json` caps lint directives, `@ts-expect-error`, `SAFETY:` comments and rules a lint config turns off. Over a cap, fix the code or remove another suppression of that kind; only the operator raises a number. After removing suppressions, run `pnpm run suppressions:update` and commit the file.

<!-- antelopejs-guardrails:end -->
