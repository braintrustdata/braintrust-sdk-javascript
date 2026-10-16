# Braintrust audio recordings

Record timestamped audio as progressive attachments, with Ogg/Opus compression by default or optional WAV output. Integrations supply audio frames, timing, and spans.

## Installation

```sh
npm install @braintrust/audio
```

Requires Node 20+. Installed separately from `braintrust`; enable recording through your integration.

## Recording API

Create a recording, supply audio frames, and finish when the session ends:

```ts
import { Attachment } from "braintrust";
import { createRecording } from "@braintrust/audio";

const recording = createRecording({
  span: sessionSpan,
  flush: () => logger.flush(),
  createAttachment: (options) => new Attachment(options),
  audioFormat: "ogg", // Default; use "wav" for uncompressed audio.
  options: { segmentDurationSeconds: 60 },
  snapshot: () => ({
    origin: sessionStartUnixMs,
    basis: "local_capture",
    source: (channel_index) => ({ channel_index }),
  }),
  turnSelections: () => [], // Add turn playback selections as shown below.
});

recording.record({
  pcm, // Int16Array; the recorder copies it.
  rate: 24000,
  channels: 1,
  channel: 0, // Caller; channel 1 is the agent.
  at: frameOffsetMs, // Milliseconds since sessionStartUnixMs.
});
// No more audio will arrive before this offset, on either channel.
recording.advance(confirmedThroughMs);

// Finish uploads and publish final recording states and selections.
await recording.finish();
```

## Configuration

Required inputs:

| Option             | Purpose                                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `span`             | Session span that receives recording metadata and audio attachments.                                                                                                                     |
| `createAttachment` | Creates an uploadable attachment; typically `(options) => new Attachment(options)`.                                                                                                      |
| `flush`            | Flushes trace updates; typically `() => logger.flush()`.                                                                                                                                 |
| `snapshot`         | Returns the current timing and source information: `{ origin, basis, source, metadata? }`. `origin` is the session start in Unix milliseconds; `source(channel)` describes each channel. |
| `turnSelections`   | Returns `{ span, intervals }` entries linking turns to their audio. Use `() => []` when no turn playback links are needed.                                                               |

Optional settings:

| Option                           | Default     | Meaning                                                                    |
| -------------------------------- | ----------- | -------------------------------------------------------------------------- |
| `audioFormat`                    | `"ogg"`     | `"ogg"` for compression; `"wav"` for uncompressed audio.                   |
| `options.segmentDurationSeconds` | `60`        | Target duration per file; buffer pressure can produce shorter files.       |
| `options.maxDurationSeconds`     | `1800`      | Stop capture at this session offset in seconds.                            |
| `options.maxBufferBytes`         | `33554432`  | Maximum retained PCM bytes per recording.                                  |
| `options.flushFraction`          | `0.5`       | Fraction of the buffer limit that triggers an earlier segment.             |
| `encoder`                        | `undefined` | Custom encoder `{ module: "..." }`; overrides `audioFormat` when supplied. |

## Turn playback

When reviewing a voice trace, you may want to follow a message, e.g. such as “Where is my order?”, and hear how it was spoken, without searching through the call recording. These selections describe which audio to play for that message.

Supply `turnSelections` to `createRecording()`: a callback that returns each turn’s span and when its audio occurred, in milliseconds from the start of the call. The recorder maps those timestamps onto the uploaded audio files, even when a turn crosses a file boundary, and writes `audio.selections` onto the turn’s span. These references can be used to play that turn’s audio.

For example, if the caller said “Where is my order?” from 1.2 to 2.6 seconds into the call:

```ts
// Inside the createRecording({ ... }) options:
turnSelections: () => [
  {
    span: userTurnSpan, // The span containing “Where is my order?”
    intervals: [
      {
        recording_span_id: sessionSpan.spanId, // Where the call audio is attached.
        recording_id: "call",
        channel_index: 0, // Caller audio.
        start_offset_ms: 1200,
        end_offset_ms: 2600,
      },
    ],
  },
];
```

When a turn or its timing changes, update what `turnSelections()` returns and call `recording.publishSelections()`. `finish()` also publishes the final selections. These selections associate recorded audio with turns; they do not control what gets recorded.

## Development

```sh
pnpm run build
pnpm run check:typings
pnpm test
pnpm run test:smoke
pnpm pack
```
