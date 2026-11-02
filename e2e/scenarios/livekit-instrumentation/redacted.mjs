// Runs the scenario inside a LiveKit job whose project enables redaction, as
// LiveKit Cloud sets it, so instrumentation must honor LiveKit's PII setting.
// The job is minimal: only the members LiveKit reads outside a real worker.
import { runWithJobContextAsync } from "@livekit/agents";

const job = {
  _redactionEnabled: true,
  job: { id: "job_redacted", agentName: "", enableRecording: false },
  room: { isConnected: false },
  simulationContext: () => undefined,
  _otelMetadata: () => ({}),
};
await runWithJobContextAsync(job, () => import("./scenario.mjs"));
