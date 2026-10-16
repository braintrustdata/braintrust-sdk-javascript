import type { InstrumentationConfig } from "../orchestrion-js";
import { livekitChannels } from "../../instrumentation/plugins/livekit-channels";
// Private lifecycle hooks: widen only after validating the supported release matrix.
export const livekitConfigs: InstrumentationConfig[] = [
  [
    "pipeline",
    "agent_activity",
    "AgentActivity",
    "_pipelineReplyTaskImpl",
    "Async",
  ],
  [
    "conversation",
    "agent_session",
    "AgentSession",
    "_conversationItemAdded",
    "Sync",
  ],
  [
    "userCompleted",
    "agent_activity",
    "AgentActivity",
    "userTurnCompleted",
    "Async",
  ],
  [
    "realtime",
    "agent_activity",
    "AgentActivity",
    "_realtimeGenerationTaskImpl",
    "Async",
  ],
  ["start", "agent_session", "AgentSession", "_startImpl", "Async"],
  ["close", "agent_session", "AgentSession", "closeImpl", "Async"],
  ["output", "agent_session", "AgentSession", "onAudioOutputChanged", "Sync"],
  ["input", "agent_activity", "AgentActivity", "attachAudioInput", "Sync"],
  ["activity", "agent_activity", "AgentActivity", "_startSessionImpl", "Async"],
  ["userTurn", "agent_activity", "AgentActivity", "onEndOfTurn", "Async"],
].map(([channel, file, className, methodName, kind]) => ({
  channelName:
    livekitChannels[channel as keyof typeof livekitChannels].channelName,
  module: {
    name: "@livekit/agents",
    versionRange: ">=1.9.1 <1.10.0",
    filePath: `dist/voice/${file}.js`,
  },
  functionQuery: { className, methodName, kind: kind as "Async" | "Sync" },
}));

// These factories create the async inference workers inside the scoped call.
// Suppressing here leaves tool execution and other session work instrumented.
for (const functionName of ["performLLMInference", "performTTSInference"]) {
  livekitConfigs.push({
    channelName: livekitChannels.inference.channelName,
    module: {
      name: "@livekit/agents",
      versionRange: ">=1.9.1 <1.10.0",
      filePath: "dist/voice/generation.js",
    },
    functionQuery: { functionName, kind: "Sync" },
  });
}

// Observe the native tracer at its stable function boundary; preserve providers.
for (const [methodName, kind] of [
  ["startSpan", "Sync"],
  ["startActiveSpan", "Async"],
  ["startActiveSpanSync", "Sync"],
] as const) {
  livekitConfigs.push({
    channelName: livekitChannels.trace.channelName,
    module: {
      name: "@livekit/agents",
      versionRange: ">=1.9.1 <1.10.0",
      filePath: "dist/telemetry/traces.js",
    },
    functionQuery: { className: "DynamicTracer", methodName, kind },
  });
}
livekitConfigs.push({
  channelName: livekitChannels.provider.channelName,
  module: {
    name: "@livekit/agents",
    versionRange: ">=1.9.1 <1.10.0",
    filePath: "dist/telemetry/traces.js",
  },
  functionQuery: { functionName: "setTracerProvider", kind: "Sync" },
});
