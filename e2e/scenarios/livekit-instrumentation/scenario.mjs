import assert from "node:assert/strict";
import { initLogger, configureInstrumentation, setFetch } from "braintrust";
import { getTestRunId, scopedName } from "../../helpers/provider-runtime.mjs";
import { LiveKitSpanProcessor, wrapLiveKitSession } from "braintrust/livekit";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { AudioFrame, dispose } from "@livekit/rtc-node";
const automatic = process.env.LIVEKIT_AUTOMATIC === "1";
if (automatic)
  configureInstrumentation({
    integrations: { livekit: { captureAudio: true, captureContent: true } },
  });
const { voice, llm, telemetry, initializeLogger } = await import(
  process.env.LIVEKIT_PACKAGE
);
initializeLogger({ pretty: false, level: "silent" });
const completedUploads = [];
if (process.env.LIVEKIT_SEGMENTS === "1") {
  setFetch(async (input, init) => {
    const response = await fetch(input, init);
    if (
      new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      ).pathname === "/attachment/status" &&
      response.ok
    ) {
      const body = JSON.parse(init.body);
      if (body.status?.upload_status === "done")
        completedUploads.push({
          key: body.key,
          playedSamples: output.playedSamples,
        });
    }
    return response;
  });
}
const logger = initLogger({ projectName: scopedName("e2e-livekit") });
class ScenarioProcessor extends LiveKitSpanProcessor {
  onStart(span) {
    super.onStart(span);
    this.rows.get(span.spanContext().spanId)?.span.log({
      metadata: {
        scenario: "livekit-instrumentation",
        testRunId: getTestRunId(),
      },
    });
  }
}
const processor = automatic
  ? undefined
  : new ScenarioProcessor({
      logger,
      captureContent: true,
      audioFormat: "wav",
      ...(process.env.LIVEKIT_SEGMENTS === "1"
        ? {
            recording: {
              segmentDurationSeconds: 0.2,
              encoder: (await import("@braintrust/audio")).oggOpus(),
            },
          }
        : {}),
      captureAgentAudio: process.env.LIVEKIT_AUDIO === "1",
      captureUserAudio:
        process.env.LIVEKIT_REALTIME === "1" ||
        process.env.LIVEKIT_STREAMING_STT === "1",
    });
const provider = automatic
  ? undefined
  : new NodeTracerProvider({ spanProcessors: [processor] });
if (provider) {
  // LiveKit registers its own PII processor before ours.
  provider.registerSpanProcessor = (p) =>
    provider._activeSpanProcessor._spanProcessors.unshift(p);
  provider.register();
  telemetry.setTracerProvider(provider, {
    allowPii: true,
    registerSpanProcessor: (p) => provider.registerSpanProcessor(p),
  });
}
const providerMode = process.env.LIVEKIT_PROVIDER === "1";
class Output extends voice.AudioOutput {
  samples = 0;
  playedSamples = 0;
  interrupted = false;
  didInterrupt = false;
  startedAt = 0;
  constructor() {
    super(24000);
  }
  async captureFrame(frame) {
    await super.captureFrame(frame);
    if (!this.samples) {
      this.interrupted = false;
      if (process.env.LIVEKIT_PLAYBACK_START_DELAY_MS)
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Number(process.env.LIVEKIT_PLAYBACK_START_DELAY_MS),
          ),
        );
      this.startedAt = Date.now();
      this.onPlaybackStarted(this.startedAt);
    }
    const duration = (frame.samplesPerChannel / frame.sampleRate) * 1000;
    await new Promise((resolve) => setTimeout(resolve, duration));
    this.samples += frame.samplesPerChannel;
    this.playedSamples += frame.samplesPerChannel;
    if (process.env.LIVEKIT_SEGMENTS === "1")
      this.onPlaybackProgressed({
        startedAt: this.startedAt + this.samples / 24 - duration,
        offset: this.samples / 24 - duration,
        duration,
      });
    if (
      process.env.LIVEKIT_INTERRUPT === "1" &&
      this.samples >= 4800 &&
      !this.didInterrupt
    ) {
      this.didInterrupt = true;
      this.clearBuffer();
      void session.interrupt({ force: true }).await;
    }
  }
  flush() {
    super.flush();
    if (!this.interrupted && process.env.LIVEKIT_SEGMENTS !== "1")
      this.onPlaybackProgressed({
        startedAt: this.startedAt,
        offset: 0,
        duration: this.samples / 24,
      });
    if (this.pendingPlayoutSegments > 0)
      this.onPlaybackFinished({
        playbackPosition: this.samples / 24000,
        interrupted: this.interrupted,
      });
    this.samples = 0;
  }
  clearBuffer() {
    this.onPlaybackProgressed({
      startedAt: this.startedAt,
      offset: 0,
      duration: this.samples / 24,
    });
    this.interrupted = true;
    if (this.pendingPlayoutSegments > 0)
      this.onPlaybackFinished({
        playbackPosition: this.samples / 24000,
        interrupted: true,
      });
    this.abandonOpenSegment();
  }
}
const options = {};
const realtimeMode = process.env.LIVEKIT_REALTIME === "1";
const duplexMode = process.env.LIVEKIT_DUPLEX === "1";
const overlap = process.env.LIVEKIT_OVERLAP === "1";
const halfCascade = process.env.LIVEKIT_HALF_CASCADE === "1";
const streamingStt = process.env.LIVEKIT_STREAMING_STT === "1";
const audioInput = realtimeMode || streamingStt;
// The synthetic overlap fixture has no acoustic echo to suppress.
if (overlap) options.aecWarmupDuration = null;
let ws;
if (providerMode) {
  const { LLM, TTS } = await import("@livekit/agents-plugin-openai");
  options.llm = new LLM({
    model: "gpt-4.1-nano",
    temperature: 0,
    baseURL: process.env.OPENAI_BASE_URL,
  });
  options.tts = new TTS({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    baseURL: process.env.OPENAI_BASE_URL,
  });
}
if (audioInput) {
  const { websocketCassette } = await import("./websocket-cassette.mjs");
  ws = await websocketCassette(
    process.env.LIVEKIT_WS_PATH,
    process.env.BRAINTRUST_E2E_CASSETTE_MODE === "record",
    {
      concurrentAudio: duplexMode,
      burst: process.env.LIVEKIT_WS_BURST === "1",
    },
  );
  const { realtime, STT } = await import("@livekit/agents-plugin-openai");
  if (streamingStt) {
    options.stt = new STT({
      model: "gpt-4o-mini-transcribe",
      useRealtime: true,
      baseURL: ws.baseURL,
    });
    options.turnDetection = "manual";
  } else {
    options.llm = duplexMode
      ? new realtime.GPTLiveModel({ model: "gpt-live-1", baseURL: ws.baseURL })
      : new realtime.RealtimeModel({
          model: "gpt-realtime-mini",
          ...(halfCascade ? { modalities: ["text"] } : {}),
          baseURL: ws.baseURL,
          turnDetection: { type: "server_vad", silence_duration_ms: 500 },
        });
    if (!halfCascade) delete options.tts;
  }
}
const session = new voice.AgentSession(options);
if (process.env.LIVEKIT_WRAP === "1") {
  assert.equal(wrapLiveKitSession(wrapLiveKitSession(session)), session);
}
let inputController;
if (audioInput) {
  class Input extends voice.AudioInput {
    source = new ReadableStream({
      start(controller) {
        inputController = controller;
      },
    });
    get stream() {
      return this.source;
    }
    async close() {
      try {
        inputController.close();
      } catch {}
    }
  }
  session.input.audio = new Input();
}
const output = new Output();
const committed = [];
let callerTranscript = "";
session.on("user_input_transcribed", (ev) => {
  if (ev.isFinal) callerTranscript += ev.transcript;
});
session.on("conversation_item_added", (ev) => committed.push(ev.item));
session.output.audio = output;
const original = output.captureFrame;
try {
  await session.start({
    agent: new voice.Agent({
      instructions: providerMode
        ? "You help customers check orders. Always call lookup_order when an order number is supplied. Answer with one short sentence giving the delivery day."
        : "Fixture playback",
      tools: providerMode
        ? {
            lookup_order: llm.tool({
              description: "Look up an order delivery status.",
              parameters: (await import("zod")).z.object({
                order_id: (await import("zod")).z.string(),
              }),
              execute: async ({ order_id }) => ({
                order_id,
                status: "in_transit",
                delivery: "Friday",
              }),
            }),
          }
        : {},
    }),
    record: false,
  });
  if (process.env.LIVEKIT_AUDIO !== "1")
    assert.equal(output.captureFrame, original);
  const audio = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new AudioFrame(new Int16Array(480).fill(1234), 24000, 1, 480),
      );
      controller.close();
    },
  });
  if (providerMode) {
    const feedCaller = async (
      fixture = "order",
      silenceBytes = duplexMode ? 960000 : 96000,
    ) => {
      const { readFile } = await import("node:fs/promises");
      const bytes = Buffer.concat([
        await readFile(
          new URL(`./fixtures/${fixture}-24khz.pcm`, import.meta.url),
        ),
        Buffer.alloc(silenceBytes),
      ]);
      for (let at = 0; at < bytes.length; at += 960) {
        const pcm = new Int16Array(480);
        for (let i = 0; i < 480 && at + i * 2 + 1 < bytes.length; i++)
          pcm[i] = bytes.readInt16LE(at + i * 2);
        inputController.enqueue(new AudioFrame(pcm, 24000, 1, 480));
        // Duplex models process a continuous microphone stream, including silence.
        if (duplexMode || streamingStt)
          await new Promise((resolve) => setTimeout(resolve, 20));
        // Buffered fixture input preserves the sample clock without wall-clock jitter.
      }
      if (streamingStt) {
        const deadline = Date.now() + 15000;
        while (!/order/i.test(callerTranscript)) {
          if (Date.now() > deadline) throw new Error("No final STT transcript");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        session.commitUserTurn();
      }
    };
    if (overlap) {
      await feedCaller("order", 96000);
      const deadline = Date.now() + 30000;
      while (output.samples < 4800) {
        if (Date.now() > deadline)
          throw new Error("No playback before caller overlap");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await feedCaller("followup");
      assert.match(
        committed
          .filter((item) => item.role === "user")
          .map((item) => item.textContent)
          .join(""),
        /detail/i,
      );
    } else if (audioInput) await feedCaller();
    else
      await session
        .generateReply({ userInput: "Hi, could you check order 1042 for me?" })
        .waitForPlayout();
    const deadline = Date.now() + 30000;
    while (
      !committed.some(
        (item) =>
          item.role === "assistant" &&
          (process.env.LIVEKIT_INTERRUPT === "1"
            ? item.interrupted
            : /Friday/i.test(item.textContent ?? "")),
      )
    ) {
      if (Date.now() > deadline) throw new Error("No committed order answer");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await session.activity?.currentSpeech?.waitForPlayout();
    if (process.env.LIVEKIT_RECOVER === "1") {
      await session
        .generateReply({ userInput: "Sorry, please repeat the delivery day." })
        .waitForPlayout();
      assert(
        committed.at(-1)?.role === "assistant" && !committed.at(-1).interrupted,
      );
      assert.match(committed.at(-1).textContent, /Friday/i);
    }
    if (process.env.LIVEKIT_RECONNECT === "1") {
      let reconnected = false;
      session.activity.realtimeSession.once("session_reconnected", () => {
        reconnected = true;
      });
      ws.disconnect();
      const deadline = Date.now() + 30000;
      while (!reconnected) {
        if (Date.now() > deadline) throw new Error("No native reconnect event");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(ws.connections, 2);
      const before = committed.length;
      await feedCaller();
      while (
        !committed
          .slice(before)
          .some(
            (item) =>
              item.role === "assistant" &&
              /Friday/i.test(item.textContent ?? ""),
          )
      ) {
        if (Date.now() > deadline) throw new Error("No reply after reconnect");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await session.activity?.currentSpeech?.waitForPlayout();
    }
  } else await session.say("Fixture playback", { audio }).waitForPlayout();
  if (process.env.LIVEKIT_SEGMENTS === "1") {
    console.log(
      JSON.stringify({
        playedDurationMs: output.playedSamples / 24,
        completedUploads,
      }),
    );
  }
  if (audioInput) await session.input.audio?.close();
  await session.close();
  await provider?.forceFlush();
  await logger.flush();
} finally {
  if (audioInput) await session.input.audio?.close();
  await session.close();
  await provider?.shutdown();
  await dispose();
  await ws?.close();
}
