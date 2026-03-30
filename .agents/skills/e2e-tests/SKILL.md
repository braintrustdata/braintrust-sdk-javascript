---
name: e2e-tests
description: Write, run, and debug end-to-end tests for the Braintrust SDK. Use when asked to add an e2e test, create a scenario, write an e2e scenario, add e2e coverage, debug e2e test, fix e2e snapshot, or any task involving the e2e/ directory.
---

# E2E Tests

E2E tests run SDK scenarios in subprocesses against a mock Braintrust server. Prefer extending the closest existing scenario over inventing a new pattern.

Read first:

- `e2e/README.md`
- Closest `e2e/scenarios/<name>/scenario.test.ts`
- Relevant shared helper in `e2e/helpers/`
- Relevant `assertions.ts` file when the scenario family already factors shared checks that way

## Workflow

1. Start from the closest existing scenario and keep its structure unless the new case clearly needs a new pattern.
2. Default to module-scope setup with `prepareScenarioDir({ scenarioDir: resolveScenarioDir(import.meta.url) })`. This copies the scenario into an isolated temp directory and installs any scenario-local dependencies before the test bodies run.
3. Use `withScenarioHarness(...)` for every scenario test. Pick the runner that matches the real entrypoint:
   - `runScenarioDir()` for default `tsx`-driven TypeScript scenarios
   - `runNodeScenarioDir()` for plain Node entrypoints and hook coverage
   - `runDenoScenarioDir()` for nested Deno runners
4. Snapshot stable contracts, not raw noise. Normalize before snapshotting and prefer focused summaries over full payload dumps.
5. Run the narrowest test first, then rerun updated scenarios three times before treating snapshots as stable.

## Commands

Run workspace scripts from the repo root when you want the standard e2e entrypoints:

```bash
pnpm run test:e2e
pnpm run test:e2e:hermetic # only run tests that don't rely on external services or llm providers
pnpm run test:e2e:update # updates snapshots
```

Try not to use specific test narrowing commands unless hunting down a very nasty and specific bug.

## Preferred Patterns

- Keep the expensive setup at module scope with `prepareScenarioDir(...)`. Only call `installScenarioDependencies(...)` directly when you are testing installer behavior or need a nonstandard setup.
- Run every scenario through `withScenarioHarness(...)`.
- Tag every test with exactly one tag from `e2e/helpers/tags.ts`.
- Keep reusable logic in `e2e/helpers/`. Keep one-off fixtures and scenario-specific files inside the scenario directory.
- Snapshot stable contracts, not raw noise. Use `normalizeForSnapshot(...)` before inline snapshots and `formatJsonFileSnapshot(...)` plus file snapshots for larger payloads or version matrices.
- When a scenario family already has `assertions.ts`, keep version- or provider-specific test setup in `scenario.test.ts` and reuse the shared assertions file.
- Run new or updated scenarios three times in a row before considering snapshots stable.

## Scenario Patterns

- SDK primitive scenarios: use `scenario.ts` with normal SDK calls and assert on `testRunEvents()`. See `trace-primitives-basic`.
- Wrapper scenarios: use `events()` rather than `testRunEvents()`, find the root span first, and scope payload snapshots with `payloadRowsForRootSpan(...)`. Pair span and payload snapshots when the wrapper emits merged log rows.
- Provider instrumentation scenarios often split setup and shared assertions. See `e2e/scenarios/anthropic-instrumentation/assertions.ts`, `e2e/scenarios/google-genai-instrumentation/assertions.ts`, and similar directories before creating a new pattern.
- Version matrix scenarios: put shared logic in `scenario.impl.*` or shared assertion helpers, then loop over versions from aliases or helper-generated scenario lists. Do not duplicate the same assertions per version by hand.
- Test runner integration scenarios (deno, vitest, jest, ...): keep the outer e2e suite in `scenario.test.ts`, the spawned entry in `scenario.ts`, and nested test files in names like `runner.case.ts`. Do not name nested runner files `*.test.ts`.

## Scenario-Local Dependencies

- Only add a scenario-local `package.json` for truly scenario-specific external dependencies.
- Workspace packages belong in `e2e/package.json` as `workspace:^`, not in scenario manifests.
- Do not use `workspace:` specs in scenario-local manifests.
- If a scenario manifest exists, commit its lockfile.

Generate the lockfile with:

```bash
pnpm install --dir e2e/scenarios/<name> --ignore-workspace --lockfile-only --strict-peer-dependencies=false
```

## Debugging

- Flaky snapshot: normalize the changing field instead of snapshotting around it.
- Request-flow assertions: grab `requestCursor()` before running the scenario, then inspect `requestsAfter(...)`.
- If the scenario is external-provider backed, confirm the required provider env var is set before debugging the assertions.
- Deno/browser scenarios may intentionally differ from Node. Assert the real runtime contract instead of copying Node expectations blindly.
