# SDK-864 review notes

Starting SDK SHA: `2682658b37edb9c44a8fb2468ae2dcf49acc365d` (clean checkout).
Spec `main` checked on 2026-11-18: `93867eca0b8cdea036569401c03a3623f13de9c2`,
identical to the audited contract. Read the audio traces, instrumentation guide,
and multimodal payload contract, plus Python PR #1130 and its tests. No spec
conflict or spec/support-data change was identified. Changes remain local.
Branch: `davidelner/sdk-864-typescript-livekit-cascade-cleanup`.

Rechecked spec `main` on 2026-11-19 at
`2107e260d813b6380ea75a9280166c6f800361af`. The only intervening change is
merged spec #90: audio schema 3.1.0 and canonical `eou_wait`. Read the revised
audio contract; the instrumentation guide and media contract are unchanged.
The SDK rebase preserves the corresponding merged #2806 implementation and its
regressions. The client ownership/task/model contract is unchanged; no conflict
or spec edit is needed. Published support assessments remain a release follow-up.

## Implementation

- `livekit-plugin.ts`: task wrappers, actual service execution scopes, separate
  framework model children, recognition operations versus transcript receipts,
  retry/stream/cancellation/session cleanup, canonical fallback media payloads,
  observed usage and TTFT on model children only.
- `livekit-interceptors.ts`, `livekit-wrapping.ts`, the LiveKit auto config,
  vendored types, and `wrappers/livekit.ts`: shared invocation hooks for both
  entrypoints; removed inference suppression. Wrapping stays separate from
  tracing. No public configuration was added.
- `instrumentation-content-policy.ts` and `logger/core.ts`: internal dynamic
  content policy inherited by provider descendants and applied before attachment
  processing at export. Environment, job, and native session redaction each win;
  the policy survives session cleanup. Manual user spans retain their existing
  behavior. Explicit logger attachment opt-outs also restrict voice capture.
- `openai-media.ts` and `attachment-utils.ts`: independent user/agent voice
  switches at provider boundaries. Generic attachment consent still controls
  other media; unrelated chat/Agents attachment policies are preserved outside
  the LiveKit boundary. Redaction removes provider inputs, outputs, errors, and sensitive
  metadata while preserving model/provider metadata and metrics.
- Unit tests and LiveKit e2e scenarios cover ownership, parenting, transformed
  synthesis text, receipts, streaming, retries, errors, cancellation, concurrent
  sessions, late redaction, and capture consent. OpenAI e2e capture fixtures now
  explicitly consent to both voice directions.

## Representative verified trees

Relevant subtrees; native operational task spans are omitted here for brevity.
The paired JSON/text snapshots retain the full trees and payloads.

```text
SDK client, provider enabled       SDK client, provider disabled
stt : task                        stt : task
└─ openai.audio.transcriptions.create : llm
llm_response : task               llm_response : task
└─ Chat Completion : llm
tts : task                        tts : task
└─ openai.audio.speech.create : llm

Application HTTP client, provider enabled OR disabled
stt : task
└─ livekit.stt : llm
llm_response : task
└─ livekit.llm_response : llm
tts : task
└─ livekit.tts : llm

Transcript callback without observed recognition operation
user_turn : task
└─ transcript_received : task
```

The e2e matrix exercises automatic and manual entrypoints in every ownership
state. Long-lived recognition streams have one observed operation, with separate
receipt events for final transcripts; receipts are never backdated. Unit tests
assert parent IDs and that wrapper metrics contain only their own start/end.

Full examples: [SDK client trace](../e2e/scenarios/livekit-instrumentation/__snapshots__/livekit-v1-discrete.span-tree.txt)
and [application HTTP client trace](../e2e/scenarios/livekit-instrumentation/__snapshots__/livekit-v1-direct.span-tree.txt).

## Qualified dependencies and limits

| Variant | agents / plugin-openai | rtc-node | OpenAI SDK |
| ------- | ---------------------- | -------- | ---------- |
| pinned  | 1.9.1 / 1.9.1          | 1.1.0    | 6.49.0     |
| latest  | 1.10.0 / 1.10.0        | 1.2.2    | 6.49.0     |

The provider regression matrix also exercises OpenAI 4.104.0, 5.11.0, 5.23.2,
6.25.0, 6.49.0, 7.30.0, and 7.32.0 (pinned/latest aliases).

**Updated ownership boundary:** the OpenAI plugin's public constructors are
observed in both automatic and manual modes. Public `client` options distinguish
SDK clients from injected HTTP clients before work begins, even when provider
tracing is disabled. The qualified default constructors use the OpenAI SDK;
stock STT streaming owns its own WebSocket. Method-source classification, OpenAI
resource `_client` inspection, and private LiveKit stream-client inspection have
been removed. The custom-client cassette scenarios now inject clients into the
real stock constructors rather than overriding adapter methods/private fields.

Manual instrumentation now also wraps the OpenAI plugin module **before** adapter
construction: `const openai = wrapLiveKit(await import("@livekit/agents-plugin-openai"))`.
The usual OpenAI integration must still be enabled/wrapped for SDK model spans;
LiveKit does not activate it. Existing instances constructed before observation
cannot have hidden clients recovered. Custom subclasses replacing operations
are not assigned the base implementation's ownership. Other third-party plugins
still require qualification of their own documented client/operation boundary;
this change does not claim universal ownership discovery for arbitrary adapters.
An exposed Anthropic SDK 0.60.0 client is also tested through real provider hooks in
focused tests (enabled and unwrapped), without claiming support for an untested
LiveKit Anthropic plugin's private client layout.

See [public interface audit](livekit-public-interface-audit.md) for the retained,
version-qualified lifecycle and protected stream bridges, and the separate
[teammate proposal](livekit-client-ownership-proposal.md) for the API tradeoff and
upstream accessor alternative.

New Realtime/duplex instrumentation is outside this change. The existing native
cascade/streaming coverage is retained. Redaction cannot retract records or
attachments that were already uploaded before the setting changed.

## Validation

Toolchain installed with `mise install`: Node 26.8.2, pnpm 10.33.0. On this machine
pnpm otherwise selected Homebrew Node 26.5.0 for subprocesses, so final validation
explicitly prepended the mise Node bin directory **inside** `pnpm exec env`.

Commands run from the repository root (the `--dir` options select packages).
The Node directory below resolves to the explicit absolute Node 26.8.2 path
used in the final invocations:

```sh
mise install
SDK864_NODE_BIN="$(mise where node)/bin"

# Passed: build, source/test types, formatting, lint (existing warnings).
mise exec -- pnpm exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vite-plus/bin/vp run -r build
mise exec -- pnpm --dir js run check:typings
mise exec -- pnpm --dir js exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/typescript/bin/tsc --noEmit
mise exec -- pnpm --dir js exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json
mise exec -- pnpm run fix:formatting
mise exec -- pnpm exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vite-plus/bin/vp lint .

# Passed: 369 tests in nine files, including real provider invocation hooks.
mise exec -- pnpm --dir js exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vitest/vitest.mjs run src/instrumentation/providers/livekit-plugin.test.ts src/wrappers/livekit.test.ts src/instrumentation/providers/openai-media.test.ts src/instrumentation/providers/openai-instrumentation.test.ts src/wrappers/attachment-utils.test.ts src/attachment-capture.test.ts src/span-customizer.test.ts src/logger-json-attachment.test.ts src/logger/lifecycle.test.ts

# Passed: eight real-provider recordings, 54 other cases deliberately unselected.
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" BRAINTRUST_E2E_CASSETTE_MODE=record node ./node_modules/vitest/vitest.mjs run scenarios/livekit-instrumentation/scenario.test.ts -t 'discrete recognition$' --update

# Passed: all 62 cases; paired snapshots regenerated through the runner.
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs --update livekit-instrumentation

# Passed: three consecutive 62-case replays with no snapshot drift, followed
# by another 62-case replay after rebuilding the final client-precedence fix.
# All four cassette audits reported zero unused variants; no tests skipped.
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs --check-cassettes livekit-instrumentation

# Provider regressions: 787 cases, repeated three times after the final build.
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs openai-instrumentation ai-sdk-audio-instrumentation
```

The broader attachment-wrapper test file
`js/src/wrappers/test_oai_attachments.test.ts` has four failures and three unhandled
rejections. The same failures were reproduced at the unchanged starting SHA in
an isolated `git archive` checkout. Its assertions expect request arguments to
be mutated into attachments. The nine-file regression selection excluding
that pre-existing failure passes 369 tests, including the attachment capture file.

New cassettes were recorded against real inexpensive OpenAI models with valid
audio. Multipart normalization changes only random transport delimiters; fields
and audio bytes remain part of request matching. All new cassette JSON and blobs
were checked against locally configured secret values; none were found.

## Review follow-up (2026-11-18)

The three review findings are addressed locally: public-constructor client
ownership, producer-side attribution of buffered retry output/usage, and reported
reasoning/cache usage plus normalized served tier. Redaction retains canonical
requested/served tier metadata while still removing content. Conversation/handoff
observation now uses public `AgentSession.emit` rather than `_conversationItemAdded`.

New controlled-failure subprocess cases use real LiveKit classes in both versions
and both entrypoints. They exercise custom versus SDK clients with provider
instrumentation on/off, and delay consumption until both retry attempts finish.
These probes are framework regressions, not live-provider verification. The
existing provider cassette matrix remains a separate check. The direct-client
cassettes were re-recorded using public constructor injection and real provider
traffic; no provider responses were fabricated.

The validation above records the original implementation run. Follow-up results
and exact commands follow below.

Follow-up validation (same pinned toolchain and dependency versions):

- Focused regression selection plus transformer tests: **384 passed in ten files**.
  This includes actual OpenAI/Anthropic hook execution, constructor semantics and
  minified export aliases, omission of unavailable usage, separate retry PCM,
  and preservation of tier metadata under redaction.
- Real-framework controlled-failure selection: **20 passed**, with 62 other
  cases intentionally unselected in that focused invocation. All 20 are also
  included in the complete 82-case suite.
- Revised public-injection direct-client recording: **four passed**, using real
  provider traffic; the two revised cassette variants were checked against
  configured secrets (four JSON/blob files; zero leaks).
- Full paired-snapshot update: **82 passed**, 12 snapshot files updated in that
  invocation (in addition to the direct-recording snapshot update).
- Three consecutive normal replay runs: **82 passed per run**, with no snapshot
  drift and zero unused cassette variants in each audit. Both LiveKit 1.9.1 and
  1.10.0 are included in every run.
- Root build, `js` source/test typing checks, formatting and lint passed (lint
  retains repository warnings). `git diff --check` passed.
- An additional ad hoc `tsc --noEmit` from `e2e/` does **not** pass: 371 diagnostics
  across the mixed-runtime scenario tree, including missing Deno globals and
  scenario-specific dependency/type errors. There are no diagnostics in
  `scenarios/livekit-instrumentation/`. This package has no `check:typings`
  script; this ad hoc whole-tree check is not counted as a passing check.
- The earlier 787-case provider matrix was not rerun for this follow-up. Provider
  hooks and media/privacy behavior are exercised by the focused tests and full
  LiveKit suite; the original provider-matrix results above remain historical.

Follow-up commands, from repository root, with `SDK864_NODE_BIN` as defined above:

```sh
mise exec -- pnpm exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vite-plus/bin/vp run -r build
mise exec -- pnpm --dir js run check:typings
mise exec -- pnpm --dir js exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vitest/vitest.mjs run src/auto-instrumentations/orchestrion-js/transforms.test.ts src/instrumentation/providers/livekit-plugin.test.ts src/wrappers/livekit.test.ts src/instrumentation/providers/openai-media.test.ts src/instrumentation/providers/openai-instrumentation.test.ts src/wrappers/attachment-utils.test.ts src/attachment-capture.test.ts src/span-customizer.test.ts src/logger-json-attachment.test.ts src/logger/lifecycle.test.ts
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vitest/vitest.mjs run scenarios/livekit-instrumentation/scenario.test.ts -t 'attempt-local|public constructors'
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" BRAINTRUST_E2E_CASSETTE_MODE=record node ./node_modules/vitest/vitest.mjs run scenarios/livekit-instrumentation/scenario.test.ts -t 'direct client discrete recognition$' --update
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs --update livekit-instrumentation
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs --check-cassettes livekit-instrumentation
mise exec -- pnpm run fix:formatting
mise exec -- pnpm run formatting
mise exec -- pnpm exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vite-plus/bin/vp lint .
git diff --check
```

Remaining coverage limits for this follow-up: framework-driven VAD segmentation
for discrete STT is still unverified; the real-provider discrete cases submit a
fixed recording through actual `recognize()`. Minified constructor aliases are
covered by transformer runtime tests, not a separately minified LiveKit bundle.
The Anthropic check uses a public exposed client in a focused test, not a real
LiveKit Anthropic plugin or live provider traffic. Arbitrary subclasses that
replace operations still need their own exposed client boundary/qualification.

## Local PR stack (rebased 2026-11-19)

The implementation is split into local commits, without pushing or opening PRs:

| Layer                                     | Commit     | Branch                                                  |
| ----------------------------------------- | ---------- | ------------------------------------------------------- |
| Provider privacy policy                   | `bf008292` | `davidelner/sdk-864-1-provider-policy`                  |
| Public events and shared invocation hooks | `499e13b3` | `davidelner/sdk-864-2-livekit-hooks`                    |
| Public constructor ownership API          | `8cc74fc9` | `davidelner/sdk-864-3-client-ownership`                 |
| Audio task/model contract                 | `HEAD`     | `davidelner/sdk-864-typescript-livekit-cascade-cleanup` |

The ownership API is independently reviewable in layer 3; routing in layer 4
depends on its result. STT operation lifetime stays with model finalization in
layer 4 so they share one cleanup implementation. Layer 2 provides the generic
service/worker/queue hooks and the public conversation event boundary. No layer
introduces method-source client classification or private-client inspection.

Each layer carries applicable tests. The privacy layer's snapshot update is
limited to caller-context fields introduced by the policy scope: all 14 changed
JSON trees were compared structurally against their predecessors, and all fields
outside context match. Both JSON and text were regenerated through the runner.
The initial replay exposed this expected drift; its failures were resolved by
the runner update and followed by three successful normal replays.

Stack validation before the 2026-11-19 rebase (all pass):

| Layer | Focused tests       | SDK source/test typings | Build  | Normal LiveKit replay            | Other verification                                          |
| ----- | ------------------- | ----------------------- | ------ | -------------------------------- | ----------------------------------------------------------- |
| 1     | 343 in eight files  | passed                  | passed | 38 cases, three consecutive runs | 787 provider/audio cases, three consecutive runs; root lint |
| 2     | 108 in three files  | passed                  | passed | 38 cases                         | affected-file lint                                          |
| 3     | 126 in five files   | passed                  | passed | 38 cases                         | affected-file lint                                          |
| 4     | 399 in twelve files | passed                  | passed | 82 cases                         | 787 provider/audio cases; root lint                         |

Every normal LiveKit replay above used `--check-cassettes` and reported zero
unused variants. Before the rebase, the final source, scenarios, cassettes,
snapshots, public audit, and ownership proposal were compared against the
pre-stack backup: all 75
implementation/scenario/proposal files match byte for byte. The review notes are
intentionally extended; two standalone boundary test files and this stack's
handoff are additional. The earlier three 82-case follow-up replays therefore
remain relevant, with one additional fresh final-stack replay recorded here.

The earlier note that the provider matrix was not rerun describes the initial
review follow-up only. The fresh stack runs above include that matrix again.
No provider traffic was rerecorded while splitting the stack.

Exact stack commands, run from repository root with `SDK864_NODE_BIN` as defined
above (the numeric suffix in each log identifies its stack layer):

```sh
# Every layer: build and SDK source/test checking.
mise exec -- pnpm exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vite-plus/bin/vp run -r build
mise exec -- pnpm --dir js run check:typings

# Layer 1 focused tests: 343 passed.
mise exec -- pnpm --dir js exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vitest/vitest.mjs run src/instrumentation/providers/livekit-plugin.test.ts src/instrumentation/providers/openai-media.test.ts src/instrumentation/providers/openai-instrumentation.test.ts src/wrappers/attachment-utils.test.ts src/attachment-capture.test.ts src/span-customizer.test.ts src/logger-json-attachment.test.ts src/logger/lifecycle.test.ts

# Layer 2 focused tests: 108 passed.
mise exec -- pnpm --dir js exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vitest/vitest.mjs run src/instrumentation/providers/livekit-plugin.test.ts src/wrappers/livekit.test.ts src/instrumentation/providers/livekit-wrapping.test.ts

# Layer 3 focused tests: 126 passed.
mise exec -- pnpm --dir js exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vitest/vitest.mjs run src/instrumentation/providers/livekit-plugin.test.ts src/wrappers/livekit.test.ts src/instrumentation/providers/livekit-wrapping.test.ts src/instrumentation/providers/livekit-client-ownership.test.ts src/auto-instrumentations/orchestrion-js/transforms.test.ts

# Final tip also checked source/test types explicitly with pinned Node.
mise exec -- pnpm --dir js exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/typescript/bin/tsc --noEmit
mise exec -- pnpm --dir js exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json

# Final focused selection: 399 passed.
mise exec -- pnpm --dir js exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vitest/vitest.mjs run src/auto-instrumentations/orchestrion-js/transforms.test.ts src/instrumentation/providers/livekit-plugin.test.ts src/wrappers/livekit.test.ts src/instrumentation/providers/livekit-wrapping.test.ts src/instrumentation/providers/livekit-client-ownership.test.ts src/instrumentation/providers/openai-media.test.ts src/instrumentation/providers/openai-instrumentation.test.ts src/wrappers/attachment-utils.test.ts src/attachment-capture.test.ts src/span-customizer.test.ts src/logger-json-attachment.test.ts src/logger/lifecycle.test.ts

# Layer 1: paired snapshot regeneration, then three normal audited replays.
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs --update livekit-instrumentation
# Run three times on layer 1; once on each subsequent layer.
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs --check-cassettes livekit-instrumentation

# Three times on layer 1, once on the final layer: 787 passed per run.
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs openai-instrumentation ai-sdk-audio-instrumentation

# Root lint on layers 1 and 4; changed files were linted on layers 2 and 3.
mise exec -- pnpm exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vite-plus/bin/vp lint .
mise exec -- pnpm run fix:formatting
mise exec -- pnpm run formatting
git diff --check
```

Fresh run logs are `/tmp/sdk864-stack-{1,2,3,4}-*.log`. Pre-commit hooks also scan
staged changes for secrets and format staged files. The full e2e-tree typing and
baseline attachment-wrapper limitations documented above remain visible; no
whole-repository unit-test pass is claimed.

See [the review handoff](livekit-stack-review-handoff.md) for the review order,
original P2 probes, remaining private bridges, and unqualified paths.

## Rebase checks (2026-11-19)

Rebased all four local endpoints onto SDK `origin/main`
`c26ce3c7cc2d084441505800f5fcb7c1e205be4d`. Ownership layer 3 is patch-identical
before and after the rebase. The policy and hook layers retain main's schema
version and EOU hooks. Layer 4 keeps canonical EOU timing and drops the obsolete
native request-to-wrapper model-field folding.

- 442 focused unit/regression tests in the same twelve-file selection passed,
  including main's added EOU cases. Two receipt-only EOU assertions now require
  `transcript_received`; receipt start and end both stay at the receipt timestamp.
- Workspace build, SDK source/test type checks, root lint and formatting passed.
- 787 OpenAI/audio provider cases passed.
- Full LiveKit snapshot regeneration passed all 92 cases. Inspection caught extra
  empty provider spans in the newly inherited combined-mode streaming fixture.
  The focused probe reproduced four chat spans for two model requests when both
  `wrapOpenAI` and the OpenAI auto hook were active. The fixture now chooses one
  OpenAI path while still combining both LiveKit paths, and explicitly asserts
  one model child per LLM task with nonzero reported usage.
- The six streaming cases passed a runner snapshot update and two consecutive
  normal replay runs. The final full replay below also covers those six cases.
- The final normal full LiveKit replay passed all 92 cases with zero unused
  cassette variants. It includes the six streaming cases for their third normal
  replay after the fixture fix; no cases were skipped in the full run.

No provider traffic was rerecorded. Pinned/latest dependencies remain agents and
OpenAI plugin 1.9.1/1.10.0, RTC 1.1.0/1.2.2, and OpenAI SDK 6.49.0. Earlier per-layer
checks above predate this rebase; the fresh combined-tip checks are listed here.
Logs use `/tmp/sdk864-rebase-*`.

Commands from the root, with `SDK864_NODE_BIN` as above:

```sh
# Build, source/test types, twelve-file unit selection, and provider matrix:
# same exact commands in the preceding stack section.

# Full paired snapshots, then the targeted streaming fixture repair:
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs --update livekit-instrumentation
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs --update livekit-instrumentation -t 'streaming-cascade order'

# Two consecutive focused normal replays, followed by the full audited replay.
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs livekit-instrumentation -t 'streaming-cascade order'
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs livekit-instrumentation -t 'streaming-cascade order'
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs --check-cassettes livekit-instrumentation

mise exec -- pnpm run lint
mise exec -- pnpm run fix:formatting
mise exec -- pnpm run formatting
git diff --check
```
