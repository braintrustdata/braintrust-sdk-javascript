import { configureInstrumentation } from "braintrust/instrumentation";
configureInstrumentation({
  ...(process.env.LIVEKIT_SEGMENTS === "1"
    ? { streamingAttachmentBufferBytes: 19200 } // 200 ms of 24 kHz stereo s16le.
    : {}),
  integrations: {
    livekit:
      process.env.LIVEKIT_INTEGRATION === "off"
        ? false
        : process.env.LIVEKIT_AUDIO
          ? { audio: JSON.parse(process.env.LIVEKIT_AUDIO) }
          : true,
  },
  spanCustomizers: [
    {
      onSpanExport(data) {
        data.metadata = {
          ...data.metadata,
          scenario: "livekit-instrumentation",
          testRunId: process.env.BRAINTRUST_E2E_RUN_ID,
        };
        return data;
      },
    },
  ],
});
