# SDK-864: review the local stack

Review the four local commits on `davidelner/sdk-864-typescript-livekit-cascade-cleanup`,
starting after `c26ce3c7cc2d084441505800f5fcb7c1e205be4d` (latest fetched `main`,
2026-11-19). Nothing has been pushed; no PR has been opened. The original pre-stack implementation is preserved in
local safety stash `ebabaf72` (including its originally untracked files).

## Local commit endpoints

| Layer | Commit     | Local branch                                            |
| ----- | ---------- | ------------------------------------------------------- |
| 1     | `bf008292` | `davidelner/sdk-864-1-provider-policy`                  |
| 2     | `499e13b3` | `davidelner/sdk-864-2-livekit-hooks`                    |
| 3     | `8cc74fc9` | `davidelner/sdk-864-3-client-ownership`                 |
| 4     | `HEAD`     | `davidelner/sdk-864-typescript-livekit-cascade-cleanup` |

Review each endpoint against the preceding endpoint. Layer 4 depends on layer 3's
ownership result; it is not an independent ownership heuristic.

## Boundaries and dependency

1. **Provider privacy policy:** inherited asynchronous/export policy, independent
   voice capture consent, logger opt-outs, and provider-hook regressions. OpenAI
   e2e fixtures opt into both voice directions here. Existing model routing stays.
2. **Public events and shared hooks:** conversation observation uses public
   `AgentSession.emit`; shared mechanical service, worker, and producer queue
   hooks preserve errors, return values and consumer behavior. Span routing stays.
3. **Public constructor ownership:** the internal transformer observes OpenAI
   adapter construction; manual users also wrap the plugin module before creating
   adapters. Ownership records are shared by both entrypoints and do not activate
   provider tracing. The teammate proposal is in this layer.
4. **Audio task/model contract:** consumes ownership, removes suppression, creates
   fallback children only for uncovered clients, scopes actual recognition, emits
   receipts where only receipt is observed, and handles attempt-local output,
   usage, errors, cancellation and shutdown. Includes complete trace snapshots.

STT operation lifetime and model finalization remain together in layer 4 because
splitting their shared cleanup would introduce temporary competing lifecycle code.
Each layer includes its directly applicable tests. There is no coverage-only PR.

## Review priorities

Please repeat the three P2 probes against real LiveKit 1.9.1 and 1.10.0 classes:

- Inject a non-SDK client into stock STT through its public constructor options.
  An executed failing recognition must produce `stt -> livekit.stt`. Actual SDK
  clients must instead defer to the provider integration, including wrapper-only
  behavior when that integration is disabled. Check both entrypoints and all
  three service kinds.
- Delay consumption until an initial attempt queues FIRST/usage then fails and a
  retry queues SECOND/usage then succeeds. Each model child must retain only its
  originating attempt's data. Observation is at producer enqueue, before the
  shared output queue can mix attempts. Consumer reads are not advanced.
- Supply cache-read, cache-creation, reasoning usage and served tier. Check the
  canonical metrics/metadata, omission when unknown, normalization of tier, and
  no usage/tier leakage across retries. Wrappers retain only their own timing.

Also review constructor transform semantics/static factories and the extra manual
wrapping call. Method-source inspection and private client-field inspection are
absent. Protected worker/queue and native lifecycle bridges remain qualified to
supported versions; see `livekit-public-interface-audit.md` for their rationale.

Check privacy through actual provider hooks: environment/job/session redaction,
late export after cleanup, provider errors, concurrent sessions, directional voice
flags, explicit logger opt-outs, and unaffected image/chat attachment behavior.

## Validation before the rebase

- Layer 1: 343 focused tests; source/test typings; workspace build; root lint;
  38-case LiveKit replay three times after paired snapshot regeneration;
  787-case OpenAI/audio provider matrix three times.
- Layer 2: 108 focused tests; typings/build; affected-file lint; full 38-case replay.
- Layer 3: 126 focused tests; typings/build; affected-file lint; full 38-case replay.
- Final tip: 399 focused tests in twelve files; typings/build; root lint;
  full 82-case LiveKit replay; 787-case provider matrix.
- Every normal LiveKit replay reported zero unused cassette variants. Before the
  rebase, the final implementation/scenario/proposal files matched the backup byte for
  byte; the additional files are the two standalone boundary tests and this
  handoff. The review notes add the stack and fresh results.

Layer 1's intermediate paired snapshots changed only caller-context fields from
adding the policy scope; a structural comparison of all 14 JSON trees confirmed
no other field changes. They were regenerated through the runner, then replayed
three times. Final paired snapshots retain the complete audio schema contract.
See the review notes for exact commands and versions. No tests were skipped in
these full replays. Pre-commit hooks scan staged files for secrets and formatting.

## Limits to keep visible

Framework-driven VAD segmentation for discrete STT is not qualified; provider
recordings use real `recognize()` with a fixed valid recording. The controlled
transport failures/retry probes are real-framework regressions, not live-provider
verification. Real-provider cassettes were recorded earlier; this split does not
fabricate or rerecord responses.

Minified export aliases have transformer runtime coverage, not a fully minified
LiveKit bundle. Other LiveKit provider plugins, arbitrary operation-replacing
subclasses, adapters constructed before observation, and full CJS auto-hook parity
are not qualified. The Anthropic exposed-client check is a focused hook test, not
qualification of a LiveKit Anthropic plugin.

The ad hoc whole e2e-tree type check has unrelated mixed-runtime/scenario errors;
it is not reported as passing. The required SDK source/test typing checks pass.
Detailed commands, versions and historical versus fresh results are recorded in
`livekit-cascade-cleanup-review.md`.

## Pi precedent and latest-main integration (2026-11-19)

Pi's manual wrapper and automatic instrumentation share invocation hooks and
observe public operation surfaces. LiveKit follows that pattern. Pi has a public
stream callback that can be patched at invocation; LiveKit's OpenAI adapters
retain constructor clients privately, so construction observation is still
needed. Keep the public constructor approach, as accepted after teammate review.
Pi's suppression of nested provider tracing does not apply to this task's
explicit SDK-client ownership contract.

The rebase retains main's end-of-utterance lifecycle and audio schema 3.1.0.
Receipt-only callbacks remain `transcript_received`, including the new EOU
regressions; an observed recognition service operation still owns an `stt` task.
The streaming conversation now runs in automatic, manual, and combined modes,
alongside main's six recognition-lifecycle cases.

The combined-mode scenario applies both LiveKit entrypoints while choosing one
provider instrumentation path (automatic OpenAI). Applying `wrapOpenAI` over
OpenAI's automatic hooks produced extra empty chat spans during the streaming
probe; provider-wrapper deduplication is a separate follow-up, outside LiveKit
ownership. The streaming scenario now explicitly asserts one model child per
LLM task and reported usage on each child, rather than relying only on snapshots.

Fresh rebased-tip results: 442 focused tests; SDK source/test types; workspace
build; root lint/format; 787 provider cases; and a full 92-case normal LiveKit
replay with zero unused cassette variants. The six adjusted streaming cases
passed two focused normal replays followed by that full replay, after runner
regeneration of both snapshot files. No provider cassettes were rerecorded.
Pinned/latest versions remain agents/plugin 1.9.1/1.10.0, RTC 1.1.0/1.2.2 and
OpenAI 6.49.0. Exact commands and the fixture reproduction are in the review
notes under “Rebase checks (2026-11-19)”.
