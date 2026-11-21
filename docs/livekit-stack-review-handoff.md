# SDK-864: review the local stack

Review the four-layer local stack on `davidelner/sdk-864-typescript-livekit-cascade-cleanup`,
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
regressions; a discrete recognition request still owns an `stt` task. The
session-stream follow-up below supersedes that task shape for continuous STT.
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

## Continuous recognition follow-up (2026-11-20)

Review the additional local commit after `bc4f66b7` on layer 4. The other three
branch endpoints are unchanged. The production sample exposed a continuous
recognition connection represented as a call-long `stt` task and model child.
It now follows the audio schema's session model operation contract:

```text
session : task
├─ livekit.stt.stream : llm       audio.scope=session; actual connection lifetime
├─ user_turn : task
│  └─ transcript_received : task
└─ agent_turn : task
   ├─ llm_response : task
   │  └─ Chat Completion : llm
   └─ tts : task
      └─ openai.audio.speech.create : llm
```

`livekit.stt.stream` mirrors LiveKit's `STT.stream()`/`SpeechStream`; the demo
does not use LiveKit's separate `RealtimeModel` API. OpenAI's stock stream uses
LiveKit's direct WebSocket, so it remains LiveKit-owned even when OpenAI SDK
instrumentation is disabled. Discrete `recognize()` calls retain their existing
`stt` task and ownership rules. No audio compression or native diagnostic-span
filtering is included in this follow-up.

Review the new regressions for a stream started during an existing turn, receipt
membership across two turns, root payload isolation, connection failure,
concurrent privacy contexts, retry-local output/usage, cancellation and session
shutdown. The recorded streaming conversation now also runs with OpenAI SDK
instrumentation disabled in automatic, manual and combined modes for both
dependency versions. Its direct-WebSocket model remains present, while SDK chat
children disappear. See the dated follow-up in `livekit-cascade-cleanup-review.md`
for fresh commands and results.

Fresh follow-up checks: 445 unit/regression tests; build; source/test typings;
root lint/format; 98-case snapshot regeneration; two 14-case normal streaming/
diarization replays; then a full normal 98-case replay with no skipped tests and
zero unused cassette variants. The changed cases passed three normal replays
after snapshot regeneration. No provider traffic was rerecorded.

## 2026-11-20 follow-up: independent capture and encoding

Review the changes after `b950b046` on layer 4. Layers 1–3 are unchanged.

- `integrations.livekit.audio: false` and `integrations.openai.audio: false`
  independently disable audio capture, preserving spans, text and metrics. The
  switch is local to the integration; directional environment permissions and
  inherited logger/privacy restrictions remain upper bounds.
- Continuous `livekit.stt.stream` no longer copies or attaches audio. Its session
  model span and transcripts/usage remain. Discrete recognition and synthesis
  retain operation-level captures.
- Supported PCM and PCM WAV model captures use Ogg/Opus by default with the audio
  package available. Existing compressed media stays unchanged; explicit PCM,
  unsupported formats, unavailable codecs and encoder failures retain original
  bytes. Source and stored format metadata distinguish the compressed copy.
- Encoding runs during asynchronous export after customization/privacy filtering,
  with a second privacy check after encoding. Application audio reads are not
  delayed by codec work. Each clip uses a fresh stack and libopus handle; separate
  buffers, options, timelines and output files are verified under concurrency.

Key files: `js/src/audio-attachments.ts` (deferred per-attachment encoding),
`js/src/instrumentation/providers/openai-audio.ts` (provider capture policy),
`openai-media.ts`, `livekit-plugin.ts`, `instrumentation/config.ts`, and the
small export integration in `logger/core.ts`. Generic wrapping hooks and client
ownership classification are unchanged.

Review the encoding/export boundary for deferred privacy, original buffer/stream
semantics, file metadata, and multi-copy SDK behavior. The real-codec test overlaps
stereo 48 kHz and mono 24 kHz encoders with different bitrates and a failing third
encoder; both successful packet sequences equal isolated reference encodes.

The spec clarification and supported-format limits are described in
`livekit-cascade-cleanup-review.md`, section "2026-11-20". The bundled spec is
unchanged; compression of provider snapshots needs an explicit allowance in the
attachments contract (session-segment compression is already allowed).

Tested dependencies: LiveKit agents/OpenAI plugin 1.9.1 and 1.10.0; RTC 1.1.0 and
1.2.2; OpenAI 6.49.0 in LiveKit. Standalone provider matrix: OpenAI 4.104.0
(pinned/latest aliases), 5.11.0/5.23.2, 6.25.0/6.49.0, 7.30.0/7.32.0.
Audio package 0.1.0 with `@audio/encode-opus` 1.3.1; Node 26.8.2.

Additional legacy-test audit: `js/src/wrappers/test_oai_attachments.test.ts`
fails four tests and reports three unhandled assertion rejections, identically
on the unchanged `b950b046` baseline in an isolated checkout. Those tests expect
provider arguments to be replaced with Braintrust Attachments and monkeypatch
APIPromise methods with plain promises. They are not changed or counted as passing.
Logs: `/tmp/sdk864-audio-baseline-tests.log` and
`/tmp/sdk864-audio-additional-unit.log`.

### Validation commands and results for the audio follow-up

Run from the SDK repository root. The explicit Node path avoids the older Node
selected by nested `pnpm exec` in this environment.

```sh
SDK864_NODE_BIN=/Users/david/.local/share/mise/installs/node/26.8.2/bin
mise install
mise exec -- pnpm exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vite-plus/bin/vp run -r build
mise exec -- pnpm --dir js run check:typings
mise exec -- pnpm --dir js exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/typescript/bin/tsc --noEmit
mise exec -- pnpm --dir js exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json
mise exec -- pnpm --dir integrations/audio run check:typings
mise exec -- pnpm --dir js exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vitest/vitest.mjs run src/audio-attachments.test.ts src/audio-compression.test.ts src/audio-middleware.test.ts src/audio-session-recorder.test.ts src/instrumentation/providers/openai-media.test.ts src/instrumentation/providers/livekit-plugin.test.ts src/wrappers/livekit.test.ts src/instrumentation/providers/openai-instrumentation.test.ts src/wrappers/attachment-utils.test.ts src/span-customizer.test.ts src/logger/lifecycle.test.ts src/attachment-capture.test.ts src/logger-json-attachment.test.ts
mise exec -- pnpm --dir integrations/audio exec env PATH="$SDK864_NODE_BIN:$PATH" node ../../node_modules/vite-plus/bin/vp test run
mise exec -- pnpm exec env PATH="$SDK864_NODE_BIN:$PATH" node ./node_modules/vite-plus/bin/vp lint .
mise exec -- pnpm run fix:formatting
mise exec -- pnpm run formatting
git diff --check
```

Results: build and SDK/audio type checks passed; **470 SDK tests** and **48 audio
package tests** passed. Lint exited successfully with warnings; formatting and
whitespace checks passed. A subsequent narrow test confirmed continuous STT never
reads a submitted frame's audio data for attachment capture.

```sh
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs --update livekit-instrumentation
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs --check-cassettes livekit-instrumentation
# Run the following normal replay twice, sequentially:
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs livekit-instrumentation -t 'independent audio| auto order conversation$| auto (direct client|SDK client) discrete recognition$| auto streaming-cascade order conversation$|diarized two-caller|interrupted order answer|recovered order answer'
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs --update openai-instrumentation
# Run normal provider replay three times, sequentially:
mise exec -- pnpm --dir e2e exec env PATH="$SDK864_NODE_BIN:$PATH" node ./scripts/run-e2e-tests.mjs --check-cassettes openai-instrumentation
```

The LiveKit snapshot update passed **114 cases**. After adding the four explicit
encoding-override cases, full normal replay passed **118 cases**, no skips, zero
unused cassette variants. The OpenAI snapshot update passed **745 cases**;
three normal audited replays and one additional final-build replay each passed
**745 cases**, no skips, zero unused cassette variants. All traffic was replayed
from existing recordings; no provider cassette was changed or fabricated.

A structural audit of all **30 changed JSON trees** (14 LiveKit, 16 OpenAI)
found only the intended audio-representation changes and continuous-STT attachment
removal. Span structure, text, metrics, relationships, and other metadata remained
identical. Paired text snapshots were regenerated by the runner. Example: the
pinned order response changed from 213,600 PCM bytes to 36,638 Ogg/Opus bytes;
its provider request still asks for PCM. Logs are `/tmp/sdk864-audio-*.log`.

Both final focused LiveKit normal replays passed **34 cases** each (the other
84 cases were excluded by the explicit name filter). These cover every new
capture/configuration case and each changed LiveKit snapshot. The full
118-case replay above had no filtered or skipped cases.

## Review fix: preserve export record identity after audio initialization

Review the follow-up to `c166f48f`. The reviewer reproduced a real regression:
initializing one encodable audio attachment enabled a traversal that returned
clones even for unrelated records. This lost the WeakSet identity marking stripped
customizer failures, breaking ordered merging, masking protections, and retries.

`encodeAudioAttachments()` now returns the original record whenever no attachment
was replaced, including codec failures and unsupported formats. Records with
successfully encoded attachments still use the existing copy and metadata path.
The customizer suite now initializes audio bookkeeping before each export test;
attachment tests also assert unchanged-record identity.

Before the fix, 13 existing customizer tests and four attachment identity checks
failed. After the fix, **148 tests across six files passed**, including all 52
customizer tests and the ordered HTTP export/retry regression. SDK source/test
typings and targeted lint passed. No provider behavior, snapshots, or cassettes
changed. The provider matrices and production trace were not rerun for this
three-line runtime fix; their earlier results apply to `c166f48f`.

```sh
mise exec -- pnpm --dir js exec env PATH="/Users/david/.local/share/mise/installs/node/26.8.2/bin:$PATH" node ./node_modules/vitest/vitest.mjs run src/span-customizer.test.ts src/audio-attachments.test.ts src/instrumentation/providers/openai-media.test.ts src/logger/lifecycle.test.ts src/logger-json-attachment.test.ts src/attachment-capture.test.ts
mise exec -- pnpm --dir js run check:typings
mise exec -- pnpm exec env PATH="/Users/david/.local/share/mise/installs/node/26.8.2/bin:$PATH" node ./node_modules/vite-plus/bin/vp lint js/src/audio-attachments.ts js/src/audio-attachments.test.ts js/src/span-customizer.test.ts
mise exec -- pnpm run fix:formatting
git diff --check
```

Logs: `/tmp/sdk864-export-identity-{before,after,types,lint}.log`.
