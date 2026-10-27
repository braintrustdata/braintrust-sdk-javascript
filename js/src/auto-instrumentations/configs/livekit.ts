import type { InstrumentationConfig } from "../orchestrion-js";
import { livekitChannels } from "../../instrumentation/providers/livekit-interceptors";

// Private lifecycle hooks: widen only after validating the supported release matrix.
const versionRange = ">=1.9.1 <1.10.0";
const targets: [
  keyof typeof livekitChannels,
  string,
  InstrumentationConfig["functionQuery"],
][] = [
  [
    "start",
    "voice/agent_session",
    { className: "AgentSession", methodName: "_startImpl" },
  ],
  [
    "close",
    "voice/agent_session",
    { className: "AgentSession", methodName: "closeImpl" },
  ],
  [
    "conversation",
    "voice/agent_session",
    { className: "AgentSession", methodName: "_conversationItemAdded" },
  ],
  [
    "activity",
    "voice/agent_activity",
    { className: "AgentActivity", methodName: "_startSessionImpl" },
  ],
  [
    "input",
    "voice/agent_activity",
    { className: "AgentActivity", methodName: "attachAudioInput" },
  ],
  [
    "pipeline",
    "voice/agent_activity",
    { className: "AgentActivity", methodName: "_pipelineReplyTaskImpl" },
  ],
  [
    "speechStart",
    "voice/agent_activity",
    { className: "AgentActivity", methodName: "onStartOfSpeech" },
  ],
  [
    "userTurn",
    "voice/agent_activity",
    { className: "AgentActivity", methodName: "onEndOfTurn" },
  ],
  [
    "userCompleted",
    "voice/agent_activity",
    { className: "AgentActivity", methodName: "userTurnCompleted" },
  ],
  [
    "stt",
    "voice/audio_recognition",
    { className: "AudioRecognition", methodName: "processSTTEvent" },
  ],
  // These factories create the async inference workers inside the scoped call.
  // Suppressing here leaves tool execution and other session work instrumented.
  ["inference", "voice/generation", { functionName: "performLLMInference" }],
  ["inference", "voice/generation", { functionName: "performTTSInference" }],
  // Observe the native tracer at its stable function boundary; preserve providers.
  [
    "startSpan",
    "telemetry/traces",
    { className: "DynamicTracer", methodName: "startSpan" },
  ],
  [
    "startActiveSpan",
    "telemetry/traces",
    { className: "DynamicTracer", methodName: "startActiveSpan" },
  ],
  [
    "startActiveSpanSync",
    "telemetry/traces",
    { className: "DynamicTracer", methodName: "startActiveSpanSync" },
  ],
];

export const livekitConfigs: InstrumentationConfig[] = targets.map(
  ([channel, file, functionQuery]) => ({
    channelName: livekitChannels[channel].channelName,
    module: {
      name: "@livekit/agents",
      versionRange,
      filePath: `dist/${file}.js`,
    },
    functionQuery,
  }),
);
