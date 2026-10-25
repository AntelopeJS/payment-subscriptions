# payment-subscriptions

The AntelopeJS module `@antelopejs/payment-subscriptions`. It implements `@antelopejs/interface-subscriptions` on top of any `@antelopejs/interface-payment` provider, stores every subscription through `@antelopejs/interface-database`, and runs the renewal clock itself: database polling by default, or `@antelopejs/interface-redis-scheduler` when a Redis module is wired.

## Layout

- `src/`: the module. `implementation.ts` holds the interface implementation, `engine.ts` and `transitions.ts` the renewal state machine, `triggers.ts` the polling and Redis triggers, `schedule.ts` the provider schedule mirror, and `clock.ts` the replaceable time source the tests drive.
- `src/test/`: the mocha suites, compiled to `dist/test` and run by `ajs module test`. `src/test/antelope.test.ts` (`antelopeJs.test` in `package.json`) is the test project.
- `test/payment-provider/` (an in-memory payment provider) and `test/boot-probe/` (a consumer module) are plain-JS test modules loaded by path. They are never published; knip lists them as entries.

## Versioning

The interface packages are `dependencies` with ranges, and `@antelopejs/interface-redis` and `@antelopejs/interface-redis-scheduler` are `optionalDependencies`, so the module starts without Redis. The README compatibility table mirrors both blocks (`docs-compat` markers); change it with the ranges. `@antelopejs/core` is pinned to `1.16.0`: the suite verifies Redis routing under that version, and `src/test/antelope.test.ts` works around its exit hang after the Redis run. Recheck both when you bump it.

## Tests

- `pnpm test` builds `dist` once, then runs the suite twice: `test:polling`, then `test:redis` (`ANTELOPE_SUBSCRIPTIONS_TEST_CLOCK=redis`). The test project starts an in-memory MongoDB 8.0.8 (`mongodb-memory-server-core`) and, for the Redis run, `redis-memory-server`; both download their binaries on first use, so the first run needs network access. Running `test:polling` or `test:redis` alone needs a built `dist`.
- `pnpm run checks` does not run the documentation check on `README.md` and `docs/`. CI runs it through the `docs-files` inputs in `.github/workflows/ci.yml`.

## Shipped files

`docs/` and `skills/` ship in the npm package. `skills/payment-subscriptions/SKILL.md` reaches users through `antelopeJs.skills`; update it when configuration or behaviour changes.

<!-- antelopejs-guardrails:start -->
<!-- Managed by @antelopejs/tooling-configs. `antelopejs-sync` rewrites everything between these markers; write repository-specific guidance outside them. -->

## Guardrails

Finish every change with `pnpm run checks`. It runs typecheck, lint, format, knip, tests, size, ratchet, and sync, and prints only what failed. The change is done when it prints no failure.

The tools enforce most rules, listed in the table at the end. The sections below hold the rules no tool checks.

### Comments

Say it in code. A constraint belongs in a type, a lint rule, or a test. A public item's contract belongs in TSDoc (`/** */`) on that item. The only other comments are lint directives that name their rules, `@ts-expect-error <reason>`, `SAFETY: <reason>` above a type assertion, `/*!` license headers, and bundler or formatter directives.

### Tests

Hold every test you write or keep to this checklist:

- Name the wrong implementation this test fails on. A test with no answer is deleted, not kept.
- No test reads the file it tests. Drive the behaviour through the public interface.
- An invariant over many files is a lint rule, not a test.

### Debt

`guardrails.ratchet.json` records the lint findings and oversize files this repository already had. Its numbers only go down. After you remove debt, run `pnpm run ratchet:update` and commit the lowered file. A rule listed there is off for `oxlint`. The ratchet counts it instead, and the pre-commit hook rejects it on every line you add.

### What enforces what

| Rule                                                                           | Enforced by                               |
| ------------------------------------------------------------------------------ | ----------------------------------------- |
| Formatting                                                                     | oxfmt                                     |
| Lint findings are errors; no rule warns                                        | oxlint preset                             |
| Comments are TSDoc, directives, or `SAFETY:` only                              | `antelopejs/no-comments`                  |
| Every test asserts                                                             | `antelopejs/require-assertion`            |
| Tests read no files outside fixtures, helpers, locales                         | `antelopejs/no-fs-read-in-tests`          |
| No assertion that restates a constant                                          | `antelopejs/no-constant-value-assertion`  |
| No test whose only check is "is a function"                                    | `antelopejs/no-typeof-function-only-test` |
| Params ≤ 5, function ≤ 120 lines, file ≤ 500 lines, depth ≤ 4, complexity ≤ 20 | `eslint/max-*`, `eslint/complexity`       |
| Files ≤ 20,000 bytes, tests included                                           | `antelopejs-check-size` (pre-commit)      |
| Existing debt only shrinks                                                     | `antelopejs-ratchet`                      |
| Types check                                                                    | `tsc` (pre-push)                          |
| No dead files, exports, or dependencies                                        | knip                                      |
| Managed files match the pack                                                   | `antelopejs-sync --check`                 |
| A test names the wrong implementation it catches                               | review; no tool                           |

<!-- antelopejs-guardrails:end -->
