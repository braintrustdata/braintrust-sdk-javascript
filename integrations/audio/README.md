# @braintrust/audio

Provides audio plugins for audio instrumentation recordings, such as compression and containers.

## Installation

```sh
npm install @braintrust/audio
```

Requires Node 20+ and `braintrust` 3.41+.

When recording is activated with `BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS` or `BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS`, the SDK will automatically use this package if available.

## Configuration

Integrations that support audio recording may offer the following configuration options:

```ts
import { configureInstrumentation } from "braintrust/instrumentation";

configureInstrumentation({
  integrations: {
    livekit: {
      audio: {
        codec: { name: "opus", options: { bitrate: 32_000 } },
        container: { name: "ogg" },
      },
    },
  },
});
```

| Setting                     | Default   | Meaning                                                      |
| --------------------------- | --------- | ------------------------------------------------------------ |
| `codec.name`                | `"opus"`  | `"opus"`, or `"pcm"` to record uncompressed audio.           |
| `codec.options.bitrate`     | `64000`   | Target bitrate in whole bits per second, from 500 to 512000. |
| `codec.options.complexity`  | `5`       | Encoder effort, from 0 (fastest) to 10.                      |
| `codec.options.application` | `"audio"` | Encoder tuning: `"audio"`, `"voip"`, or `"lowdelay"`.        |
| `container.name`            | `"ogg"`   | The file format.                                             |

If the package is missing or a setting is unsupported, recordings upload as raw PCM and a warning explains why.

## Bundled apps

Braintrust loads this package from `node_modules` at runtime. If you deploy a bundle without `node_modules`, import the package in your app so your bundler includes it:

```ts
import "@braintrust/audio";
```

## Performance

Encoding runs on the main thread in 20 ms frames and yields to the event loop after each second of audio.
