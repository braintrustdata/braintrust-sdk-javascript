import { createRequire } from "node:module";
import { mkdtemp, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import assert from "node:assert/strict";
import { initLogger, configureInstrumentation } from "braintrust";
import { scopedName } from "../../helpers/provider-runtime.mjs";
import { AudioFrame, dispose } from "@livekit/rtc-node";
const mode = process.env.LIVEKIT_AUTO_MODE;
if (mode === "defaults") {
  // Generic attachment opt-in must leave voice recording disabled by default.
  delete process.env.BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS;
  delete process.env.BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS;
}
if (mode !== "defaults")
  configureInstrumentation({
    integrations: {
      livekit:
        mode === "integration-off"
          ? false
          : {
              ...(mode === "env"
                ? {}
                : {
                    captureAudio: ["wav", "missing", "missing-wav"].includes(
                      mode,
                    ),
                  }),
              ...(["wav", "missing-wav"].includes(mode)
                ? { audioFormat: "wav" }
                : {}),
            },
    },
  });
const cwd = process.cwd();
const isolated = ["missing", "missing-wav", "defaults"].includes(mode)
  ? await mkdtemp(join(tmpdir(), "braintrust-no-audio-"))
  : undefined;
if (mode === "defaults") {
  // Model a pnpm app that installs LiveKit but not its OTel dependency directly.
  const entry = createRequire(import.meta.url).resolve(
    process.env.LIVEKIT_PACKAGE,
  );
  const scope = join(isolated, "node_modules", "@livekit");
  await mkdir(scope, { recursive: true });
  await symlink(dirname(dirname(entry)), join(scope, "agents"), "junction");
}
if (isolated) process.chdir(isolated);
const logger = initLogger({ projectName: scopedName("e2e-livekit-auto") });
const { voice, telemetry, initializeLogger } = await import(
  process.env.LIVEKIT_PACKAGE
);
initializeLogger({ pretty: false, level: "silent" });
let provider,
  observed = 0;
if (["redacted", "missing", "missing-wav", "unsampled"].includes(mode)) {
  const { NodeTracerProvider, AlwaysOffSampler } =
    await import("@opentelemetry/sdk-trace-node");
  const processors = [
    {
      onStart() {
        observed++;
      },
      onEnd() {},
      forceFlush: async () => {},
      shutdown: async () => {},
    },
  ];
  provider = new NodeTracerProvider({
    ...(mode === "unsampled" ? { sampler: new AlwaysOffSampler() } : {}),
    spanProcessors: [
      {
        onStart: (...args) => processors.forEach((p) => p.onStart(...args)),
        onEnd: (...args) => processors.forEach((p) => p.onEnd(...args)),
        forceFlush: async () => {},
        shutdown: async () => {},
      },
    ],
  });
  provider.register();
  telemetry.setTracerProvider(provider, {
    allowPii: mode !== "redacted",
    registerSpanProcessor: (p) => processors.unshift(p),
  });
}
class Output extends voice.AudioOutput {
  samples = 0;
  constructor() {
    super(24000);
  }
  async captureFrame(frame) {
    await super.captureFrame(frame);
    if (!this.samples) this.onPlaybackStarted(Date.now());
    this.samples += frame.samplesPerChannel;
  }
  flush() {
    super.flush();
    if (this.pendingPlayoutSegments)
      this.onPlaybackFinished({
        playbackPosition: this.samples / 24000,
        interrupted: false,
      });
    this.samples = 0;
  }
  clearBuffer() {}
}
const session = new voice.AgentSession();
const output = new Output();
session.output.audio = output;
const original = output.captureFrame;
try {
  await session.start({
    agent: new voice.Agent({ instructions: "Fictional order assistant" }),
    record: false,
  });
  if (!["wav", "env"].includes(mode))
    assert.equal(
      output.captureFrame,
      original,
      "disabled or unavailable recording must not wrap the sink",
    );
  const audio = new ReadableStream({
    start(c) {
      c.enqueue(
        new AudioFrame(new Int16Array(4800).fill(1234), 24000, 1, 4800),
      );
      c.close();
    },
  });
  await session.say("Your order arrives Friday.", { audio }).waitForPlayout();
  await session.close();
  await logger.flush();
  if (provider) {
    assert.equal(telemetry.tracer.getProvider(), provider);
    if (mode !== "unsampled")
      assert(observed > 0, "existing processor must still run");
  }
} finally {
  await session.close();
  await provider?.shutdown();
  await dispose();
  if (isolated) {
    process.chdir(cwd);
    await rm(isolated, { recursive: true });
  }
}
